import { EventManifest } from "@opencode-ai/schema/event-manifest"

type EventEnvelope = {
  readonly type: string
  readonly data?: unknown
  readonly properties?: unknown
}

type DeltaDescriptor = {
  readonly key: (data: Record<string, unknown>) => string | undefined
  readonly field: "delta" | "text"
}

const MAX_DELTA_CHARS = 64 * 1024
const DEFAULT_FLUSH_MS = 16
const DEFAULT_MAX_PENDING_KEYS = 256

const LEGACY_DELTAS: Record<string, DeltaDescriptor> = {
  // These v1 transport aliases are emitted by the compatibility bridge and do
  // not have schema definitions of their own. Keep them explicit; every
  // manifest event remains a barrier unless it opts in through `coalesce`.
  "session.text.delta": {
    key: (data) => tupleKey(data.sessionID, data.assistantMessageID, data.ordinal),
    field: "delta",
  },
  "session.reasoning.delta": {
    key: (data) => tupleKey(data.sessionID, data.assistantMessageID, data.ordinal),
    field: "delta",
  },
  "session.tool.input.delta": {
    key: (data) => tupleKey(data.sessionID, data.assistantMessageID, data.callID),
    field: "delta",
  },
  "session.compaction.delta": {
    key: (data) => tupleKey(data.sessionID),
    field: "text",
  },
  "session.next.text.delta": {
    key: (data) => tupleKey(data.sessionID, data.assistantMessageID, data.textID),
    field: "delta",
  },
  "session.next.reasoning.delta": {
    key: (data) => tupleKey(data.sessionID, data.assistantMessageID, data.reasoningID),
    field: "delta",
  },
  "session.next.tool.input.delta": {
    key: (data) => tupleKey(data.sessionID, data.assistantMessageID, data.callID),
    field: "delta",
  },
  "session.next.compaction.delta": {
    key: (data) => tupleKey(data.sessionID, data.messageID),
    field: "text",
  },
}

const DELTAS = new Map<string, DeltaDescriptor>()
for (const definition of EventManifest.Latest.values()) {
  const coalesce = definition.coalesce
  if (!coalesce) continue
  DELTAS.set(definition.type, {
    key: (data) => tupleKey(...coalesce.key.map((field) => data[field])),
    field: coalesce.field,
  })
}
for (const [type, descriptor] of Object.entries(LEGACY_DELTAS)) {
  if (!DELTAS.has(type)) DELTAS.set(type, descriptor)
}

function tupleKey(...values: unknown[]) {
  let result = ""
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") return undefined
    const text = String(value)
    result += `${text.length}:${text}`
  }
  return result
}

function dataOf(event: EventEnvelope) {
  const data = event.data ?? event.properties
  return data && typeof data === "object" ? (data as Record<string, unknown>) : undefined
}

export function eventDeltaKey(event: EventEnvelope) {
  const descriptor = DELTAS.get(event.type)
  const data = descriptor && dataOf(event)
  if (!descriptor || !data) return undefined
  const key = descriptor.key(data)
  return key === undefined ? undefined : `${event.type}|${key}`
}

export function mergeEventDeltas<T extends EventEnvelope>(previous: T, next: T): T | undefined {
  if (previous.type !== next.type) return undefined
  const descriptor = DELTAS.get(next.type)
  const previousData = descriptor && dataOf(previous)
  const nextData = descriptor && dataOf(next)
  if (!descriptor || !previousData || !nextData) return undefined
  if (eventDeltaKey(previous) !== eventDeltaKey(next)) return undefined
  const previousFragment = previousData[descriptor.field]
  const nextFragment = nextData[descriptor.field]
  if (typeof previousFragment !== "string" || typeof nextFragment !== "string") return undefined
  if (previousFragment.length + nextFragment.length > MAX_DELTA_CHARS) return undefined

  const data = { ...nextData, [descriptor.field]: previousFragment + nextFragment }
  if ("data" in next && next.data !== undefined) return { ...next, data } as T
  return { ...next, properties: data } as T
}

export type EventCoalescer<T> = {
  offer: (event: T) => void
  flush: () => void
  dispose: () => void
  /**
   * Highest input sequence such that every sequence at or below it has been
   * delivered to the subscriber. Monotonic. Only meaningful when `orderBy` is
   * supplied; for unsequenced transports the coalescer delivers in retention
   * order and this tracks delivered count semantics instead.
   */
  readonly ackWatermark: number | undefined
}

