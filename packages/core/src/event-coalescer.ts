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
}

/**
 * Coalesce only explicitly identified live delta events. Lifecycle events are
 * barriers: pending fragments flush before them, preserving wire order. A
 * short timer keeps latency frame-sized even when a stream has no lifecycle
 * event for a long time. The pending map and fragment size are both bounded.
 */
export function createEventCoalescer<T>(
  offer: (event: T) => boolean | void,
  options: {
    readonly keyOf: (event: T) => string | undefined
    readonly merge: (previous: T, next: T) => T | undefined
    /** Optional wire-order key for transports that attach monotonic cursors. */
    readonly orderBy?: (event: T) => number
    readonly flushMs?: number
    readonly maxPendingKeys?: number
  },
): EventCoalescer<T> {
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
  const maxPendingKeys = options.maxPendingKeys ?? DEFAULT_MAX_PENDING_KEYS
  let pending = new Map<string, T>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const deliver = (event: T) => {
    if (disposed) return false
    if (offer(event) === false) {
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
    const values = [...pending.values()]
    if (options.orderBy) values.sort((left, right) => options.orderBy!(left) - options.orderBy!(right))
    pending = new Map()
    for (const event of values) {
      if (!deliver(event)) break
    }
  }

  const arm = () => {
    if (timer !== undefined || disposed) return
    timer = setTimeout(flush, flushMs)
  }

  const push = (event: T) => {
    if (disposed) return
    const key = options.keyOf(event)
    if (key === undefined) {
      flush()
      deliver(event)
      return
    }

    // A resumable transport may acknowledge only a delivered prefix. Merging
    // A1, B2, A3 into B2, A1+A3 would acknowledge A1 before delivering it.
    // Restrict cursor-bearing streams to adjacent runs of one key.
    if (options.orderBy && pending.size > 0 && !pending.has(key)) flush()
    const previous = pending.get(key)
    if (previous !== undefined) {
      const merged = options.merge(previous, event)
      if (merged !== undefined) {
        pending.set(key, merged)
        arm()
        return
      }
      // A size cap or a non-mergeable replacement is an ordering barrier for
      // this key. Flush all keys before retaining the new fragment.
      flush()
    }
    if (pending.size >= maxPendingKeys) flush()
    pending.set(key, event)
    arm()
  }

  const dispose = () => {
    disposed = true
    clearTimer()
    pending.clear()
  }

  return { offer: push, flush, dispose }
}
