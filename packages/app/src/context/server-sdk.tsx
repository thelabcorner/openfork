import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { Event } from "@opencode-ai/sdk/v2/client"
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

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

const isStreamClosed = (error: unknown, signal?: AbortSignal) => isAbortError(error) || signal?.aborted === true
export type ServerEvent = Event & { current?: OpenCodeEvent }
type QueuedServerEvent = { directory: string; payload: ServerEvent }
type CurrentDelta = Extract<
  OpenCodeEvent,
  { type: "session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta" | "session.compaction.delta" }
>

export function adaptServerEvent(event: OpenCodeEvent): ServerEvent {
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

export function coalesceServerEvents(events: QueuedServerEvent[]) {
  const output: QueuedServerEvent[] = []
  // Pending V1 message.part.delta merges keyed by (directory, messageID, partID, field).
  // Unlike the previous adjacent-only merge, deltas for the SAME part/field may be
  // concatenated even when interleaved with deltas for OTHER parts/sessions — the
  // final store state is identical because each part's field is an independent
  // append-only string. Any non-delta event is a barrier (a snapshot/removal/status
  // can change a part's base), so pending merges never cross one.
  const pending = new Map<string, number>()
  events.forEach((event) => {
    const current = currentDelta(event.payload.current)
    if (current) {
      const previous = output[output.length - 1]
      const prior = currentDelta(previous?.payload.current)
      if (
        previous &&
        prior &&
        previous.directory === event.directory &&
        currentDeltaKey(prior) === currentDeltaKey(current)
      ) {
        const fragment = currentDeltaFragment(prior) + currentDeltaFragment(current)
        const data =
          current.type === "session.compaction.delta"
            ? { ...current.data, text: fragment }
            : { ...current.data, delta: fragment }
        output[output.length - 1] = {
          directory: event.directory,
          payload: {
            ...event.payload,
            properties: data,
            current: { ...current, data } as CurrentDelta,
          } as ServerEvent,
        }
        return
      }
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
    const key = `${event.directory}:${props.messageID}:${props.partID}:${props.field}`
    const existingIndex = pending.get(key)
    if (existingIndex !== undefined) {
      const previousProps = output[existingIndex].payload.properties as { delta: string }
      output[existingIndex] = {
        directory: event.directory,
        payload: {
          ...event.payload,
          properties: { ...props, delta: previousProps.delta + props.delta },
        },
      }
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

function currentDelta(event: OpenCodeEvent | undefined): CurrentDelta | undefined {
  if (
    event?.type === "session.text.delta" ||
    event?.type === "session.reasoning.delta" ||
    event?.type === "session.tool.input.delta" ||
    event?.type === "session.compaction.delta"
  )
    return event
}

function currentDeltaKey(event: CurrentDelta) {
  if (event.type === "session.tool.input.delta")
    return `${event.type}:${event.data.sessionID}:${event.data.assistantMessageID}:${event.data.callID}`
  if (event.type === "session.compaction.delta") return `${event.type}:${event.data.sessionID}`
  return `${event.type}:${event.data.sessionID}:${event.data.assistantMessageID}:${event.data.ordinal}`
}

function currentDeltaFragment(event: CurrentDelta) {
  return event.type === "session.compaction.delta" ? event.data.text : event.data.delta
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

  type Queued = QueuedServerEvent
  const FLUSH_FRAME_MS = 16
  const STREAM_YIELD_MS = 8
  const RECONNECT_DELAY_MS = 250
  // Delta accumulator tuning. Deltas that arrive for the same (session, message,
  // part, field) are folded in place and emitted as ONE event per flush instead of
  // one per delta, so the downstream reducer does a single large append rather than
  // many tiny ones (the dominant per-event cost is the string copy). A key flushes
  // early once its accumulated delta is large (burst coalescing) or has been pending
  // past MAX_AGE (keeps streaming responsive even for slow trickles); barriers and
  // the final flush always drain everything.
  const ACCUMULATOR_BURST_BYTES = 2048
  const ACCUMULATOR_MAX_AGE_MS = 100

  interface AccEntry {
    ev: Queued
    dirtySince: number
  }

  const v2 = new Map<string, Map<string, Map<string, Map<string, AccEntry>>>>()
  const v1 = new Map<string, Map<string, Map<string, Map<string, Map<string, AccEntry>>>>>()
  const dirtyV2 = new Set<AccEntry>()
  const dirtyV1 = new Set<AccEntry>()
  let singletons: Queued[] = []

  const nowMs = () => Date.now()

  function appendV2(existing: AccEntry, incoming: Queued) {
    const cur = existing.ev.payload.current as CurrentDelta
    const inc = incoming.payload.current as CurrentDelta
    const fragment = currentDeltaFragment(cur) + currentDeltaFragment(inc)
    if (cur.type === "session.compaction.delta") (cur.data as { text: string }).text = fragment
    else (cur.data as { delta: string }).delta = fragment
  }

  function v2Coords(cur: CurrentDelta): [string, string, string] {
    if (cur.type === "session.tool.input.delta")
      return [cur.data.sessionID, cur.data.assistantMessageID, cur.data.callID]
    if (cur.type === "session.compaction.delta") return [cur.data.sessionID, "", ""]
    return [cur.data.sessionID, cur.data.assistantMessageID, String(cur.data.ordinal)]
  }

  function removeV2(ev: Queued) {
    const cur = ev.payload.current as CurrentDelta
    const [s, m, o] = v2Coords(cur)
    const a = v2.get(ev.directory)
    const b = a?.get(s)
    const mm = b?.get(m)
    if (mm) {
      mm.delete(o)
      if (mm.size === 0) b?.delete(m)
      if (b && b.size === 0) a?.delete(s)
    }
  }

  function removeV1(ev: Queued) {
    const p = ev.payload.properties as { sessionID: string; messageID: string; partID: string; field: string }
    const a = v1.get(ev.directory)
    const b = a?.get(p.sessionID)
    const mm = b?.get(p.messageID)
    const pt = mm?.get(p.partID)
    if (pt) {
      pt.delete(p.field)
      if (pt.size === 0) mm?.delete(p.partID)
      if (mm && mm.size === 0) b?.delete(p.messageID)
      if (b && b.size === 0) a?.delete(p.sessionID)
    }
  }

  function dropSession(directory: string, sessionID: string) {
    const a = v2.get(directory)
    if (a) {
      const b = a.get(sessionID)
      if (b) {
        for (const mm of b.values()) for (const e of mm.values()) dirtyV2.delete(e)
        a.delete(sessionID)
      }
    }
    const va = v1.get(directory)
    if (va) {
      const vb = va.get(sessionID)
      if (vb) {
        for (const mm of vb.values()) for (const pt of mm.values()) for (const e of pt.values()) dirtyV1.delete(e)
        va.delete(sessionID)
      }
    }
  }

  const messagePartUpdatedProps = (ev: Queued) =>
    ev.payload.properties as unknown as { sessionID: string; messageID: string; part: { id: string } }
  const removedProps = (ev: Queued) => ev.payload.properties as unknown as { sessionID: string }

  function flushV2(directory: string, sessionID: string, messageID: string, ordinal: string) {
    const mm = v2.get(directory)?.get(sessionID)?.get(messageID)
    const entry = mm?.get(ordinal)
    if (entry) {
      singletons.push(entry.ev)
      mm!.delete(ordinal)
      dirtyV2.delete(entry)
    }
  }

  function flushV1(directory: string, sessionID: string, messageID: string, partID: string) {
    const mm = v1.get(directory)?.get(sessionID)?.get(messageID)
    const pt = mm?.get(partID)
    if (!pt) return
    for (const [field, entry] of pt) {
      singletons.push(entry.ev)
      dirtyV1.delete(entry)
      pt.delete(field)
    }
    if (pt.size === 0) mm!.delete(partID)
  }

  function handleBarrier(ev: Queued) {
    const type = ev.payload.type as string
    if (type === "message.part.updated") {
      const p = messagePartUpdatedProps(ev)
      flushV1(ev.directory, p.sessionID, p.messageID, p.part.id)
      singletons.push(ev)
      return
    }
    if (
      type === "session.text.ended" ||
      type === "session.reasoning.ended" ||
      type === "session.tool.input.ended" ||
      type === "session.compaction.ended"
    ) {
      const cur = ev.payload.current as CurrentDelta | undefined
      if (cur) {
        const [s, m, o] = v2Coords(cur)
        flushV2(ev.directory, s, m, o)
      }
      singletons.push(ev)
      return
    }
    if (type === "message.removed" || type === "session.deleted") {
      dropSession(ev.directory, removedProps(ev).sessionID)
      singletons.push(ev)
      return
    }
    singletons.push(ev)
  }

  function receive(ev: Queued) {
    const cur = currentDelta(ev.payload.current)
    if (cur) {
      const [s, m, o] = v2Coords(cur)
      let a = v2.get(ev.directory)
      if (!a) { a = new Map(); v2.set(ev.directory, a) }
      let b = a.get(s)
      if (!b) { b = new Map(); a.set(s, b) }
      let mm = b.get(m)
      if (!mm) { mm = new Map(); b.set(m, mm) }
      const ex = mm.get(o)
      if (ex) appendV2(ex, ev)
      else {
        const entry: AccEntry = { ev, dirtySince: nowMs() }
        mm.set(o, entry)
        dirtyV2.add(entry)
      }
      return
    }
    if (ev.payload.type === "message.part.delta") {
      const p = ev.payload.properties as { sessionID: string; messageID: string; partID: string; field: string; delta: string }
      let a = v1.get(ev.directory)
      if (!a) { a = new Map(); v1.set(ev.directory, a) }
      let b = a.get(p.sessionID)
      if (!b) { b = new Map(); a.set(p.sessionID, b) }
      let mm = b.get(p.messageID)
      if (!mm) { mm = new Map(); b.set(p.messageID, mm) }
      let pt = mm.get(p.partID)
      if (!pt) { pt = new Map(); mm.set(p.partID, pt) }
      const ex = pt.get(p.field)
      if (ex) (ex.ev.payload.properties as { delta: string }).delta += p.delta
      else {
        const entry: AccEntry = { ev, dirtySince: nowMs() }
        pt.set(p.field, entry)
        dirtyV1.add(entry)
      }
      return
    }
    handleBarrier(ev)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  const flush = (final = false) => {
    if (timer) { clearTimeout(timer); timer = undefined }
    if (dirtyV2.size === 0 && dirtyV1.size === 0 && singletons.length === 0) return

    const t = nowMs()
    batch(() => {
      for (const entry of [...dirtyV2]) {
        const cur = entry.ev.payload.current as CurrentDelta
        const bytes = cur.type === "session.compaction.delta"
          ? String((cur.data as { text: string }).text).length
          : String((cur.data as { delta: string }).delta).length
        if (final || bytes >= ACCUMULATOR_BURST_BYTES || t - entry.dirtySince >= ACCUMULATOR_MAX_AGE_MS) {
          emitter.emit(entry.ev.directory, entry.ev.payload)
          removeV2(entry.ev)
          dirtyV2.delete(entry)
        }
      }
      for (const entry of [...dirtyV1]) {
        const delta = (entry.ev.payload.properties as { delta: string }).delta
        if (final || delta.length >= ACCUMULATOR_BURST_BYTES || t - entry.dirtySince >= ACCUMULATOR_MAX_AGE_MS) {
          emitter.emit(entry.ev.directory, entry.ev.payload)
          removeV1(entry.ev)
          dirtyV1.delete(entry)
        }
      }
      for (const ev of singletons) emitter.emit(ev.directory, ev.payload)
    })
    singletons = []
    last = t
    if (perf.enabled) perf.frame()
    // Pending deltas that haven't reached the burst/age threshold stay retained
    // for the next window; keep the flush cadence alive so they drain within
    // MAX_AGE even when the stream is momentarily idle (no new receive()).
    if (dirtyV2.size > 0 || dirtyV1.size > 0) schedule()
  }

  const schedule = () => {
    if (timer) return
    const elapsed = nowMs() - last
    timer = setTimeout(() => flush(false), Math.max(0, FLUSH_FRAME_MS - elapsed))
  }

  let streamErrorLogged = false
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  let attempt: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  let generation = 0

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
        try {
          const kind = await protocol
          const events =
            kind === "v1"
              ? (await eventSdk.global.event({ signal: attempt.signal })).stream
              : eventApi.event.subscribe({ signal: attempt.signal })
          let yielded = Date.now()
          for await (const event of events) {
            // Any delivered event (including the 10s server heartbeat) proves the
            // server is up; the health poll reads this to skip its own request.
            markServerStreamLive(streamKey)
            streamErrorLogged = false
            const legacy = "payload" in event
            if (legacy && event.payload.type === "sync") continue
            const directory = legacy ? (event.directory ?? "global") : (event.location?.directory ?? "global")
            const payload = legacy ? (event.payload as Event) : adaptServerEvent(event)
            receive({ directory, payload })
            schedule()

            if (Date.now() - yielded < STREAM_YIELD_MS) continue
            yielded = Date.now()
            await wait(0)
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
          if (!isStreamClosed(error, attempt?.signal)) markServerStreamDead(streamKey)
        } finally {
          abort.signal.removeEventListener("abort", onAbort)
          attempt = undefined
        }

        if (abort.signal.aborted || !started || generation !== active) return
        await wait(RECONNECT_DELAY_MS)
      }
    })().finally(() => {
      if (run !== current) return
      run = undefined
      flush(true)
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
  })

  onCleanup(() => {
    stop()
    abort.abort()
    flush(true)
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