/**
 * Coalesce only explicitly identified live delta events. Lifecycle events are
 * barriers: pending fragments flush before them, preserving wire order. A
 * short timer keeps latency frame-sized even when a stream has no lifecycle
 * event for a long time. The pending map and fragment size are both bounded.
 *
 * Cursor-bearing streams (`orderBy`) merge across interleaved keys. Because a
 * merged frame carries fragments of *older* sequences, the frame's own order is
 * not a safe resumption cursor: acknowledging it would claim delivery of
 * fragments still buffered in a later frame. Every frame is therefore stamped
 * with an explicit ack watermark rather than its own order. See `ackWatermark`.
 */
export function createEventCoalescer<T>(
  offer: (event: T) => boolean | void,
  options: {
    readonly keyOf: (event: T) => string | undefined
    readonly merge: (previous: T, next: T) => T | undefined
    /** Optional wire-order key for transports that attach monotonic cursors. */
    readonly orderBy?: (event: T) => number
    /**
     * Rewrite the cursor field of a frame before delivery. Defaults to
     * overriding `sequence`, the cursor field every current SSE handler reads
     * when it stamps the SSE `id`. A transport that names its cursor field
     * differently must supply this or it silently loses watermark stamping.
     */
    readonly withOrder?: (event: T, order: number) => T
    readonly flushMs?: number
    readonly maxPendingKeys?: number
  },
): EventCoalescer<T> {
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
  const maxPendingKeys = options.maxPendingKeys ?? DEFAULT_MAX_PENDING_KEYS
  const orderBy = options.orderBy
  /** A retained key plus the inclusive order range its value covers. */
  type Entry = { min: number; max: number; event: T }
  let pending = new Map<string, Entry>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  /** Highest input order handed to `offer`. */
  let highest: number | undefined
  /** Largest S such that every input of order <= S has been delivered. */
  let watermark: number | undefined

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const stamp = (event: T, order: number): T => {
    if (options.withOrder) return options.withOrder(event, order)
    return { ...(event as object), sequence: order } as T
  }

  /**
   * `order` is the cursor to publish (the watermark); `own` is the frame's own
   * order. They differ for merged frames and coincide for barriers.
   */
  const deliver = (event: T, order?: number, own?: number) => {
    if (disposed) return false
    if (own !== undefined) highest = highest === undefined ? own : Math.max(highest, own)
    if (order !== undefined) watermark = order
    if (offer(order === undefined ? event : stamp(event, order)) === false) {
      disposed = true
      clearTimer()
      pending.clear()
      return false
    }
    return true
  }

  const flush = () => {
    clearTimer()
    if (disposed || pending.size === 0) return
    const entries = [...pending.values()]
    pending = new Map()
    if (!orderBy) {
      for (const entry of entries) {
        if (!deliver(entry.event)) break
      }
      return
    }
    entries.sort((left, right) => left.max - right.max)
    // Deliver in order and publish, with each frame, the largest prefix of the
    // input that is delivered *at that moment*. Everything not yet handed to
    // `offer` is still in `remaining`, so the oldest undelivered order is the
    // minimum `min` over it; the prefix strictly below that is complete.
    const remaining = entries.slice()
    while (remaining.length > 0) {
      const entry = remaining.shift()!
      const own = entry.max
      highest = highest === undefined ? own : Math.max(highest, own)
      const base = remaining.length === 0 ? highest : Math.min(...remaining.map((item) => item.min)) - 1
      const ack = watermark === undefined ? base : Math.max(watermark, base)
      if (!deliver(entry.event, ack, own)) break
    }
  }

  const arm = () => {
    if (timer !== undefined || disposed) return
    timer = setTimeout(flush, flushMs)
  }

  const push = (event: T) => {
    if (disposed) return
    const key = options.keyOf(event)
    const order = orderBy?.(event)
    if (key === undefined) {
      // Barriers flush first, so the prefix below them is complete by the time
      // they are delivered and their own order is a safe cursor.
      flush()
      deliver(event, order, order)
      return
    }

    const previous = pending.get(key)
    if (previous !== undefined) {
      const merged = options.merge(previous.event, event)
      if (merged !== undefined) {
        pending.set(key, { min: previous.min, max: order ?? previous.max, event: merged })
        arm()
        return
      }
      // A size cap or a non-mergeable replacement is an ordering barrier for
      // this key. Flush all keys before retaining the new fragment.
      flush()
    }
    if (pending.size >= maxPendingKeys) flush()
    pending.set(key, { min: order ?? 0, max: order ?? 0, event })
    arm()
  }

  const dispose = () => {
    disposed = true
    clearTimer()
    pending.clear()
  }

  return {
    offer: push,
    flush,
    dispose,
    get ackWatermark() {
      return watermark
    },
  }
}
