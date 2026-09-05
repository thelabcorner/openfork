/**
 * Small, allocation-conscious replay window for volatile event transports.
 *
 * The buffer deliberately stores event objects by reference. Event payloads
 * are immutable at the EventV2 boundary and retaining serialized strings here
 * would duplicate the work done by each transport. A caller can choose its
 * own filter when reading the window.
 */
export type EventReplayFrame<T> = {
  readonly sequence: number
  readonly event: T
}

type StoredReplayFrame<T> = EventReplayFrame<T> & { readonly size: number }

export type EventReplayResult<T> =
  | {
      readonly kind: "ok"
      readonly frames: readonly EventReplayFrame<T>[]
      readonly latest: number
      readonly oldest?: number
    }
  | {
      readonly kind: "gap"
      readonly latest: number
      readonly oldest: number
      readonly requested: number
    }

const DEFAULT_CAPACITY = 4096
const DEFAULT_MAX_BYTES = Number.POSITIVE_INFINITY
const eventSizeCache = new WeakMap<object, number>()

/** Parse a Last-Event-ID value without accepting accidental overflow or junk. */
export function parseEventSequence(value: string | undefined, epoch?: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined
  if (epoch !== undefined) {
    if (!value.startsWith(`${epoch}:`)) return -1
    value = value.slice(epoch.length + 1)
  }
  if (!/^\d+$/.test(value)) return epoch === undefined ? undefined : -1
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return epoch === undefined ? undefined : -1
  return parsed
}

export class EventReplayBuffer<T> {
  readonly epoch = crypto.randomUUID()
  private readonly frames: Array<StoredReplayFrame<T> | undefined>
  private length = 0
  private head = 0
  private bytes = 0
  private firstSequence = 1
  private nextSequence = 1

  constructor(
    private readonly capacity = DEFAULT_CAPACITY,
    private readonly options: { readonly maxBytes?: number; readonly sizeOf?: (event: T) => number } = {},
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Event replay capacity must be positive")
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    if (!(maxBytes > 0) || Number.isNaN(maxBytes)) throw new Error("Event replay byte capacity must be positive")
    this.frames = new Array(capacity)
  }

  append(event: T) {
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES
    const frame = { sequence: this.nextSequence++, event, size: 0 }
    const rawSize = this.options.sizeOf?.(event) ?? 1
    const size = Number.isFinite(rawSize) ? Math.max(0, rawSize) : Number.MAX_SAFE_INTEGER
    frame.size = size
    if (size > maxBytes) {
      // Preserve the cursor even when one pathological payload is larger than
      // the whole replay budget. The next reconnect must receive a gap signal.
      this.firstSequence = frame.sequence + 1
      this.frames.fill(undefined)
      this.length = 0
      this.head = 0
      this.bytes = 0
      return frame.sequence
    }
    if (this.length === this.capacity) {
      const oldest = this.frames[this.head]!
      this.bytes -= oldest.size
      this.frames[this.head] = frame
      this.head = (this.head + 1) % this.capacity
      this.firstSequence = this.frames[this.head]?.sequence ?? frame.sequence
    } else {
      this.frames[(this.head + this.length) % this.capacity] = frame
      this.length += 1
      if (this.length === 1) this.firstSequence = frame.sequence
    }
    this.bytes += size
    while (this.length > 0 && this.bytes > maxBytes) {
      const oldest = this.frames[this.head]!
      this.bytes -= oldest.size
      this.frames[this.head] = undefined
      this.head = (this.head + 1) % this.capacity
      this.length -= 1
      this.firstSequence = oldest.sequence + 1
    }
    return frame.sequence
  }

  latest() {
    return this.nextSequence - 1
  }

