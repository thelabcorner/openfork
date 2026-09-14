import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { Event } from "@opencode-ai/sdk/v2/client"
import type * as SessionEvent from "@opencode-ai/schema/session-event"
import { estimateEventBytes } from "@opencode-ai/core/event-replay"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { type Accessor, batch, createMemo, createResource, onCleanup, onMount } from "solid-js"
import { createApiForServer, createSdkForServer, type ServerApi } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerScope } from "@/utils/server-scope"
import { detectServerProtocol, type ServerProtocol } from "@/utils/server-protocol"
import { createCompatibleApi, type CompatibleApi } from "@/utils/server-compat"
import { markServerStreamDead, markServerStreamLive } from "@/utils/server-liveness"
import { eventStreamFetch } from "@/utils/event-stream-auth"
import { trackPending } from "@/utils/pending-work"
import { perf } from "./perf"
import { phaseTrace } from "./phase-trace"
import { isSessionStreamContentEvent } from "@/utils/session-stream-content"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

const isStreamClosed = (error: unknown, signal?: AbortSignal) => isAbortError(error) || signal?.aborted === true
type NativeSessionEvent = typeof SessionEvent.All.Encoded
type NativeEvent = OpenCodeEvent | NativeSessionEvent
export type ServerEvent = Event & { current?: NativeEvent }
export type QueuedServerEvent = { directory: string; payload: ServerEvent }
type CurrentDelta = Extract<
  OpenCodeEvent,
  { type: "session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta" | "session.compaction.delta" }
> |
  Extract<
    NativeSessionEvent,
    {
      type:
        | "session.next.text.delta"
        | "session.next.reasoning.delta"
        | "session.next.tool.input.delta"
        | "session.next.compaction.delta"
    }
  >
type StreamContentInterest = (sessionID: string) => boolean
type StreamContentInvalidator = (sessionID: string, repair: boolean) => void

// Coalescing reduces reducer/render work while the renderer is catching up,
// but an unbounded token string would turn a bounded event queue into an
// unbounded memory buffer. Split a long stream into independently bounded
// chunks; the ordered queue still preserves the exact text.
const MAX_COALESCED_DELTA_CHARS = 64 * 1024
const MAX_PENDING_EVENT_BYTES = 8 * 1024 * 1024
// Keep enough headroom for ordinary lifecycle bursts without ever letting a
// pathological stream grow the renderer queue without bound. Unlike the old
// 1024-item socket pause, crossing this ceiling repairs locally through the
// existing snapshot barrier instead of stopping SSE reads and pushing pressure
// back into the server subscriber queue.
export const MAX_PENDING_EVENT_COUNT = 4096

type QueuedDeltaAccumulator = {
  readonly fragments: string[]
  chars: number
  bytes: number
}

// Queue-local rope metadata. A paused renderer can accumulate thousands of
// fragments without rebuilding the growing text on each ingress; WeakMap keys
// let dropped/dequeued events and their ropes disappear together.
const queuedDeltaAccumulators = new WeakMap<object, QueuedDeltaAccumulator>()

function utf8StringBytes(value: string) {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      bytes += 4
      index++
    } else bytes += 3
  }
  return bytes
}

