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
      /**
       * Sum of the `size` recorded for each returned frame at append time.
       * Reading this is free: the buffer already paid for it once per frame,
       * so a transport can enforce a replay budget without re-estimating
       * every frame on the request path.
       */
      readonly bytes: number
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
  /**
   * Sequences dropped because one payload exceeded the whole budget, ascending.
   * They are not retained, so a replay spanning one is missing a position.
   * Bounded by normal ring eviction: a hole older than the retained window is
   * discarded because the ordinary `oldest` gap check already covers it.
   */
  private holes: number[] = []

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
    // A single payload can exceed the whole budget on its own. Evicting the
    // ring would not make it fit, and it must not strand every other client:
    // the oversized frame is dropped while previously retained frames keep
    // their cursors, so existing reconnects stay resumable. The sequence is
    // still consumed, so a later `since` reports a gap for that one position
    // instead of hiding the loss.
    if (size > maxBytes) {
      this.firstSequence = this.length > 0 ? this.frames[this.head]!.sequence : frame.sequence + 1
      this.holes.push(frame.sequence)
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
    this.pruneHoles()
    return frame.sequence
  }

  /**
   * Drop hole markers the retained window has moved past. Once `firstSequence`
   * is past a hole, the ordinary oldest-cursor gap check already forces
   * hydration, so keeping the marker would only grow without bound.
   */
  private pruneHoles() {
    if (this.holes.length === 0) return
    const oldest = this.length > 0 ? this.frames[this.head]!.sequence : this.firstSequence
    while (this.holes.length > 0 && this.holes[0]! <= oldest) this.holes.shift()
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
      return { kind: "ok", frames: [], latest, bytes: 0, ...(oldest === undefined ? {} : { oldest }) }
    }
    if (!Number.isSafeInteger(after) || after < 0 || after > latest) {
      // A cursor from a previous server process is ahead of this ring. Treat
      // the restart as a gap so the client hydrates instead of assuming that
      // no events were lost.
      return { kind: "gap", latest, oldest: oldest ?? latest + 1, requested: after }
    }
    if (after === latest) {
      return { kind: "ok", frames: [], latest, bytes: 0, ...(oldest === undefined ? {} : { oldest }) }
    }

    // A cursor older than the retained window cannot be replayed safely. The
    // caller must hydrate a snapshot instead of silently presenting stale data.
    if (oldest !== undefined && after < oldest - 1) {
      return { kind: "gap", latest, oldest, requested: after }
    }
    // A payload larger than the whole budget is dropped rather than retained.
    // A cursor before such a hole can never receive that sequence, so this is
    // a gap for it -- but only for it. Cursors at or past the hole replay
    // normally, which is the whole point of not nuking the ring.
    for (const hole of this.holes) {
      if (hole <= after) continue
      if (hole > latest) break
      return { kind: "gap", latest, oldest: hole, requested: after }
    }
    // If a dropped payload leaves the ring empty there is still a missing
    // sequence between the caller's cursor and the latest published sequence,
    // so force snapshot repair instead of returning an empty successful replay.
    if (this.length === 0 && latest > after) {
      return { kind: "gap", latest, oldest: Math.max(oldest ?? latest + 1, latest + 1), requested: after }
    }

    const frames: EventReplayFrame<T>[] = []
    let bytes = 0
    for (let offset = 0; offset < this.length; offset++) {
      const frame = this.frames[(this.head + offset) % this.capacity]!
      if (frame.sequence <= after) continue
      if (filter && !filter(frame.event)) continue
      frames.push(frame)
      bytes += frame.size
    }
    return { kind: "ok", frames, latest, bytes, ...(oldest === undefined ? {} : { oldest }) }
  }

  get size() {
    return this.length
  }

  /** Retained bytes across the live window. */
  get byteSize() {
    return this.bytes
  }
}

/**
 * UTF-8 length of a string without materializing a Buffer.
 *
 * `length` is UTF-16 code units. Charging a flat 4 bytes per unit (the
 * worst case) overcounts ASCII by 4x, and ASCII is what code, diffs and tool
 * output are actually made of -- a 2 MiB tool result was billed as 8 MiB and
 * wiped the whole replay window. Count real UTF-8 bytes: 1 for < 0x80, 2 for
 * < 0x800 (plus the surrogate pair case, which is 4 for the pair).
 */
function utf8Length(value: string) {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
      continue
    }
    if (code < 0x800) {
      bytes += 2
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      // High surrogate: the pair encodes one astral scalar as 4 bytes.
      bytes += 4
      index++
      continue
    }
    bytes += 3
  }
  return bytes
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
      total += utf8Length(input)
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