  since(after: number | undefined, filter?: (event: T) => boolean): EventReplayResult<T> {
    const latest = this.latest()
    // `firstSequence` also records a discarded oversized frame. In that case
    // the ring is empty even though the stream has history, so exposing
    // `undefined` would make an old cursor look perfectly replayable.
    const oldest = this.length > 0 ? this.frames[this.head]!.sequence : latest > 0 ? this.firstSequence : undefined
    if (after === undefined) {
      return { kind: "ok", frames: [], latest, ...(oldest === undefined ? {} : { oldest }) }
    }
    if (!Number.isSafeInteger(after) || after < 0 || after > latest) {
      // A cursor from a previous server process is ahead of this ring. Treat
      // the restart as a gap so the client hydrates instead of assuming that
      // no events were lost.
      return { kind: "gap", latest, oldest: oldest ?? latest + 1, requested: after }
    }
    if (after === latest) {
      return { kind: "ok", frames: [], latest, ...(oldest === undefined ? {} : { oldest }) }
    }

    // A cursor older than the retained window cannot be replayed safely. The
    // caller must hydrate a snapshot instead of silently presenting stale data.
    if (oldest !== undefined && after < oldest - 1) {
      return { kind: "gap", latest, oldest, requested: after }
    }
    // A frame larger than the byte budget leaves no retained frame. There is
    // still a missing sequence between the caller's cursor and the latest
    // published sequence, so force snapshot repair instead of returning an
    // empty successful replay.
    if (this.length === 0 && latest > after) {
      return { kind: "gap", latest, oldest: Math.max(oldest ?? latest + 1, latest + 1), requested: after }
    }

    const frames: EventReplayFrame<T>[] = []
    for (let offset = 0; offset < this.length; offset++) {
      const frame = this.frames[(this.head + offset) % this.capacity]!
      if (frame.sequence <= after) continue
      if (filter && !filter(frame.event)) continue
      frames.push(frame)
    }
    return { kind: "ok", frames, latest, ...(oldest === undefined ? {} : { oldest }) }
  }

  get size() {
    return this.length
  }
}

/** Cheap bounded estimate used for transport replay budgets. */
export function estimateEventBytes(value: unknown) {
  // Saturate above every current transport budget (8 MiB) so a pathological
  // payload is rejected as oversized rather than being miscounted as a small
  // frame. Traverse nested payloads without a fixed depth cutoff: a deeply
  // nested large string must not be mistaken for a tiny frame. The active set
  // breaks cycles while still counting a shared object again when it appears
  // in two separate branches (the wire representation repeats it too).
  const estimateLimit = 64 * 1024 * 1024
  const maxNodes = 200_000
  const cacheable = value !== null && typeof value === "object" ? value : undefined
  if (cacheable) {
    const cached = eventSizeCache.get(cacheable)
    if (cached !== undefined) return cached
  }
  let total = 32
  let nodes = 0
  const active = new WeakSet<object>()
  const stack: Array<{ value: unknown; exit?: boolean }> = [{ value }]
  while (stack.length > 0 && total < estimateLimit) {
    const frame = stack.pop()!
    const input = frame.value
    if (frame.exit) {
      if (input && typeof input === "object") active.delete(input)
      continue
    }
    if (typeof input === "string") {
      total += input.length * 4
      continue
    }
    if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
      total += 8
      continue
    }
    if (!input || typeof input !== "object") {
      total += 16
      continue
    }
    nodes += 1
    if (nodes > maxNodes) {
      total = estimateLimit
      break
    }
    if (active.has(input)) {
      total += 16
      continue
    }
    active.add(input)
    stack.push({ value: input, exit: true })
    if (Array.isArray(input)) {
      total += 8
      for (let index = input.length - 1; index >= 0; index--) stack.push({ value: input[index] })
      continue
    }
    for (const [key, item] of Object.entries(input)) {
      total += key.length * 3 + 2
      stack.push({ value: item })
    }
  }
  const result = Math.min(total, estimateLimit)
  if (cacheable) eventSizeCache.set(cacheable, result)
  return result
}