export function adaptServerEvent(event: NativeEvent): ServerEvent {
  if (event.type === "permission.v2.asked") {
    return {
      id: event.id,
      type: "permission.asked",
      properties: {
        id: event.data.id,
        sessionID: event.data.sessionID,
        permission: event.data.action,
        patterns: event.data.resources,
        always: event.data.save ?? [],
        metadata: event.data.metadata ?? {},
        tool:
          event.data.source?.type === "tool"
            ? { messageID: event.data.source.messageID, callID: event.data.source.callID }
            : undefined,
      },
      current: event,
    } as ServerEvent
  }
  if (event.type === "permission.v2.replied")
    return { id: event.id, type: "permission.replied", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.asked")
    return { id: event.id, type: "question.asked", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.replied")
    return { id: event.id, type: "question.replied", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.rejected")
    return { id: event.id, type: "question.rejected", properties: event.data, current: event } as ServerEvent
  return { id: event.id, type: event.type, properties: event.data, current: event } as ServerEvent
}

function estimateQueuedEventBytes(payload: ServerEvent) {
  const current = payload.current
  if (!current) return estimateEventBytes(payload)
  const properties = payload.properties
  const data = "data" in current ? current.data : undefined
  if (properties === data) {
    // Renderer backlog accounting models RETAINED memory, not JSON wire bytes.
    // The normal V2 adapter aliases properties to current.data, so traversing
    // the wrapper with the generic wire estimator counts the same object/string
    // twice and can turn a ~4 MiB retained event into a false 8 MiB overflow.
    return 64 + estimateEventBytes(current)
  }
  // Permission/question compatibility adapters create a distinct legacy
  // properties object. Those events are tiny, but count both retained branches
  // rather than undercharging them.
  return 64 + estimateEventBytes(current) + estimateEventBytes(properties)
}

function queuedEventBytes(event: QueuedServerEvent) {
  const accumulator = queuedDeltaAccumulators.get(event)
  if (!accumulator) return estimateQueuedEventBytes(event.payload)
  const fragment = queuedDeltaFragment(event) ?? ""
  return Math.max(0, estimateQueuedEventBytes(event.payload) - utf8StringBytes(fragment)) + accumulator.bytes
}

const coalescedKey = (event: QueuedServerEvent) => {
  if (event.payload.type === "lsp.updated") return `lsp.updated:${event.directory}`
  if (event.payload.type === "message.part.updated") {
    const part = event.payload.properties.part
    return `message.part.updated:${event.directory}:${part.messageID}:${part.id}`
  }
  return undefined
}

export function enqueueServerEvent(queue: QueuedServerEvent[], event: QueuedServerEvent) {
  const key = coalescedKey(event)
  const previous = queue[queue.length - 1]
  if (key && previous && coalescedKey(previous) === key) {
    queue[queue.length - 1] = event
    return false
  }
  queue.push(event)
  return true
}

export function createServerEventQueue(options: { onSessionContentDropped?: (sessionID: string) => void } = {}) {
  let queue: QueuedServerEvent[] = []
  let sizes: number[] = []
  let head = 0
  let bytes = 0
  // Keep indexes into the unread portion of the queue for delta streams. A
  // renderer pause can otherwise fill the queue with hundreds of tiny tokens
  // that are semantically one update. Barriers clear this map so lifecycle
  // ordering remains exact.
  const pendingDeltas = new Map<string, number>()
  const append = (event: QueuedServerEvent, size = queuedEventBytes(event)) => {
    const before = queue.length
    const previousSize = sizes[before - 1] ?? 0
    enqueueServerEvent(queue, event)
    if (queue.length === before) {
      sizes[before - 1] = size
      bytes += size - previousSize
      return
    }
    sizes.push(size)
    bytes += size
  }
  const contentSessionID = (event: QueuedServerEvent) => {
    if (!isSessionStreamContentEvent(String(event.payload.type))) return
    return serverEventSessionID(event.payload)
  }
  const notifyDroppedContent = (event: QueuedServerEvent, seen?: Set<string>) => {
    const sessionID = contentSessionID(event)
    if (!sessionID || seen?.has(sessionID)) return sessionID
    seen?.add(sessionID)
    options.onSessionContentDropped?.(sessionID)
    return sessionID
  }
  const rebuildUnread = (retained: QueuedServerEvent[], retainedSizes: number[]) => {
    queue = retained
    sizes = retainedSizes
    head = 0
    bytes = retainedSizes.reduce((total, size) => total + size, 0)
    pendingDeltas.clear()
    for (let index = 0; index < queue.length; index++) {
      const key = queueDeltaKey(queue[index]!)
      if (key) pendingDeltas.set(key, index)
      else pendingDeltas.clear()
    }
  }
  const shedQueuedContent = () => {
    const dropped = new Set<string>()
    if (queue.length === head) return dropped
    const retained: QueuedServerEvent[] = []
    const retainedSizes: number[] = []
    for (let index = head; index < queue.length; index++) {
      const item = queue[index]!
      if (contentSessionID(item)) {
        notifyDroppedContent(item, dropped)
        continue
      }
      retained.push(item)
      retainedSizes.push(sizes[index] ?? 0)
    }
    if (retained.length !== queue.length - head) rebuildUnread(retained, retainedSizes)
    return dropped
  }
  const repair = (event: QueuedServerEvent) => {
    queue = []
    sizes = []
    head = 0
    bytes = 0
    pendingDeltas.clear()
    append({
      // Only GLOBAL server.connected is a hydration barrier in server-sync:
      // it refetches global state and queues bootstrap for every active
      // directory. A directory-scoped connected frame falls through the normal
      // directory reducer and repairs nothing, so the previous fallback could
      // discard backlog permanently under byte pressure.
      directory: "global",
      payload: { id: event.payload.id, type: "server.connected", properties: { repair: true } } as ServerEvent,
    })
  }
  const wouldOverflowCount = () => queue.length - head >= MAX_PENDING_EVENT_COUNT
  const hasCapacityFor = (size: number) => bytes + size <= MAX_PENDING_EVENT_BYTES && !wouldOverflowCount()
  const admitUnderPressure = (event: QueuedServerEvent, size: number): "admit" | "drop" | "global" => {
    // Reconstructible content is the first thing to shed. Its owning session can
    // hydrate itself; unrelated lifecycle/config/permission events remain in
    // order instead of being destroyed by one noisy timeline.
    const dropped = shedQueuedContent()
    const sessionID = contentSessionID(event)
    if (sessionID && dropped.has(sessionID)) return "drop"
    if (hasCapacityFor(size)) return "admit"
    if (sessionID) {
      notifyDroppedContent(event)
      return "drop"
    }
    repair(event)
    return "global"
  }
  const compactHead = () => {
    if (head === queue.length) {
      queue = []
      sizes = []
      head = 0
      bytes = 0
      pendingDeltas.clear()
      return
    }
    if (head < 1024) return
    queue = queue.slice(head)
    sizes = sizes.slice(head)
    for (const [key, index] of pendingDeltas) pendingDeltas.set(key, index - head)
    head = 0
  }
  return {
    get size() {
      return queue.length - head
    },
    push(event: QueuedServerEvent) {
      const key = queueDeltaKey(event)
      if (key) {
        const previousIndex = pendingDeltas.get(key)
        if (previousIndex !== undefined && previousIndex >= head) {
          const previous = queue[previousIndex]
          if (previous) {
            const merged = mergeQueuedDeltaEvents(previous, event)
            if (merged) {
              const size = queuedEventBytes(merged)
              if (bytes - (sizes[previousIndex] ?? 0) + size > MAX_PENDING_EVENT_BYTES) {
                const sessionID = contentSessionID(event) ?? contentSessionID(previous)
                if (sessionID) {
                  options.onSessionContentDropped?.(sessionID)
                  queue.splice(previousIndex, 1)
                  sizes.splice(previousIndex, 1)
                  rebuildUnread(queue.slice(head), sizes.slice(head))
                  return
                }
                repair(event)
                return
              }
              queue[previousIndex] = merged
              bytes += size - (sizes[previousIndex] ?? 0)
              sizes[previousIndex] = size
              return
            }
          }
        }
        const size = queuedEventBytes(event)
        if (!hasCapacityFor(size)) {
          const admission = admitUnderPressure(event, size)
          if (admission !== "admit") return
        }
        append(event, size)
        pendingDeltas.set(key, queue.length - 1)
        return
      }

      const size = queuedEventBytes(event)
      if (!hasCapacityFor(size)) {
        const admission = admitUnderPressure(event, size)
        if (admission === "drop") return
        if (admission === "global") {
          if (!isQueuedDelta(event.payload) && size <= MAX_PENDING_EVENT_BYTES) append(event, size)
          return
        }
      }
      append(event, size)
      pendingDeltas.clear()
    },
    take(count: number) {
      const end = Math.min(queue.length, head + count)
      // push() already coalesces every unread key. Re-coalescing here would
      // rescan the same batch and rebuild the same delta strings on every
      // animation frame.
      const result = queue.slice(head, end).map(materializeQueuedDelta)
      for (let index = head; index < end; index++) bytes -= sizes[index] ?? 0
      head = end
      for (const [key, index] of pendingDeltas) {
        if (index < head) pendingDeltas.delete(key)
      }
      compactHead()
      return result
    },
    shift() {
      const queued = queue[head]
      const event = queued ? materializeQueuedDelta(queued) : undefined
      if (!event) return
      bytes -= sizes[head] ?? 0
      const oldHead = head++
      const key = queueDeltaKey(event)
      if (key && pendingDeltas.get(key) === oldHead) pendingDeltas.delete(key)
      compactHead()
      return event
    },
    clear() {
      queue = []
      sizes = []
      head = 0
      bytes = 0
      pendingDeltas.clear()
    },
    dropWhere(predicate: (event: QueuedServerEvent) => boolean, onDrop?: (event: QueuedServerEvent) => void) {
      if (queue.length === head) return 0
      const retained: QueuedServerEvent[] = []
      const retainedSizes: number[] = []
      let dropped = 0
      for (let index = head; index < queue.length; index++) {
        const event = queue[index]!
        if (predicate(event)) {
          dropped += 1
          onDrop?.(event)
          continue
        }
        retained.push(event)
        retainedSizes.push(sizes[index] ?? 0)
      }
      if (dropped === 0) return 0
      rebuildUnread(retained, retainedSizes)
      return dropped
    },
  }
}

export function drainServerEventQueue(
  queue: ReturnType<typeof createServerEventQueue>,
  emit: (event: QueuedServerEvent) => void,
  options: { maxEvents?: number; budgetMs?: number; now?: () => number } = {},
) {
  const maxEvents = Math.max(1, options.maxEvents ?? 128)
  const budgetMs = Math.max(0, options.budgetMs ?? 6)
  const now = options.now ?? (() => performance.now())
  const started = now()
  let processed = 0
  while (processed < maxEvents) {
    const event = queue.shift()
    if (!event) break
    emit(event)
    processed += 1
    // Always make progress by at least one event, then yield as soon as this
    // task has consumed its main-thread budget. A fixed 128-event drain made a
    // batch of expensive tool/snapshot events indistinguishable from 128 tiny
    // token deltas and could create a long renderer task under concurrency.
    if (processed > 0 && now() - started >= budgetMs) break
  }
  return processed
}

function queueDeltaKey(event: QueuedServerEvent) {
  const current = currentDelta(event.payload.current)
  if (current) return `current|${keyPart(event.directory)}${currentDeltaKey(current)}`
  if (event.payload.type !== "message.part.delta") return undefined
  const props = event.payload.properties
  return `v1|${keyPart(event.directory)}${keyPart(props.sessionID)}${keyPart(props.messageID)}${keyPart(props.partID)}${keyPart(props.field)}`
}

function isQueuedDelta(payload: ServerEvent) {
  const type = payload.type as string
  return currentDelta(payload.current) !== undefined || type.endsWith(".delta")
}

function queuedDeltaFragment(event: QueuedServerEvent) {
  const current = currentDelta(event.payload.current)
  if (current) return currentDeltaFragment(current)
  if (event.payload.type === "message.part.delta") return event.payload.properties.delta as string
  return undefined
}

/** Queue-only delta merge. The text remains a fragment rope until dequeue. */
function mergeQueuedDeltaEvents(previous: QueuedServerEvent, event: QueuedServerEvent): QueuedServerEvent | undefined {
  const priorCurrent = currentDelta(previous.payload.current)
  const nextCurrent = currentDelta(event.payload.current)
  const compatibleCurrent = !!priorCurrent && !!nextCurrent && priorCurrent.type === nextCurrent.type
  const compatibleLegacy = previous.payload.type === "message.part.delta" && event.payload.type === "message.part.delta"
  if (!compatibleCurrent && !compatibleLegacy) return undefined

  const previousFragment = queuedDeltaFragment(previous)
  const nextFragment = queuedDeltaFragment(event)
  if (previousFragment === undefined || nextFragment === undefined) return undefined
  const prior = queuedDeltaAccumulators.get(previous)
  const chars = (prior?.chars ?? previousFragment.length) + nextFragment.length
  if (chars > MAX_COALESCED_DELTA_CHARS) return undefined

  const accumulator: QueuedDeltaAccumulator = prior ?? {
    fragments: [previousFragment],
    chars: previousFragment.length,
    bytes: utf8StringBytes(previousFragment),
  }
  accumulator.fragments.push(nextFragment)
  accumulator.chars = chars
  accumulator.bytes += utf8StringBytes(nextFragment)
  queuedDeltaAccumulators.set(event, accumulator)
  return event
}

function materializeQueuedDelta(event: QueuedServerEvent): QueuedServerEvent {
  const accumulator = queuedDeltaAccumulators.get(event)
  if (!accumulator) return event
  queuedDeltaAccumulators.delete(event)
  const fragment = accumulator.fragments.join("")
  const current = currentDelta(event.payload.current)
  if (current) {
    const data =
      current.type === "session.compaction.delta" || current.type === "session.next.compaction.delta"
        ? { ...current.data, text: fragment }
        : { ...current.data, delta: fragment }
    return {
      directory: event.directory,
      payload: {
        ...event.payload,
        properties: data,
        current: { ...current, data } as CurrentDelta,
      } as ServerEvent,
    }
  }
  if (event.payload.type !== "message.part.delta") return event
  return {
    directory: event.directory,
    payload: {
      ...event.payload,
      properties: { ...event.payload.properties, delta: fragment },
    },
  }
}

export function coalesceServerEvents(events: QueuedServerEvent[]) {
  const output: QueuedServerEvent[] = []
  // Independent delta fields can merge across each other; every lifecycle or
  // snapshot event is an ordering barrier. Tuple encoding avoids delimiter collisions.
  const pending = new Map<string, number>()
  events.forEach((event) => {
    const current = currentDelta(event.payload.current)
    if (current) {
      const key = `current|${keyPart(event.directory)}${currentDeltaKey(current)}`
      const index = pending.get(key)
      const previous = index === undefined ? undefined : output[index]
      if (previous && index !== undefined) {
        const merged = mergeDeltaEvents(previous, event)
        if (merged) {
          output[index] = merged
          return
        }
        // The size cap is a soft barrier for this key. Keep appending in wire
        // order while making the newest chunk the future merge target.
        pending.set(key, output.length)
        output.push(event)
        return
      }
      pending.set(key, output.length)
      output.push(event)
      return
    }
    if (event.payload.type !== "message.part.delta") {
      // Any non-delta event is a barrier: no delta may merge across it.
      pending.clear()
      output.push(event)
      return
    }
    const props = event.payload.properties
    const key = `v1|${keyPart(event.directory)}${keyPart(props.sessionID)}${keyPart(props.messageID)}${keyPart(props.partID)}${keyPart(props.field)}`
    const existingIndex = pending.get(key)
    if (existingIndex !== undefined) {
      const merged = mergeDeltaEvents(output[existingIndex], event)
      if (merged) {
        output[existingIndex] = merged
        return
      }
      pending.set(key, output.length)
      output.push(event)
      return
    }
    output.push({
      directory: event.directory,
      payload: { ...event.payload, properties: { ...props } },
    })
    pending.set(key, output.length - 1)
  })
  return output
}

function mergeDeltaEvents(previous: QueuedServerEvent, event: QueuedServerEvent): QueuedServerEvent | undefined {
  const priorCurrent = currentDelta(previous.payload.current)
  const nextCurrent = currentDelta(event.payload.current)
  if (priorCurrent && nextCurrent && priorCurrent.type === nextCurrent.type) {
    const priorFragment = currentDeltaFragment(priorCurrent)
    const nextFragment = currentDeltaFragment(nextCurrent)
    if (priorFragment.length + nextFragment.length > MAX_COALESCED_DELTA_CHARS) return undefined
    const fragment = priorFragment + nextFragment
    const data =
      nextCurrent.type === "session.compaction.delta" || nextCurrent.type === "session.next.compaction.delta"
        ? { ...nextCurrent.data, text: fragment }
        : { ...nextCurrent.data, delta: fragment }
    return {
      directory: event.directory,
      payload: {
        ...event.payload,
        properties: data,
        current: { ...nextCurrent, data } as CurrentDelta,
      } as ServerEvent,
    }
  }

  if (previous.payload.type !== "message.part.delta" || event.payload.type !== "message.part.delta") return undefined
  const previousProps = previous.payload.properties
  const nextProps = event.payload.properties
  if (previousProps.delta.length + nextProps.delta.length > MAX_COALESCED_DELTA_CHARS) return undefined
  return {
    directory: event.directory,
    payload: {
      ...event.payload,
      properties: { ...nextProps, delta: previousProps.delta + nextProps.delta },
    },
  }
}

function keyPart(value: string | number) {
  const text = String(value)
  return `${text.length}:${text}`
}

function currentDelta(event: NativeEvent | undefined): CurrentDelta | undefined {
  if (
    event?.type === "session.text.delta" ||
    event?.type === "session.reasoning.delta" ||
    event?.type === "session.tool.input.delta" ||
    event?.type === "session.compaction.delta" ||
    event?.type === "session.next.text.delta" ||
    event?.type === "session.next.reasoning.delta" ||
    event?.type === "session.next.tool.input.delta" ||
    event?.type === "session.next.compaction.delta"
  )
    return event
  return undefined
}

function currentDeltaKey(event: CurrentDelta) {
  if (event.type === "session.tool.input.delta" || event.type === "session.next.tool.input.delta")
    return `type|${keyPart(event.type)}${keyPart(event.data.sessionID)}${keyPart(event.data.assistantMessageID)}${keyPart(event.data.callID)}`
  if (event.type === "session.compaction.delta") return `type|${keyPart(event.type)}${keyPart(event.data.sessionID)}`
  if (event.type === "session.next.compaction.delta")
    return `type|${keyPart(event.type)}${keyPart(event.data.sessionID)}${keyPart(event.data.messageID)}`
  if (event.type === "session.next.text.delta")
    return `type|${keyPart(event.type)}${keyPart(event.data.sessionID)}${keyPart(event.data.assistantMessageID)}${keyPart(event.data.textID)}`
  if (event.type === "session.next.reasoning.delta")
    return `type|${keyPart(event.type)}${keyPart(event.data.sessionID)}${keyPart(event.data.assistantMessageID)}${keyPart(event.data.reasoningID)}`
  return `type|${keyPart(event.type)}${keyPart(event.data.sessionID)}${keyPart(event.data.assistantMessageID)}${keyPart(event.data.ordinal)}`
}

function currentDeltaFragment(event: CurrentDelta) {
  return event.type === "session.compaction.delta" || event.type === "session.next.compaction.delta"
    ? event.data.text
    : event.data.delta
}

/**
 * Reconstructible session content is useful only to a foreground timeline.
 * This includes full settlement/snapshot frames as well as token deltas: a
 * hidden session's reducer already discards the same classes and repairs from
 * authoritative history on activation. Filtering here prevents a multi-MiB
 * tool-success/part snapshot from consuming renderer queue budget merely to be
 * discarded later. Status, permissions/questions, moves/renames and other
 * non-content lifecycle metadata still pass through. With no registered
 * authority the historical allow-all behavior is preserved.
 */
export function shouldDispatchSessionStreamFrame(
  type: string,
  sessionID: unknown,
  interest?: StreamContentInterest,
) {
  if (!interest || typeof sessionID !== "string" || !isSessionStreamContentEvent(type)) return true
  return interest(sessionID)
}

function serverEventSessionID(payload: ServerEvent) {
  const properties = payload.properties
  if (properties && typeof properties === "object" && "sessionID" in properties) {
    const sessionID = (properties as { sessionID?: unknown }).sessionID
    if (typeof sessionID === "string") return sessionID
  }
  const current = payload.current
  if (!current || !("data" in current) || !current.data || typeof current.data !== "object") return
  if (!("sessionID" in current.data)) return
  const sessionID = (current.data as { sessionID?: unknown }).sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

export function resumeStreamAfterPageShow(event: PageTransitionEvent, start: () => unknown) {
  if (!event.persisted) return
  start()
}

type ServerEventEmitter = ReturnType<typeof createGlobalEmitter<{ [key: string]: ServerEvent }>>
type ServerSDKBase = {
  server: ServerConnection.Any
  scope: ServerScope
  protocol: Promise<ServerProtocol>
  protocolKind: Accessor<ServerProtocol | undefined>
  url: string
  fetch: typeof globalThis.fetch | undefined
  client: ReturnType<typeof createSdkForServer>
  api: CompatibleApi
  currentApi: ServerApi
  event: {
    on: ServerEventEmitter["on"]
    listen: ServerEventEmitter["listen"]
    start: () => Promise<void> | undefined
    setStreamContentInterest: (interest: StreamContentInterest, invalidate?: StreamContentInvalidator) => () => void
  }
  createClient: (
    opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">,
  ) => ReturnType<typeof createSdkForServer>
}

function createServerSdkContextBase(server: ServerConnection.Any, scope: ServerScope): ServerSDKBase {
  const platform = usePlatform()
  const abort = new AbortController()

  const eventFetch = (() => {
    if (!platform.fetch || !server) return
    try {
      const url = new URL(server.http.url)
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
      if (url.protocol === "http:" && !loopback) return platform.fetch
    } catch {
      return
    }
  })()

  // Both clients below are dedicated to the event stream (eventApi →
  // event.subscribe, eventSdk → global.event), so wrapping their fetch puts
  // the auth_token query param on SSE requests only — EventSource-style
  // contexts cannot rely on headers alone (utils/event-stream-auth.ts).
  const sseFetch = eventStreamFetch(eventFetch ?? globalThis.fetch, server.http)
  const eventApi = createApiForServer({ server: server.http, fetch: sseFetch })
  const eventSdk = createSdkForServer({
    signal: abort.signal,
    fetch: sseFetch,
    server: server.http,
  })
  const protocol = detectServerProtocol(server.http, platform.fetch ?? globalThis.fetch)
  const [protocolKindResource] = createResource(
    () => protocol,
    (value) => value,
  )
  const protocolPending = trackPending("server.protocol")
  void protocol.finally(protocolPending)
  const protocolKind = () => protocolKindResource.latest
  const emitter = createGlobalEmitter<{
    [key: string]: ServerEvent
  }>()

  const FLUSH_FRAME_MS = 16
  const HIDDEN_FLUSH_MS = 1_000
  const STREAM_YIELD_MS = 8
  const FLUSH_BUDGET_MS = 6
  // Reconnect backoff: a fixed 250ms retry turns every server stall into a
  // reconnect storm (4 req/s per server) that adds listeners faster than the
  // OS reaps half-open sockets, compounding the overload. Back off
  // exponentially with jitter so a struggling server gets breathing room.
  const RECONNECT_BASE_MS = 250
  const RECONNECT_MAX_MS = 15_000
  // Preserve lifecycle order and bound reducer work per task. The socket reader
  // keeps pulling independently; the local queue is byte/count bounded and can
  // repair through hydration if the renderer cannot keep up.
  const EVENTS_PER_FLUSH = 128
  let streamContentInterest: StreamContentInterest | undefined
  let streamContentInvalidator: StreamContentInvalidator | undefined
  const queue = createServerEventQueue({
    onSessionContentDropped(sessionID) {
      streamContentInvalidator?.(sessionID, true)
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0
  let hidden = typeof document !== "undefined" && document.visibilityState === "hidden"
  let hiddenDirtyGlobal = false
  const hiddenDirtySessions = new Set<string>()

  const receive = queue.push
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (queue.size === 0) return
    batch(() =>
      drainServerEventQueue(
        queue,
        (event) => {
          // Interest can change after a frame was queued (e.g. the user
          // switches tabs before this 16ms batch flushes). Re-check at the last
          // responsible moment so already-buffered background deltas do not
          // leak through the emitter/reducers; rejecting one also records the
          // session as stale through the registered authority.
          if (
            !shouldDispatchSessionStreamFrame(
              String(event.payload.type),
              serverEventSessionID(event.payload),
              streamContentInterest,
            )
          )
            return
          emitter.emit(event.directory, event.payload)
        },
        {
          maxEvents: EVENTS_PER_FLUSH,
          budgetMs: FLUSH_BUDGET_MS,
        },
      ),
    )
    last = performance.now()
    if (perf.enabled) perf.frame()
    if (queue.size > 0) schedule()
  }

  const schedule = () => {
    if (timer !== undefined) return
    const elapsed = performance.now() - last
    const interval = hidden ? HIDDEN_FLUSH_MS : FLUSH_FRAME_MS
    timer = setTimeout(() => flush(), Math.max(0, interval - elapsed))
  }

  let streamErrorLogged = false
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  let attempt: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  let generation = 0
  let reconnectFailures = 0

  const reconnectDelay = () => {
    const capped = Math.min(reconnectFailures, 6)
    const backoff = RECONNECT_BASE_MS * 2 ** capped
    const delay = Math.min(backoff, RECONNECT_MAX_MS)
    // Full jitter so N servers/clients don't retry in lockstep.
    return delay / 2 + Math.random() * (delay / 2)
  }

  const start = () => {
    if (started) return run
    started = true
    const active = ++generation
    const previous = run
    const current = (async () => {
      if (previous) await previous
      const streamKey = ServerConnection.key(server)
      // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
      while (!abort.signal.aborted && started && generation === active) {
        attempt = new AbortController()
        const onAbort = () => {
          attempt?.abort()
        }
        abort.signal.addEventListener("abort", onAbort)
        const connectedAt = performance.now()
        try {
          const kind = await protocol
          const events =
            kind === "v1"
              ? (await eventSdk.global.event({ signal: attempt.signal })).stream
              : eventApi.event.subscribe({ signal: attempt.signal })
          let yielded = Date.now()
          for await (const event of events) {
            // Any delivered domain frame proves the server is up; transport
            // heartbeats keep the socket alive but are not application events.
            markServerStreamLive(streamKey)
            streamErrorLogged = false
            const frameKind =
              "payload" in event
                ? String((event.payload as { type?: unknown }).type ?? "unknown")
                : String((event as { type?: unknown }).type ?? "unknown")
            const frameProps =
              "payload" in event
                ? (event.payload as { properties?: unknown }).properties
                : (event as { data?: unknown }).data
            const frameSession =
              frameProps !== null && typeof frameProps === "object"
                ? (frameProps as Record<string, unknown>).sessionID
                : undefined
            phaseTrace.frame(frameKind, typeof frameSession === "string" ? frameSession : undefined)
            // Readiness alone is not recovery: overflowing streams can reconnect,
            // deliver server.connected, and immediately fail again.
            if (performance.now() - connectedAt >= 30_000) reconnectFailures = 0
            const legacy = "payload" in event
            if (legacy && event.payload.type === "sync") {
              if (Date.now() - yielded >= STREAM_YIELD_MS) {
                await wait(0)
                yielded = Date.now()
              }
              continue
            }
            if (!shouldDispatchSessionStreamFrame(frameKind, frameSession, streamContentInterest)) {
              // The session authority records the missed-content fact before
              // returning false. Keep reading the socket, but skip adaptation,
              // byte accounting, coalescing, emitter fan-out and Solid work for
              // a delta no mounted timeline can consume.
              if (Date.now() - yielded >= STREAM_YIELD_MS) {
                await wait(0)
                yielded = Date.now()
              }
              continue
            }
            if (hidden && isSessionStreamContentEvent(frameKind)) {
              // While occluded there is no useful consumer for ANY
              // reconstructible timeline content, not merely token deltas.
              // Drop before legacy/native adaptation, queue byte accounting and
              // reducer fan-out; visible restoration hydrates only these exact
              // sessions from authoritative history.
              if (typeof frameSession === "string") {
                hiddenDirtySessions.add(frameSession)
                streamContentInvalidator?.(frameSession, false)
              } else hiddenDirtyGlobal = true
              if (Date.now() - yielded >= STREAM_YIELD_MS) {
                await wait(0)
                yielded = Date.now()
              }
              continue
            }
            const directory = legacy ? (event.directory ?? "global") : (event.location?.directory ?? "global")
            const payload = legacy ? (event.payload as Event) : adaptServerEvent(event)
            const dispatchedAt = performance.now()
            receive({ directory, payload })
            phaseTrace.dispatch(performance.now() - dispatchedAt)
            // A replay cursor that fell outside the server ring is a repair
            // signal, not a normal domain event. Keep the diagnostic frame,
            // then enqueue a connected barrier so directory/session stores
            // perform their existing snapshot hydration path immediately.
            if ((payload as { type?: string }).type === "server.stream.gap") {
              const gapProps =
                "properties" in payload
                  ? (payload.properties as Record<string, unknown> | undefined)
                  : (payload as { data?: Record<string, unknown> }).data
              phaseTrace.gap({ requested: gapProps?.requested, latest: gapProps?.latest })
              receive({
                directory,
                payload: { id: payload.id, type: "server.connected", properties: { repair: true } } as ServerEvent,
              })
            }
            schedule()
            // Do not stop pulling SSE because the renderer queue is busy. The
            // queue itself is bounded by both bytes and item count. Reconstructible
            // content pressure repairs only the affected session; only loss of
            // non-reconstructible state falls back to a global barrier. Sleeping here used to
            // turn local reducer pressure into TCP/server subscriber pressure,
            // which is precisely how several concurrent high-output sessions
            // could strand every stream behind one slow renderer.

            if (Date.now() - yielded < STREAM_YIELD_MS) continue
            yielded = Date.now()
            await wait(0)
          }
          if (!attempt.signal.aborted) {
            markServerStreamDead(streamKey)
            reconnectFailures++
            phaseTrace.reconnect({ failures: reconnectFailures })
          }
        } catch (error) {
          if (!isStreamClosed(error, attempt?.signal) && !streamErrorLogged) {
            streamErrorLogged = true
            console.error("[global-sdk] event stream failed", {
              url: server.http.url,
              fetch: eventFetch ? "platform" : "webview",
              error,
            })
          }
          // A genuine failure (not an intentional stop/abort) means the server is
          // unreachable: drop liveness so the health poll resumes its checks.
          if (!isStreamClosed(error, attempt?.signal)) {
            markServerStreamDead(streamKey)
            reconnectFailures++
            phaseTrace.reconnect({ failures: reconnectFailures })
          }
        } finally {
          abort.signal.removeEventListener("abort", onAbort)
          attempt = undefined
        }

        if (abort.signal.aborted || !started || generation !== active) return
        await wait(reconnectDelay())
      }
    })().finally(() => {
      if (run !== current) return
      run = undefined
      flush()
    })
    run = current
    return run
  }

  const stop = () => {
    started = false
    generation++
    attempt?.abort()
  }

  onMount(() => {
    makeEventListener(window, "pagehide", stop)
    makeEventListener(window, "pageshow", (event) => resumeStreamAfterPageShow(event, start))
    makeEventListener(document, "visibilitychange", () => {
      hidden = document.visibilityState === "hidden"
      if (hidden) {
        // Keep the stream alive, but do not spend renderer work reducing token
        // fragments while Chromium has throttled the window. Record exactly
        // which sessions lost reconstructible content instead of forcing every
        // active project through a global bootstrap on visibility restore.
        queue.dropWhere(
          (event) => isSessionStreamContentEvent(String(event.payload.type)),
          (event) => {
            const sessionID = serverEventSessionID(event.payload)
            if (sessionID) {
              hiddenDirtySessions.add(sessionID)
              streamContentInvalidator?.(sessionID, false)
            } else hiddenDirtyGlobal = true
          },
        )
        schedule()
        return
      }
      for (const sessionID of hiddenDirtySessions) streamContentInvalidator?.(sessionID, true)
      hiddenDirtySessions.clear()
      if (hiddenDirtyGlobal) {
        hiddenDirtyGlobal = false
        receive({
          directory: "global",
          payload: {
            id: "evt_visibility_refresh",
            type: "server.connected",
            properties: { repair: true },
          } as ServerEvent,
        })
      }
      flush()
    })
  })

  onCleanup(() => {
    stop()
    abort.abort()
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    // This context and all of its listeners are being destroyed. Replaying a
    // potentially thousands-event renderer backlog synchronously during teardown
    // cannot produce useful UI and turns navigation/close into a long task.
    queue.clear()
  })

  const sdk = createSdkForServer({
    server: server.http,
    fetch: platform.fetch,
    throwOnError: true,
  })
  const currentApi: ServerApi = createApiForServer({ server: server.http, fetch: platform.fetch })
  const legacy = (directory?: string) =>
    createSdkForServer({
      server: server.http,
      fetch: platform.fetch,
      throwOnError: true,
      directory,
    })
  const api = createCompatibleApi({ protocol, current: currentApi, legacy, server: server.http, fetch: platform.fetch })

  return {
    server,
    scope,
    protocol,
    protocolKind,
    url: server.http.url,
    fetch: platform.fetch,
    client: sdk,
    api,
    currentApi,
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start,
      setStreamContentInterest(interest, invalidate) {
        streamContentInterest = interest
        streamContentInvalidator = invalidate
        return () => {
          if (streamContentInterest === interest) streamContentInterest = undefined
          if (streamContentInvalidator === invalidate) streamContentInvalidator = undefined
        }
      },
    },
    createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
      return createSdkForServer({
        server: server.http,
        fetch: platform.fetch,
        ...opts,
      })
    },
  }
}

export type ServerSDK = ServerSDKBase & {
  ensureDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(server: ServerConnection.Any, scope: ServerScope): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope)
  return Object.assign(sdk, {
    ensureDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  // Returns an accessor so the resolved server can change reactively (e.g. a
  // /new-session draft retargeting its server) without re-instantiating the subtree.
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSDK>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sdk
    })
  },
})

export function useServerProtocol() {
  const serverSDK = useServerSDK()
  return createMemo(() => serverSDK().protocolKind())
}

type SDKEventMap = {
  [key in Event["type"]]: Extract<ServerEvent, { type: key }>
}

function createDirSdkContext(directory: string, serverSDK: ServerSDKBase) {
  const client = serverSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = serverSDK.event.on(directory, (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    scope: serverSDK.scope,
    protocol: serverSDK.protocol,
    directory,
    client,
    api: createCompatibleApi({
      protocol: serverSDK.protocol,
      current: serverSDK.currentApi,
      legacy: (next) => serverSDK.createClient({ directory: next ?? directory, throwOnError: true }),
      server: serverSDK.server.http,
      fetch: serverSDK.fetch,
      directory,
    }),
    event: emitter,
    get url() {
      return serverSDK.url
    },
    createClient(opts: Parameters<typeof serverSDK.createClient>[0]) {
      return serverSDK.createClient(opts)
    },
  }
}
