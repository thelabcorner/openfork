import type {
  OpencodeClient,
  PermissionV2Reply,
  PermissionV2Request,
  Project,
  Provider,
  QuestionV2Request,
  Session,
} from "@opencode-ai/sdk/v2/client"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { PairingCamera } from "./PairingCamera"
import { WebHaptics } from "web-haptics"
import { IconArchive, IconClose, IconPlus, IconTrash } from "./icons"
import { ChatView } from "./views/ChatView"
import { LimitsView, type LimitsProviderData, type OpenRouterFree, type PerKeyEntry } from "./views/LimitsView"
import type { UsageWindow } from "./limits-format"
import { sortWindows, splitWorkBuddyWindows } from "./limits-format"
import { SessionsView } from "./views/SessionsView"
import { SettingsView } from "./views/SettingsView"
import type { SessionRuntime } from "./components/SessionRow"
import type { RuntimeStatus } from "./components/SessionStatus"
import { disableNotifications, reconcilePushSubscription } from "./push"
import {
  DEVICE_ID_KEY,
  DEVICE_TOKEN_KEY,
  INSTANCE_ID_KEY,
  SERVER_URL_KEY,
  claimPair,
  clearStorage,
  compareInstance,
  createClient,
  fetchIdentity,
  normalizeServerUrl,
  openEvents,
  pairClaimErrorMessage,
  readLaunchConfig,
  readStorage,
  writeStorage,
  type InstanceIdentity,
  type MessageBundle,
} from "./api"
import { mockEnabled, mockMessages, mockProviders, mockQuota, mockSessions, mockArchived } from "./devMock"
import { MessageStreamProjection } from "./messageStream"
import { MessageEventQueue } from "./messageEventQueue"
import { normalizeLegacyProviders } from "./providerCatalog"
import { activeReconcilePlan, mapBounded, type MobileEventChannel } from "./activeReconcile"
import { createModelPreferences, subProviderKeyFor } from "./modelPreferences"
import { recordPersonalCosts } from "./model-ranking"
import { createEndpointsFetcher } from "./openrouter-endpoints"
import { sessionIDFromNavigationUrl } from "./navigation"

type Page = "sessions" | "limits" | "settings"
type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

function pwaOrigin() {
  try {
    const meta = import.meta as unknown as { env?: Record<string, string> }
    const cfg = (meta.env?.OPENCODE_PWA_URL ?? "") as string
    if (cfg?.trim()) return cfg.trim()
  } catch {}
  try {
    return window.location.origin
  } catch {
    return "this device"
  }
}

const PAIR_CODE_LENGTH = 6

function PairingCodeInput(props: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const refs: (HTMLInputElement | undefined)[] = []

  const chars = createMemo(() => {
    const arr = props.value.toUpperCase().split("").slice(0, PAIR_CODE_LENGTH)
    while (arr.length < PAIR_CODE_LENGTH) arr.push("")
    return arr
  })

  const setFrom = (index: number, raw: string) => {
    const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "")
    const next = chars().slice()
    if (clean.length > 1) {
      for (let j = 0; j < clean.length && index + j < PAIR_CODE_LENGTH; j++) next[index + j] = clean[j] ?? ""
      props.onChange(next.join("").replace(/\s+$/, ""))
      refs[Math.min(index + clean.length, PAIR_CODE_LENGTH - 1)]?.focus()
      return
    }
    next[index] = clean
    props.onChange(next.join("").replace(/\s+$/, ""))
    if (clean && index < PAIR_CODE_LENGTH - 1) refs[index + 1]?.focus()
  }

  const handleKeyDown = (index: number, e: KeyboardEvent) => {
    if (e.key === "Backspace" && !chars()[index] && index > 0) {
      refs[index - 1]?.focus()
      setFrom(index - 1, "")
    }
  }

  return (
    <div class="otp-row">
      <For each={chars()}>
        {(ch, index) => (
          <input
            ref={(el) => {
              refs[index()] = el
            }}
            class="otp-box"
            value={ch}
            inputmode="text"
            autocapitalize="characters"
            autocomplete="off"
            disabled={props.disabled}
            onInput={(e) => setFrom(index(), (e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => handleKeyDown(index(), e)}
          />
        )}
      </For>
    </div>
  )
}

export function App() {
  const launch = readLaunchConfig()
  // `notificationclick` opens this exact path when no PWA window exists. Keep
  // the target pending until a client is connected so cold push navigation does
  // not race bootstrap or render a session shell without its message snapshot.
  let pendingNavigationSessionID = sessionIDFromNavigationUrl(location.href, location.origin)
  const [state, setState] = createStore({
    serverUrl: launch.serverUrl ?? "",
    token: readStorage(DEVICE_TOKEN_KEY) ?? "",
    status: "disconnected" as ConnectionStatus,
    serverVersion: "",
    identity: undefined as InstanceIdentity | undefined,
    page: "sessions" as Page,
    sessions: [] as Session[],
    archivedSessions: [] as Session[],
    activeSessionID: undefined as string | undefined,
    messages: [] as MessageBundle[],
    draft: "",
    error: "",
    pairing: launch.pairCode ?? "",
    contextMenuOpen: false,
    contextMenuSessionID: undefined as string | undefined,
  })

  const [runtimes, setRuntimes] = createStore<Record<string, SessionRuntime>>({})
  const [permissions, setPermissions] = createStore<Record<string, PermissionV2Request[]>>({})
  const [questions, setQuestions] = createStore<Record<string, QuestionV2Request[]>>({})
  const [providers, setProviders] = createSignal<Provider[]>([])
  const [projectsList, setProjectsList] = createSignal<Project[]>([])
  const [quotaData, setQuotaData] = createSignal<LimitsProviderData[]>([])
  const [quotaLoading, setQuotaLoading] = createSignal(false)
  const [quotaUpdatedAt, setQuotaUpdatedAt] = createSignal<number | undefined>(undefined)
  const [openRouterFree, setOpenRouterFree] = createSignal<OpenRouterFree | undefined>(undefined)

  // Don't default to camera when we have a stored device token – that would
  // trigger getUserMedia on every launch before the auto-connect finishes.
  const hasStoredToken = () => !!readStorage(DEVICE_TOKEN_KEY)
  const [pairMode, setPairMode] = createSignal<"scan" | "code">(
    state.pairing ? "code" : hasStoredToken() && !!state.serverUrl.trim() ? "code" : "scan",
  )
  const [advancedOpen, setAdvancedOpen] = createSignal(false)
  const [howOpen, setHowOpen] = createSignal(false)
  const [deferredPrompt, setDeferredPrompt] = createSignal<any>(null)
  const [messageStructureRevision, setMessageStructureRevision] = createSignal(0)
  const canClaim = () => state.pairing.trim().length === PAIR_CODE_LENGTH
  const canConnect = () => !state.pairing && !!state.token.trim() && !!state.serverUrl.trim()
  const submitDisabled = () => state.status === "connecting" || (!canClaim() && !canConnect())
  const submitLabel = () => (state.status === "connecting" ? "Connecting…" : canClaim() ? "Claim device" : "Connect")
  const isReconnecting = () => state.status === "connecting" && hasStoredToken() && !!state.serverUrl.trim()

  let client: OpencodeClient | undefined
  let eventsAbort: AbortController | undefined
  let eventChannel: MobileEventChannel = "current"
  let eventChannelResolved = false
  const eventCursors = new Map<"current" | "compatibility", string>()

  // Model-selector preferences shared with the desktop through the server, so
  // this device shows the same provider rail order, favorites and routing pins.
  const modelPreferences = createModelPreferences({ client: () => client })
  const fetchModelEndpoints = createEndpointsFetcher(() => client)
  let refreshInFlight = false
  let refreshPending = false
  let messageRevision = 0
  let messageRequest = 0
  let streamFrame: number | undefined
  const pendingMessageEvents = new MessageEventQueue()
  const messageProjection = new MessageStreamProjection()
  const staleMessageSessions = new Set<string>()
  const runtimeRevision = new Map<string, number>()
  const haptics = new WebHaptics({})

  const activeSession = createMemo(
    () =>
      state.sessions.find((s) => s.id === state.activeSessionID) ??
      state.archivedSessions.find((s) => s.id === state.activeSessionID),
  )
  const contextMenuSession = createMemo(() =>
    [...state.sessions, ...state.archivedSessions].find((s) => s.id === state.contextMenuSessionID),
  )

  // haptic helpers
  function triggerHaptic(input: "selection" | "soft" | "light" | "warning" | "success") {
    try {
      haptics.trigger(input)
    } catch {
      /* ignore */
    }
  }
  let lastDeltaHaptic = 0
  let deltaCount = 0
  function triggerDeltaHaptic(text = "") {
    const now = Date.now()
    deltaCount += Math.max(1, text.length)
    const boundary = /[.!?]\s?$|\n$/.test(text)
    if (!boundary && deltaCount % 4 !== 0) return
    if (now - lastDeltaHaptic < (boundary ? 110 : 85)) return
    lastDeltaHaptic = now
    try {
      haptics.trigger(boundary ? "light" : "soft")
    } catch {}
  }

  const contextTotalFor = (session: Session): number => {
    if (!session.model) return 0
    const prov =
      providers().find((p) => p.id === session.model!.providerID) ??
      providers().find((p) => p.id.toLowerCase() === session.model!.providerID.toLowerCase())
    if (!prov) return 0
    const models = prov.models as Record<string, any>
    const rawId = session.model.id
    const bareId = rawId.includes("/") ? rawId.split("/").pop()! : rawId
    const candidates = [rawId, bareId, rawId.toLowerCase(), bareId.toLowerCase()]
    let model: any
    for (const c of candidates) {
      if (c && models[c]) {
        model = models[c]
        break
      }
    }
    if (!model) {
      model = Object.values(models).find(
        (m: any) => m.id === rawId || m.name === rawId || m.id === bareId || m.name === bareId,
      )
    }
    if (!model) return 0
    const limit = model.limit ?? model._raw?.limit
    if (limit && typeof limit.context === "number" && limit.context > 0) return limit.context
    if (limit && typeof limit.contextWindow === "number" && limit.contextWindow > 0) return limit.contextWindow
    return 0
  }

  const contextTotals = createMemo(() => {
    const provs = providers()
    provs.length
    const derived: Record<string, number> = {}
    for (const s of [...state.sessions, ...state.archivedSessions] as Session[]) {
      const total = contextTotalFor(s)
      if (total) derived[s.id] = total
    }
    return derived
  })
  const recomputeContextTotals = () => {}
  const setContextTotals = (_: Record<string, number>) => {}

  const loadProjects = async () => {
    if (!client) return
    try {
      const res: any = await (client as any).project?.list?.({}, { throwOnError: true })
      const list: Project[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
      if (list.length) setProjectsList(list)
    } catch {}
  }

  // Optimized: try V2 cursor pagination first (global, cross-project, as desktop does),
  // fallback to legacy offset pagination. V2 returns SessionV2Info -> mapped to
  // legacy Session shape for SessionRow. Single large page covers 95% of users
  // (1 RTT), second page only if >500 sessions. Soft cap 2000 to avoid 7GB DB stalls.
  const mapV2ToSession = (v: any): Session =>
    ({
      id: v.id,
      slug: v.id,
      projectID: v.projectID,
      version: "v2",
      directory: v.location?.directory ?? v.directory ?? "",
      path: v.subpath,
      title: v.title,
      cost: v.cost,
      tokens: v.tokens,
      time: v.time,
      model: v.model
        ? { id: v.model.modelID ?? v.model.id, providerID: v.model.providerID, variant: v.model.variant }
        : undefined,
      summary: v.summary,
      parentID: v.parentID,
      agent: v.agent,
    }) as unknown as Session

  const fetchAllSessions = async (opts: { archived?: boolean } = {}) => {
    if (!client) return [] as Session[]
    const SOFT_CAP = 2000
    // Try V2 cursor pagination first — global, cross-project, as desktop does.
    // V2 has no archived filter, so we fetch and filter client-side.
    try {
      const v2 = (client as any).v2?.session as any
      if (v2?.list) {
        const all: Session[] = []
        let cursor: string | undefined
        for (let page = 0; page < 4; page++) {
          const limit = 500
          const res: any = await v2.list(
            { limit, order: "desc", ...(cursor ? { cursor } : {}) },
            { throwOnError: true },
          )
          if (!opts.archived && !eventChannelResolved) {
            eventChannel = "current"
            eventChannelResolved = true
          }
          const payload: any = res?.data ?? res
          const batch: any[] = payload?.data ?? payload ?? []
          const next: string | undefined = payload?.cursor?.next ?? res?.cursor?.next
          if (!Array.isArray(batch) || batch.length === 0) break
          const mapped = batch.map(mapV2ToSession)
          const filtered = opts.archived
            ? mapped.filter((s) => (s.time as any)?.archived)
            : mapped.filter((s) => !(s.time as any)?.archived)
          all.push(...filtered)
          // Stop when server has no more pages, or we hit soft cap, or this page was short
          // and we already have some filtered results (avoid extra RTT for edge case where
          // a page was mostly archived when asking active)
          if (!next || batch.length < limit || all.length >= SOFT_CAP) break
          cursor = next
        }
        // A successful V2 list is also our capability/protocol proof. An empty
        // active result can legitimately mean every row is archived; falling
        // through to legacy here would reopen the compatibility transport and
        // keep its server-side bridge alive for no semantic benefit.
        return [...new Map(all.map((s) => [s.id, s] as const)).values()]
      }
    } catch {
      if (!opts.archived && !eventChannelResolved) {
        eventChannel = "compatibility"
        eventChannelResolved = true
      }
    }
    // Fallback: legacy experimental offset pagination (supports archived:true server-side)
    const PAGE = 500
    const all: Session[] = []
    let start: number | undefined = 0
    for (let page = 0; page < 4; page++) {
      const res: any = await (client as any).session.list(
        { limit: PAGE, start, ...(opts.archived ? { archived: true } : {}) },
        { throwOnError: true },
      )
      const batch: Session[] = res?.data ?? []
      if (!Array.isArray(batch) || batch.length === 0) break
      all.push(...batch)
      if (batch.length < PAGE || all.length >= SOFT_CAP) break
      start = (start ?? 0) + batch.length
    }
    return [...new Map(all.map((s) => [s.id, s] as const)).values()]
  }

  const refresh = async () => {
    if (!client) return
    if (refreshInFlight) {
      refreshPending = true
      return
    }
    refreshInFlight = true
    try {
      do {
        refreshPending = false
        const all = await fetchAllSessions()
        if (all.length || !state.sessions.length) {
          setState("sessions", all)
          recomputeContextTotals()
        }
      } while (refreshPending)
    } catch {
    } finally {
      refreshInFlight = false
    }
  }

  const setRuntime = (sessionID: string, runtime: SessionRuntime) => {
    const previous = runtimes[sessionID]
    if (
      previous?.status === runtime.status &&
      previous.permissions === runtime.permissions &&
      previous.questions === runtime.questions &&
      previous.busySince === runtime.busySince
    ) return
    runtimeRevision.set(sessionID, (runtimeRevision.get(sessionID) ?? 0) + 1)
    setRuntimes(sessionID, runtime)
  }

  const reconcileActiveSessions = async (source: OpencodeClient) => {
    const started = new Map(runtimeRevision)
    try {
      const plan = activeReconcilePlan(state.sessions, eventChannel)
      const currentResult =
        plan.currentSnapshot
          ? await source.v2.session.active({ throwOnError: true }).catch(() => undefined)
          : undefined
      let compatibilityResults: any[] = []
      // Old/compatibility servers still expose status per directory. Bound the
      // fanout instead of issuing hundreds of simultaneous requests from one
      // phone; native V2 mode takes the single server-global active snapshot.
      if (plan.legacyDirectories.length) {
        compatibilityResults = await mapBounded(plan.legacyDirectories, 4, (directory) =>
          source.session.status({ directory }, { throwOnError: true }).catch(() => undefined),
        )
      }
      const current: Record<string, { type: "running" | "paused" }> =
        (currentResult as any)?.data?.data ?? (currentResult as any)?.data ?? {}
      const compatibility = Object.assign(
        {},
        ...compatibilityResults.map((result: any) => result?.data ?? {}),
      ) as Record<string, { type: "idle" | "busy" | "retry" }>
      const active: Record<string, { type: "running" | "paused" }> = {
        ...Object.fromEntries(
          Object.entries(compatibility)
            .filter(([, status]) => status.type !== "idle")
            .map(([sessionID]) => [sessionID, { type: "running" as const }]),
        ),
        ...current,
      }
      const known = new Set([...state.sessions, ...state.archivedSessions].map((session) => session.id))
      const protocolByID = new Map([...state.sessions, ...state.archivedSessions].map((session) => [session.id, session.version] as const))
      if (Object.keys(active).some((sessionID) => !known.has(sessionID))) void refresh()
      for (const sessionID of new Set([...known, ...Object.keys(runtimes), ...Object.keys(active)])) {
        // If the native active endpoint itself is unavailable, legacy directory
        // snapshots cannot authoritatively declare a V2 row idle.
        if (protocolByID.get(sessionID) === "v2" && !currentResult) continue
        // A status event received after this request began is newer than the snapshot.
        if ((runtimeRevision.get(sessionID) ?? 0) !== (started.get(sessionID) ?? 0)) continue
        const permissionsCount = permissions[sessionID]?.length ?? 0
        const questionsCount = questions[sessionID]?.length ?? 0
        const current = runtimes[sessionID]
        if (permissionsCount > 0 || current?.status === "waiting_permission") {
          setRuntime(sessionID, {
            status: "waiting_permission",
            permissions: permissionsCount,
            questions: questionsCount,
          })
          continue
        }
        if (questionsCount > 0 || current?.status === "waiting_question") {
          setRuntime(sessionID, {
            status: "waiting_question",
            permissions: permissionsCount,
            questions: questionsCount,
          })
          continue
        }
        if (active[sessionID]?.type === "running") {
          setRuntime(sessionID, {
            status: "generating",
            permissions: permissionsCount,
            questions: questionsCount,
            busySince: current?.busySince ?? Date.now(),
          })
          continue
        }
        // Don't clobber a recently-set optimistic generating (send() just set
        // busySince). Server's active snapshot can lag 1-2s behind the prompt.
        if (current?.status === "generating" && current.busySince && Date.now() - current.busySince < 8000) {
          continue
        }
        setRuntime(sessionID, { status: "idle", permissions: permissionsCount, questions: questionsCount })
      }
    } catch {
      // Older servers may not expose the active snapshot. Live status events
      // remain useful, so a snapshot failure must not tear down the stream.
    }
  }

  const refreshArchived = async () => {
    if (!client) return
    try {
      const all = await fetchAllSessions({ archived: true })
      setState("archivedSessions", all)
      recomputeContextTotals()
    } catch {}
  }

  const refreshMessages = async (sessionID = state.activeSessionID) => {
    if (!client || !sessionID) return
    const request = ++messageRequest
    const revision = messageRevision
    try {
      const response = await client.session.messages({ sessionID, limit: 100 }, { throwOnError: true })
      if (request !== messageRequest || sessionID !== state.activeSessionID || revision !== messageRevision) return
      if (response.data) {
        const bundles = response.data as MessageBundle[]
        messageProjection.reset(bundles)
        setMessageStructureRevision((value) => value + 1)
        setState("messages", bundles)
        // Feeds the model selector's personal $/request and cache-hit-rate
        // ranking. The desktop learns this from a durable cross-session store;
        // the phone accumulates it from the sessions it actually opens, which
        // converges for the models the user runs from here.
        recordPersonalCosts(bundles)
      }
    } catch (e) {
      setState("error", e instanceof Error ? e.message : "Failed to load messages")
    }
  }

  const flushMessageEvents = () => {
    if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
    streamFrame = undefined
    const events = pendingMessageEvents.drain()
    if (!events.length) return
    let changed = false
    let topologyChanged = false
    let structureChanged = false
    const changedMessages = new Set<number>()
    let hapticText = ""
    for (const event of events) {
      const result = messageProjection.apply(event.type, event.props)
      changed ||= result.changed
      topologyChanged ||= !!result.topology
      structureChanged ||= !!result.structure
      if (result.messageIndex !== undefined) changedMessages.add(result.messageIndex)
      if (result.stale) {
        const sessionID = eventSessionID(event.props)
        if (sessionID) staleMessageSessions.add(sessionID)
      }
      if (event.type.endsWith(".delta")) hapticText += event.props.delta ?? ""
    }
    if (changed) {
      messageRevision++
      if (topologyChanged) {
        // Structural mutations are rare and can shift indexes. Publish one
        // detached snapshot at that boundary, then return to per-message writes.
        setState("messages", messageProjection.messages.slice())
      } else {
        // Token-rate work updates only the exact changed message. The Solid
        // store's outer history topology stays stable, so historical rows and
        // history-wide memos do not wake merely because one tail part grew.
        for (const index of changedMessages) {
          const bundle = messageProjection.messages[index]
          if (bundle) setState("messages", index, bundle)
        }
      }
      if (structureChanged) setMessageStructureRevision((value) => value + 1)
      if (hapticText) triggerDeltaHaptic(hapticText)
    }
    const active = state.activeSessionID
    if (active && staleMessageSessions.has(active)) {
      staleMessageSessions.delete(active)
      void refreshMessages(active)
    }
  }

  const queueMessageEvent = (type: string, props: any) => {
    const isDelta = type.endsWith(".delta")
    if (!isDelta) flushMessageEvents()
    if (isDelta && document.visibilityState !== "visible") {
      // Reconstructible content must not accumulate while rAF is suspended.
      // Replay remains authoritative; if this renderer intentionally skips
      // content, mark only the visible session for repair on foreground.
      const sessionID = eventSessionID(props)
      if (sessionID) staleMessageSessions.add(sessionID)
      return
    }
    const admission = pendingMessageEvents.push({ type, props })
    if (!admission.accepted) {
      for (const sessionID of admission.staleSessions) staleMessageSessions.add(sessionID)
      if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
      streamFrame = undefined
      return
    }
    if (!isDelta) {
      flushMessageEvents()
      return
    }
    if (streamFrame === undefined) streamFrame = requestAnimationFrame(flushMessageEvents)
  }

  // Declared above every reader: `refreshPermissions` and the event loop
  // both call it, and both sit earlier in this function.
  const [autoAcceptSessions, setAutoAcceptSessions] = createSignal<Set<string>>(new Set())
  const permissionRefreshes = new Map<string, Promise<void>>()
  const permissionRefreshDirty = new Set<string>()
  const questionRefreshes = new Map<string, Promise<void>>()
  const questionRefreshDirty = new Set<string>()

  const refreshPermissionsOnce = async (sessionID: string) => {
    if (!client) return
    try {
      const res = await (client.session as any).permission.list({ sessionID }, { throwOnError: true })
      const list = res?.data ?? []
      if (autoAcceptSessions().has(sessionID) && list.length > 0) {
        for (const req of list) {
          try {
            await (client.session as any).permission.reply(
              { sessionID, requestID: req.id, reply: "once" },
              { throwOnError: true },
            )
          } catch (e) {
            console.error("auto-accept permission reply failed", sessionID, req.id, e)
          }
        }
        triggerHaptic("soft")
        const res2 = await (client.session as any).permission.list({ sessionID }, { throwOnError: true })
        setPermissions(sessionID, res2?.data ?? [])
        return
      }
      setPermissions(sessionID, list)
    } catch (e) {
      console.error("refreshPermissions failed", sessionID, e)
      setPermissions(sessionID, [])
    }
  }
  const refreshPermissions = (sessionID: string) => {
    const current = permissionRefreshes.get(sessionID)
    if (current) {
      permissionRefreshDirty.add(sessionID)
      return current
    }
    const work = (async () => {
      do {
        permissionRefreshDirty.delete(sessionID)
        await refreshPermissionsOnce(sessionID)
      } while (permissionRefreshDirty.delete(sessionID))
    })().finally(() => permissionRefreshes.delete(sessionID))
    permissionRefreshes.set(sessionID, work)
    return work
  }

  const refreshQuestionsOnce = async (sessionID: string) => {
    if (!client) return
    try {
      const res = await (client.session as any).question.list({ sessionID }, { throwOnError: true })
      if (res?.data) setQuestions(sessionID, res.data)
      else setQuestions(sessionID, [])
    } catch (e) {
      console.error("refreshQuestions failed", sessionID, e)
      setQuestions(sessionID, [])
    }
  }
  const refreshQuestions = (sessionID: string) => {
    const current = questionRefreshes.get(sessionID)
    if (current) {
      questionRefreshDirty.add(sessionID)
      return current
    }
    const work = (async () => {
      do {
        questionRefreshDirty.delete(sessionID)
        await refreshQuestionsOnce(sessionID)
      } while (questionRefreshDirty.delete(sessionID))
    })().finally(() => questionRefreshes.delete(sessionID))
    questionRefreshes.set(sessionID, work)
    return work
  }

  const loadProviders = async () => {
    if (!client) return
    // Try legacy /provider first (includes models)
    try {
      const res: any = await (client as any).provider?.list?.({}, { throwOnError: true })
      const list = normalizeLegacyProviders(res?.data ?? res)
      if (list.length && list.some((p: any) => p.models && Object.keys(p.models).length > 0)) {
        setProviders(list)
        recomputeContextTotals()
        return
      }
      if (list.length) {
        // legacy returned providers but no models — keep them and try to enrich via V2 models
        // fall through to V2 enrichment
      }
    } catch {}
    // Fallback: V2 /api/provider + /api/model (concurrent, 1 RTT each)
    try {
      const c: any = client as any
      const [provRes, modelRes] = await Promise.all([
        c.v2?.provider?.list?.({}, { throwOnError: true }),
        c.v2?.model?.list?.({}, { throwOnError: true }),
      ])
      const v2Providers: any[] = provRes?.data?.data ?? provRes?.data ?? []
      const v2Models: any[] = modelRes?.data?.data ?? modelRes?.data ?? []
      if (v2Providers.length) {
        // Group models by provider
        const byProvider = new Map<string, any[]>()
        for (const m of v2Models) {
          const pid = m.providerID ?? m.provider ?? "unknown"
          if (!byProvider.has(pid)) byProvider.set(pid, [])
          byProvider.get(pid)!.push(m)
        }
        const merged: Provider[] = v2Providers.map((p: any) => {
          const ms = byProvider.get(p.id) ?? []
          const modelsMap: Record<string, any> = {}
          for (const m of ms) {
            const mid = m.id ?? m.modelID ?? m.name
            if (!mid) continue
            // Map V2 ModelV2Info -> legacy Provider["models"][id] shape expected by ModelPicker
            const baseCost = Array.isArray(m.cost) ? (m.cost.find((c: any) => !c.tier) ?? m.cost[0]) : m.cost
            const v2Caps: any = m.capabilities ?? {}
            const inputArr: string[] = Array.isArray(v2Caps.input) ? v2Caps.input : []
            const rawLimit: any = (m as any).limit ?? (m as any)._raw?.limit ?? {}
            const limit = {
              context:
                rawLimit.context ?? rawLimit.contextWindow ?? (m as any).context ?? (m as any).contextWindow ?? 0,
              output: rawLimit.output ?? rawLimit.maxOutputTokens ?? (m as any).output ?? 0,
            }
            const legacy = {
              id: m.id,
              name: m.name ?? mid,
              cost: baseCost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
              limit,
              capabilities: {
                reasoning: (v2Caps.reasoning ??
                  (inputArr.includes("reasoning") || inputArr.includes("thinking") || false)) as boolean,
                input: { image: inputArr.includes("image") || !!v2Caps.input?.image },
                tools: v2Caps.tools ?? true,
              },
              variants: m.variants
                ? Array.isArray(m.variants)
                  ? Object.fromEntries(m.variants.map((v: any) => [v.id, v]))
                  : m.variants
                : undefined,
              // keep original for debugging
              _raw: m,
            }
            modelsMap[mid] = legacy
          }
          // Preserve legacy shape so ModelPicker/SettingsView work unchanged
          return {
            id: p.id,
            name: p.name,
            source: "custom",
            key: "v2",
            models: modelsMap,
          } as unknown as Provider
        })
        if (merged.length) {
          setProviders(merged)
          recomputeContextTotals()
          return
        }
      }
      // Last resort: use whatever legacy returned even without models
      const legacyRes: any = await (client as any).provider?.list?.({}, { throwOnError: true }).catch(() => null)
      const legacyList = normalizeLegacyProviders(legacyRes?.data ?? legacyRes)
      if (legacyList.length) {
        setProviders(legacyList)
        recomputeContextTotals()
      }
    } catch {}
  }

  const forkWindowToUsageWindow = (w: {
    label: string
    spentUSD: number
    limitUSD: number
    estimatedPercent?: number
    resetsAt: number
  }): UsageWindow => {
    const used =
      typeof w.estimatedPercent === "number"
        ? Math.max(0, Math.min(100, w.estimatedPercent))
        : w.limitUSD > 0
          ? Math.max(0, Math.min(100, (w.spentUSD / w.limitUSD) * 100))
          : null
    const seconds: Record<string, number> = { "5h": 18_000, week: 604_800, month: 2_592_000 }
    return {
      usedPercent: used,
      remainingPercent: used !== null ? Math.max(0, Math.min(100, 100 - used)) : null,
      windowSeconds: seconds[w.label] ?? null,
      resetAt: w.resetsAt,
      resetAfterSeconds: null,
      valueLabel: null,
    }
  }

  const loadForkPerKey = async (): Promise<PerKeyEntry[] | undefined> => {
    if (!state.serverUrl || !state.token) return undefined
    try {
      const headers = { Authorization: `Basic ${btoa(`device:${state.token}`)}`, "content-type": "application/json" }
      const [credsRes, usageRes] = await Promise.all([
        fetch(new URL("/fork/credential", state.serverUrl), { headers }),
        fetch(new URL("/fork/usage", state.serverUrl), { headers }),
      ])
      if (!credsRes.ok || !usageRes.ok) return undefined
      const creds: Array<{ id: string; label: string; active: boolean }> = await credsRes.json()
      const usage: {
        byCredential: Array<{
          credentialID: string
          windows: Array<{
            label: string
            spentUSD: number
            limitUSD: number
            estimatedPercent?: number
            resetsAt: number
          }>
        }>
      } = await usageRes.json()
      if (!creds.length) return undefined
      return creds.map((c) => {
        const found = usage.byCredential.find((u) => u.credentialID === c.id)
        const windows: [string, UsageWindow][] = (found?.windows ?? []).map((w) => [
          w.label,
          forkWindowToUsageWindow(w),
        ])
        return { id: c.id, label: c.label || c.id, active: c.active, windows }
      })
    } catch {
      return undefined
    }
  }

  const loadOpenRouterFree = async () => {
    if (!client) return
    try {
      const res = await (client as any).experimental.openrouterFreeUsage.get(
        { includeValue: "true" },
        { throwOnError: true },
      )
      const free = res?.data?.free
      if (!free) return
      setOpenRouterFree({ usedPercent: free.usedPercent, remaining: free.remaining, limit: free.limit })
    } catch {
      setOpenRouterFree(undefined)
    }
  }

  const loadLimits = async () => {
    if (!client) return
    setQuotaLoading(true)
    try {
      const provRes = await (client as any).quota.providers({}, { throwOnError: true })
      const provs: Array<{ providerId: string; providerName: string; configured: boolean }> = (
        provRes?.data?.providers ?? []
      ).filter((p: { configured: boolean }) => p.configured)
      if (!provs.length) {
        setQuotaData([])
        setQuotaUpdatedAt(Date.now())
        return
      }
      const [results, goPerKey] = await Promise.all([
        Promise.all(
          provs.map(async (p): Promise<LimitsProviderData> => {
            try {
              const q = await (client as any).quota.get({ providerID: p.providerId }, { throwOnError: true })
              const data = q?.data ?? q
              return {
                result: {
                  providerId: data?.providerId ?? p.providerId,
                  providerName: data?.providerName ?? p.providerName,
                  configured: data?.configured ?? p.configured,
                  ok: data?.ok ?? true,
                  planLabel: data?.planLabel,
                  usage: data?.usage ?? null,
                  fetchedAt: data?.fetchedAt ?? Date.now(),
                },
              }
            } catch (e) {
              return {
                result: {
                  providerId: p.providerId,
                  providerName: p.providerName,
                  configured: p.configured,
                  ok: false,
                  error: e instanceof Error ? e.message : String(e),
                  usage: null,
                  fetchedAt: Date.now(),
                },
              }
            }
          }),
        ),
        loadForkPerKey(),
      ])
      if (goPerKey) {
        const go = results.find((r) => r.result.providerId === "opencode-go" || r.result.providerId === "opencode")
        if (go) go.perKey = goPerKey
      }
      // WorkBuddy publishes one flat window map covering every enrolled
      // account, which rendered as ~57 identical-looking rows of
      // `account:someone@example.com:Basic`. It is multi-account in exactly the
      // way OpenCode Go is, so give it the same shape: aggregates on the card,
      // accounts behind the per-key disclosure.
      for (const entry of results) {
        if (entry.result.providerId !== "workbuddy") continue
        const usage = entry.result.usage
        if (!usage) continue
        const split = splitWorkBuddyWindows(Object.entries(usage.windows))
        if (split.accounts.length === 0) continue
        entry.result = { ...entry.result, usage: { windows: Object.fromEntries(split.aggregate) } }
        entry.perKey = split.accounts.map(({ account, windows }) => ({
          id: account,
          label: account,
          active: false,
          windows: sortWindows(windows),
        }))
      }
      setQuotaData(results)
      setQuotaUpdatedAt(Date.now())
      void loadOpenRouterFree()
    } catch {
      setQuotaData([])
    } finally {
      setQuotaLoading(false)
    }
  }

  const eventSessionID = (props: any) => props?.sessionID ?? props?.sessionId ?? props?.info?.id
  const seenEventIDs = new Set<string>()
  let gapRepair: Promise<void> | undefined

  const upsertSessionInfo = (info: any) => {
    if (!info?.id) return false
    const normalized = info.location ? mapV2ToSession(info) : (info as Session)
    const index = state.sessions.findIndex((session) => session.id === normalized.id)
    const archived = !!(normalized.time as any)?.archived
    if (archived) {
      if (index >= 0) setState("sessions", (sessions) => sessions.filter((session) => session.id !== normalized.id))
      const archivedIndex = state.archivedSessions.findIndex((session) => session.id === normalized.id)
      if (archivedIndex >= 0) setState("archivedSessions", archivedIndex, normalized)
      return true
    }
    const projected = {
      ...(index >= 0 ? state.sessions[index] : {}),
      ...normalized,
      // `version: "v2"` is the mobile protocol marker used by the current
      // list projection; native EventV2 session payloads themselves carry the
      // server's application version, so retain the protocol marker here.
      ...(eventChannel === "current" ? { version: "v2" } : {}),
    } as Session
    if (index >= 0) setState("sessions", index, projected)
    else setState("sessions", (sessions) => [projected, ...sessions])
    return true
  }

  const deleteSessionInfo = (sessionID: string) => {
    setState("sessions", (sessions) => sessions.filter((session) => session.id !== sessionID))
    setState("archivedSessions", (sessions) => sessions.filter((session) => session.id !== sessionID))
    runtimeRevision.delete(sessionID)
    setRuntimes(sessionID, undefined!)
    if (sessionID === state.activeSessionID) setState("activeSessionID", undefined)
  }

  const projectStepMetadata = (sessionID: string, props: any) => {
    const index = state.sessions.findIndex((session) => session.id === sessionID)
    if (index < 0) return
    const current = state.sessions[index]!
    setState("sessions", index, {
      ...current,
      ...(typeof props.cost === "number" ? { cost: props.cost } : {}),
      ...(props.tokens ? { tokens: props.tokens } : {}),
      time: { ...current.time, updated: props.timestamp ?? Date.now() },
    })
  }

  const repairStreamGap = () => {
    if (gapRepair || !client) return gapRepair
    const source = client
    gapRepair = Promise.all([
      refresh(),
      reconcileActiveSessions(source),
      state.activeSessionID ? refreshMessages(state.activeSessionID) : Promise.resolve(),
    ])
      .then(() => undefined)
      .finally(() => {
        gapRepair = undefined
      })
    return gapRepair
  }

  const handleServerEvent = (event: unknown) => {
    if (!event || typeof event !== "object" || !("type" in event)) return
    const raw = event as any
    if (typeof raw.id === "string") {
      if (seenEventIDs.has(raw.id)) return
      seenEventIDs.add(raw.id)
      if (seenEventIDs.size > 2048) seenEventIDs.delete(seenEventIDs.values().next().value!)
    }
    const type = String(raw.type)
    const props = raw.data ?? raw.properties ?? raw
    const sessionID = eventSessionID(props)

    if (type === "server.connected") {
      // Liveness only. Replay follows this frame on a resumed connection; a
      // successful socket is not evidence that global/session state is stale.
      return
    }
    if (type === "server.stream.gap") {
      // The replay ring explicitly told us it cannot reconstruct the missing
      // suffix. This is the exceptional authoritative-repair boundary.
      void repairStreamGap()
      return
    }

    if (type === "session.created" || type === "session.updated") {
      if (!upsertSessionInfo(props.info)) void refresh()
    }
    if (type === "session.deleted" && sessionID) deleteSessionInfo(sessionID)
    // Older compatibility servers can emit a move event without the resulting
    // Session payload. Keep the snapshot fallback only for that information-
    // incomplete structural mutation.
    if (type === "session.moved" && !upsertSessionInfo(props.info)) void refresh()
    if (type.startsWith("message.")) {
      if (sessionID === state.activeSessionID) queueMessageEvent(type, props)
    }
    if (type.startsWith("session.next.")) {
      // Any session.next activity except terminal step means generating.
      // This catches prompt/admitted, step/text/reasoning/tool started,
      // deltas, and resumed — the gap between prompt and first delta would
      // otherwise show idle until the first token.
      if (sessionID && !type.endsWith(".ended") && !type.endsWith(".failed")) {
        const current = runtimes[sessionID]
        if (current?.status !== "generating") {
          setRuntime(sessionID, {
            status: "generating",
            permissions: permissions[sessionID]?.length ?? 0,
            questions: questions[sessionID]?.length ?? 0,
            busySince: current?.busySince ?? Date.now(),
          })
        }
      }
      if (sessionID === state.activeSessionID) {
        queueMessageEvent(type, props)
      }
      if (sessionID && (type === "session.next.step.ended" || type === "session.next.step.failed")) {
        projectStepMetadata(sessionID, props)
      }
    }
    if (type.includes("permission") && sessionID) {
      void refreshPermissions(sessionID)
      // Auto-accept sessions resolve this permission silently a moment
      // later (see refreshPermissions); don't flip the runtime status to
      // "waiting_permission" only to flip it back, which flashes the
      // status dot for a session the user never has to look at.
      if (type.includes("asked") && !autoAcceptSessions().has(sessionID)) {
        setRuntime(sessionID, {
          status: "waiting_permission",
          permissions: Math.max(1, permissions[sessionID]?.length ?? 0),
          questions: questions[sessionID]?.length ?? 0,
          busySince: runtimes[sessionID]?.busySince,
        })
        if (sessionID === state.activeSessionID) triggerHaptic("warning")
      }
    }
    if (type.includes("question") && sessionID) {
      void refreshQuestions(sessionID)
      if (type.includes("asked")) {
        setRuntime(sessionID, {
          status: "waiting_question",
          permissions: permissions[sessionID]?.length ?? 0,
          questions: Math.max(1, questions[sessionID]?.length ?? 0),
          busySince: runtimes[sessionID]?.busySince,
        })
        if (sessionID === state.activeSessionID) triggerHaptic("warning")
      }
    }
    if ((type === "session.idle" || type === "session.status") && sessionID) {
      const status = props.status?.type ?? props.type
      const base = { permissions: permissions[sessionID]?.length ?? 0, questions: questions[sessionID]?.length ?? 0 }
      if (status === "idle") setRuntime(sessionID, { status: "idle", ...base })
      if (status === "busy" || status === "running") {
        setRuntime(sessionID, {
          status: "generating",
          ...base,
          busySince: runtimes[sessionID]?.busySince ?? Date.now(),
        })
      }
      if (status === "retry")
        setRuntime(sessionID, { status: "retry", ...base, busySince: runtimes[sessionID]?.busySince ?? Date.now() })
    }
  }

  const runEventLoop = async (source: OpencodeClient, signal: AbortSignal, channel: "current" | "compatibility") => {
    let restartDelay = 250
    while (!signal.aborted) {
      try {
        await openEvents(source, signal, channel, handleServerEvent, {
          lastEventId: eventCursors.get(channel),
          onCursor: (id) => eventCursors.set(channel, id),
        })
        restartDelay = 250
      } catch {
        // Generated SSE owns ordinary network retry/replay. Reaching this catch
        // means the stream itself exited; restart only the transport, never
        // snapshots. Keep the cursor across this outer generation as well.
      }
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        const jitter = Math.floor(Math.random() * Math.max(1, restartDelay / 3))
        const timeout = window.setTimeout(resolve, restartDelay + jitter)
        signal.addEventListener("abort", () => { clearTimeout(timeout); resolve() }, { once: true })
      })
      restartDelay = Math.min(restartDelay * 2, 10_000)
    }
  }

  const startEventLoop = (source: OpencodeClient) => {
    eventsAbort?.abort()
    eventsAbort = undefined
    if (document.visibilityState !== "visible") return
    eventsAbort = new AbortController()
    void runEventLoop(source, eventsAbort.signal, eventChannel)
  }

  /** Drops everything scoped to one server process. */
  const connect = async () => {
    setState({ status: "connecting", error: "" })
    try {
      const serverUrl = normalizeServerUrl(state.serverUrl)
      const storedToken = readStorage(DEVICE_TOKEN_KEY)
      const storedServer = readStorage(SERVER_URL_KEY)
      if (
        state.token &&
        state.token === storedToken &&
        storedServer &&
        normalizeServerUrl(storedServer) !== serverUrl
      ) {
        throw new Error("This device token is bound to another server. Forget the device before changing servers.")
      }
      // Identity first, and unauthenticated: it establishes *which* opencode is
      // at this address before the device token is sent to it.
      //
      // Deliberately NOT baked into the client as a pin. An instance id names
      // one *launch*; this client outlives many. Pinning it made every request
      // 409 the moment the desktop restarted — the session list would load and
      // then nothing could be opened. The per-request guarantee belongs to the
      // dev proxy, which re-resolves a live id on every call.
      const identity = await fetchIdentity(serverUrl)
      const instance = compareInstance({ pinned: readStorage(INSTANCE_ID_KEY), observed: identity?.instanceID })
      const nextClient = createClient(serverUrl, state.token || undefined)
      const health = await nextClient.global.health({ throwOnError: true })
      if (!health.data) throw new Error("Server returned no health info")
      // A new instance id is the *normal* result of restarting the desktop, and
      // the sessions behind it are the same rows in the same database. Re-pin
      // silently: the refresh below replaces every list wholesale, so there is
      // nothing stale to clear and nothing worth interrupting the user about.
      if (instance.state === "adopted" || instance.state === "changed")
        writeStorage(INSTANCE_ID_KEY, instance.instanceID)
      // connect() performs an authoritative bootstrap, so transport cursors
      // from a previous explicit connection/instance are unnecessary and can
      // only manufacture an avoidable replay-gap repair.
      eventCursors.clear()
      eventChannel = "current"
      eventChannelResolved = false
      client = nextClient
      writeStorage(SERVER_URL_KEY, serverUrl)
      if (state.token) writeStorage(DEVICE_TOKEN_KEY, state.token)
      setState({
        serverUrl,
        serverVersion: health.data.version,
        status: "connected",
        identity,
      })
      // Archived is lazy — only fetched when the Archive tab is opened (saves 1 RTT on launch)
      await Promise.all([refresh(), loadProviders(), loadProjects(), loadLimits()])
      // Best-effort and off the critical path: the locally cached preferences
      // document already renders, this only reconciles it with the desktop's.
      void modelPreferences.load()
      void reconcilePushSubscription(nextClient)
      await reconcileActiveSessions(nextClient)

      startEventLoop(nextClient)
      // Subscribe before hydrating a cold deep-link target: events that land
      // during its message snapshot are then replayed/projected instead of
      // falling into a stream-start race window.
      const navigationTarget = pendingNavigationSessionID
      if (navigationTarget) {
        pendingNavigationSessionID = undefined
        await selectSession(navigationTarget)
      }
    } catch (error) {
      client = undefined
      const raw = error instanceof Error ? error.message : "Connection failed"
      const hint =
        raw.includes("Failed to fetch") || raw.includes("NetworkError") || raw.includes("Load failed")
          ? `${raw} — could not reach ${state.serverUrl}. Is the tunnel running and is --cors set to allow ${location.origin}?`
          : raw
      setState({ status: "error", error: hint })
      if (hint !== raw) setAdvancedOpen(true)
    }
  }

  const connectFromPair = async (fromScan = false) => {
    if (!state.pairing) return
    if (!state.serverUrl.trim()) {
      setState({
        status: "error",
        error:
          'No server URL set — open "Advanced: server URL & device token" below, enter your OpenCode server address, then try again.',
      })
      setAdvancedOpen(true)
      if (fromScan) setPairMode("code")
      return
    }
    try {
      setState({ status: "connecting", error: "Claiming device..." })
      const serverUrl = normalizeServerUrl(state.serverUrl)
      const claimed = await claimPair(serverUrl, state.pairing)
      // Pairing is a deliberate rebind, so the previous pin is not a mismatch
      // to warn about — connect() below adopts whatever instance issued this token.
      clearStorage(INSTANCE_ID_KEY)
      writeStorage(SERVER_URL_KEY, serverUrl)
      writeStorage(DEVICE_TOKEN_KEY, claimed.token)
      writeStorage(DEVICE_ID_KEY, claimed.deviceID)
      setState({ token: claimed.token, pairing: "", error: "" })
      await connect()
    } catch (error) {
      const msg = pairClaimErrorMessage(error)
      setState({ status: "error", error: msg })
      // Wrong-instance 500s and network errors are always a server-URL
      // problem — surface Advanced so the user can see/correct it.
      if (
        msg.includes("not an opencode server") ||
        msg.includes("could not reach the API") ||
        msg.includes("No server URL")
      ) {
        setAdvancedOpen(true)
      }
      if (fromScan) setPairMode("code")
    }
  }

  const selectSession = async (sessionID: string) => {
    // Push/deep links can name an archived session or an older session outside
    // the list soft-cap. Resolve only that row on demand; ordinary list clicks
    // hit the fast path with no extra request.
    if (
      !mockEnabled &&
      !state.sessions.some((session) => session.id === sessionID) &&
      !state.archivedSessions.some((session) => session.id === sessionID)
    ) {
      if (!client) {
        pendingNavigationSessionID = sessionID
        return false
      }
      let resolved = false
      if (eventChannel === "current") {
        try {
          const response: any = await client.v2.session.get({ sessionID }, { throwOnError: true })
          const info = response?.data?.data ?? response?.data
          if (info) resolved = upsertSessionInfo(info)
        } catch {}
      }
      if (!resolved) {
        try {
          const response: any = await client.session.get({ sessionID }, { throwOnError: true })
          if (response?.data) resolved = upsertSessionInfo(response.data)
        } catch {}
      }
      if (!resolved) {
        setState("error", "The session from this notification is no longer available.")
        return false
      }
    }
    if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
    streamFrame = undefined
    pendingMessageEvents.discard()
    staleMessageSessions.clear()
    messageRevision++
    messageRequest++
    const initialMessages = mockEnabled ? (mockMessages as MessageBundle[]) : []
    messageProjection.reset(initialMessages)
    setMessageStructureRevision((value) => value + 1)
    setState({ activeSessionID: sessionID, messages: initialMessages })
    triggerHaptic("soft")
    if (mockEnabled) return true
    await Promise.all([refreshMessages(sessionID), refreshPermissions(sessionID), refreshQuestions(sessionID)])
    return true
  }

  const createSession = async () => {
    if (!client) return
    try {
      const res = await client.session.create({ title: "Mobile session" }, { throwOnError: true })
      if (res?.data) {
        await refresh()
        await selectSession(res.data.id)
      }
    } catch (e) {
      setState("error", e instanceof Error ? e.message : "Failed to create session")
    }
  }

  const send = async () => {
    if (!client || !state.activeSessionID || !state.draft.trim()) return
    const text = state.draft.trim()
    setState("draft", "")
    deltaCount = 0
    lastDeltaHaptic = 0
    const sid = state.activeSessionID!
    setRuntime(sid, {
      status: "generating",
      permissions: permissions[sid]?.length ?? 0,
      questions: questions[sid]?.length ?? 0,
      busySince: Date.now(),
    })
    try {
      // The session's stored model is what the server would otherwise use, but
      // the OpenRouter upstream pin is not part of it: `ModelRef` has no field
      // for one, so the server only accepts it per-prompt. Read it from the
      // shared preferences document rather than from transient state, so a pin
      // survives a reload exactly as it does on the desktop.
      const sessionModel = state.sessions.find((s) => s.id === sid)?.model
      const subProvider =
        sessionModel?.providerID === "openrouter"
          ? modelPreferences.subProviderFor(subProviderKeyFor(sessionModel.providerID, sessionModel.id))
          : undefined
      await client.session.prompt(
        {
          sessionID: sid,
          ...(subProvider ? { subProvider } : {}),
          parts: [{ type: "text" as const, text }],
        },
        { throwOnError: true },
      )
      // The native/compat stream owns the incremental projection. Successful
      // prompt admission is not a reason to re-fetch the entire active history.
      triggerHaptic("soft")
    } catch (e) {
      setState({ draft: text, error: e instanceof Error ? e.message : "Send failed" })
      const sid2 = state.activeSessionID
      if (sid2) setRuntime(sid2, { status: "error", permissions: 0, questions: 0 })
      triggerHaptic("warning")
    }
  }

  const killShell = async (input: { sessionID: string; callID?: string; jobId?: string }) => {
    if (!client) return { killed: false }
    try {
      const response = await client.tool.kill({ toolKillPayload: input }, { throwOnError: true })
      return response.data
    } catch {
      return { killed: false }
    }
  }

  const stopGeneration = async () => {
    if (!client || !state.activeSessionID) return
    try {
      await (client.session as any).abort({ sessionID: state.activeSessionID }, { throwOnError: true })
      triggerHaptic("light")
      setRuntime(state.activeSessionID, { status: "idle", permissions: 0, questions: 0 })
    } catch {
      try {
        await (client as any).session.abort({ sessionID: state.activeSessionID })
      } catch {}
    }
  }

  const disconnect = () => {
    eventsAbort?.abort()
    eventsAbort = undefined
    client = undefined
    // The instance pin survives on purpose: reconnecting to the same address
    // should still be able to tell you the process behind it changed.
    setState({
      status: "disconnected",
      sessions: [],
      archivedSessions: [],
      messages: [],
      activeSessionID: undefined,
      error: "",
      identity: undefined,
    })
    setQuotaData([])
    setOpenRouterFree(undefined)
    setProviders([])
    setProjectsList([])
  }

  const forgetDevice = async () => {
    eventsAbort?.abort()
    // Deliberately unpinned: revoking is worth attempting even against an
    // instance this device is no longer pinned to.
    const source =
      client ??
      (state.serverUrl && state.token ? createClient(normalizeServerUrl(state.serverUrl), state.token) : undefined)
    if (source) {
      try {
        await disableNotifications(source)
      } catch {
        // Revocation remains the important boundary if push cleanup fails.
      }
      try {
        let deviceID = readStorage(DEVICE_ID_KEY)
        if (!deviceID && state.token) {
          const devices = await source.device.list({ throwOnError: true })
          deviceID = devices.data?.find(
            (device) => !device.revokedAt && device.tokenPrefix === state.token.slice(0, 8),
          )?.id
        }
        if (deviceID) await source.device.remove({ deviceID }, { throwOnError: true })
      } catch {
        // Clear local credentials even when the server is offline.
      }
    }
    clearStorage(DEVICE_ID_KEY)
    clearStorage(DEVICE_TOKEN_KEY)
    clearStorage(INSTANCE_ID_KEY)
    setState("token", "")
    disconnect()
    triggerHaptic("light")
  }

  const openContextMenu = (sessionID: string) => {
    setState({ contextMenuOpen: true, contextMenuSessionID: sessionID })
    triggerHaptic("selection")
  }

  const closeContextMenu = () => {
    setState({ contextMenuOpen: false, contextMenuSessionID: undefined })
  }

  const deleteSession = async () => {
    const id = state.contextMenuSessionID
    closeContextMenu()
    if (!client || !id) return
    try {
      await client.session.delete({ sessionID: id } as any, { throwOnError: true } as any)
      triggerHaptic("success")
      if (state.activeSessionID === id) setState("activeSessionID", undefined)
      await refresh()
      await refreshArchived()
    } catch (e) {
      setState("error", e instanceof Error ? e.message : "Delete failed")
      triggerHaptic("warning")
    }
  }

  const archiveSession = async () => {
    const id = state.contextMenuSessionID
    closeContextMenu()
    if (!client || !id) return
    const isArchived = state.archivedSessions.some((s) => s.id === id)
    try {
      await (client.session as any).update(
        { sessionID: id, time: { archived: isArchived ? null : Date.now() } } as any,
        { throwOnError: true },
      )
      triggerHaptic("soft")
      await refresh()
      await refreshArchived()
    } catch (e) {
      setState("error", e instanceof Error ? e.message : "Archive failed")
      triggerHaptic("warning")
    }
  }

  const [permissionReplyError, setPermissionReplyError] = createSignal<string | undefined>(undefined)
  const [questionReplyError, setQuestionReplyError] = createSignal<string | undefined>(undefined)

  const handlePermissionReply = async (requestID: string, reply: PermissionV2Reply) => {
    if (!client || !state.activeSessionID) return
    try {
      await (client.session as any).permission.reply(
        { sessionID: state.activeSessionID, requestID, reply },
        { throwOnError: true },
      )
      setPermissionReplyError(undefined)
      triggerHaptic("success")
      await refreshPermissions(state.activeSessionID)
    } catch (e) {
      console.error("handlePermissionReply failed", state.activeSessionID, requestID, e)
      const message = e instanceof Error ? e.message : "Permission reply failed"
      setState("error", message)
      setPermissionReplyError(message)
    }
  }

  const handleQuestionSubmit = async (requestID: string, answers: string[][]) => {
    if (!client || !state.activeSessionID) return
    try {
      await (client.session as any).question.reply(
        { sessionID: state.activeSessionID, requestID, questionV2Reply: { answers } },
        { throwOnError: true },
      )
      setQuestionReplyError(undefined)
      triggerHaptic("success")
      await refreshQuestions(state.activeSessionID)
    } catch (e) {
      console.error("handleQuestionSubmit failed", state.activeSessionID, requestID, e)
      const message = e instanceof Error ? e.message : "Question reply failed"
      setState("error", message)
      setQuestionReplyError(message)
    }
  }

  const handleModelSelect = async (providerID: string, modelID: string, variant?: string) => {
    triggerHaptic("selection")
    const sessionID = state.activeSessionID
    if (!sessionID) return false

    const applySelection = () => {
      const model = { providerID, id: modelID, variant }
      setState("sessions", (sessions) =>
        sessions.map((session) => (session.id === sessionID ? { ...session, model } : session)),
      )
      setState("archivedSessions", (sessions) =>
        sessions.map((session) => (session.id === sessionID ? { ...session, model } : session)),
      )
    }

    if (!client) {
      if (!mockEnabled) return false
      applySelection()
      return true
    }

    try {
      await client.v2.session.switchModel(
        { sessionID, model: { providerID, id: modelID, variant } },
        { throwOnError: true },
      )
      applySelection()
      await refresh()
      return true
    } catch (error) {
      setState("error", error instanceof Error ? error.message : "Failed to change model")
      triggerHaptic("warning")
      return false
    }
  }

  const toggleAutoAccept = (sessionID: string) => {
    const next = new Set(autoAcceptSessions())
    if (next.has(sessionID)) next.delete(sessionID)
    else next.add(sessionID)
    setAutoAcceptSessions(next)
    triggerHaptic("selection")
  }

  onMount(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    const resumeSync = () => {
      if (!client || state.status !== "connected" || document.visibilityState !== "visible") return
      if (!eventsAbort || eventsAbort.signal.aborted) startEventLoop(client)
      const active = state.activeSessionID
      if (active && staleMessageSessions.has(active)) {
        staleMessageSessions.delete(active)
        void refreshMessages(active)
      }
    }
    const visibilitySync = () => {
      if (document.visibilityState === "visible") {
        resumeSync()
        return
      }
      // A background phone should not remain an expensive live subscriber.
      // First project the already-admitted bounded tail so the cursor and UI
      // agree, then close the socket. Foreground creates a fresh subscription
      // carrying Last-Event-ID and receives only the replay suffix.
      flushMessageEvents()
      eventsAbort?.abort()
      eventsAbort = undefined
    }
    const pushNavigate = (e: Event) => {
      const url = (e as CustomEvent<{ url: string }>).detail?.url
      if (!url) return
      const sessionID = sessionIDFromNavigationUrl(url, location.origin)
      if (!sessionID) return
      setState("page", "sessions")
      if (!client && !mockEnabled) {
        pendingNavigationSessionID = sessionID
        return
      }
      void selectSession(sessionID)
    }
    window.addEventListener("beforeinstallprompt", handler as any)
    window.addEventListener("online", resumeSync)
    window.addEventListener("opencode:push-navigate", pushNavigate)
    document.addEventListener("visibilitychange", visibilitySync)
    const activePoll = window.setInterval(() => {
      if (!client || state.status !== "connected" || document.visibilityState !== "visible") return
      // Low-frequency runtime reconciliation is a safety net for compatibility
      // servers/status events, not reconnect repair. Keep it lifecycle-visible.
      void reconcileActiveSessions(client)
    }, 60_000)
    onCleanup(() => {
      clearInterval(activePoll)
      window.removeEventListener("beforeinstallprompt", handler as any)
      window.removeEventListener("online", resumeSync)
      window.removeEventListener("opencode:push-navigate", pushNavigate)
      document.removeEventListener("visibilitychange", visibilitySync)
    })
    if (mockEnabled) {
      // Dev visual-QA mode: render the connected UI against fake data.
      setState({
        status: "connected",
        serverUrl: "https://mock.local",
        serverVersion: "0.0.0-mock",
        sessions: mockSessions,
        archivedSessions: mockArchived,
      })
      setProviders(mockProviders)
      setProjectsList((mockSessions as any).projects ?? ([] as any))
      // fabricate projects from mock sessions if mock doesn't export projects
      if (!projectsList().length) {
        const byId = new Map<string, any>()
        for (const s of mockSessions as any[]) {
          if (!byId.has(s.projectID))
            byId.set(s.projectID, {
              id: s.projectID,
              worktree: s.directory,
              name: s.directory.split(/[\\/]/).pop() || s.projectID.slice(0, 8),
              sandboxes: [],
            })
        }
        for (const s of mockArchived as any[]) {
          if (!byId.has(s.projectID))
            byId.set(s.projectID, {
              id: s.projectID,
              worktree: s.directory,
              name: s.directory.split(/[\\/]/).pop() || s.projectID.slice(0, 8),
              sandboxes: [],
            })
        }
        setProjectsList([...byId.values()] as any)
      }
      setQuotaData(mockQuota)
      setQuotaUpdatedAt(Date.now())
      recomputeContextTotals()
      setRuntimes("s1", { status: "generating", permissions: 0, questions: 0, busySince: Date.now() - 37_000 })
      setRuntimes("s2", { status: "waiting_permission", permissions: 1, questions: 0 })
      setPermissions("s2", [{ id: "p1", sessionID: "s2", action: "bash", resources: ["bun install"] }] as any)
      if (!new URLSearchParams(location.search).has("large")) {
        const navigationTarget = pendingNavigationSessionID
        pendingNavigationSessionID = undefined
        void selectSession(navigationTarget ?? "s1")
      }
      return
    }
    if (state.pairing) void connectFromPair()
    else if (state.serverUrl && state.token) void connect()
  })

  onCleanup(() => {
    if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
    eventsAbort?.abort()
    haptics.destroy()
  })

  const handleInstall = async () => {
    const prompt = deferredPrompt()
    if (!prompt) return
    try {
      await prompt.prompt()
      await prompt.userChoice
    } catch {}
    setDeferredPrompt(null)
  }

  const activeRuntime = createMemo<SessionRuntime>(() => {
    const id = state.activeSessionID
    if (!id) return { status: "idle", permissions: 0, questions: 0 }
    return (
      runtimes[id] ?? {
        status: "idle",
        permissions: permissions[id]?.length ?? 0,
        questions: questions[id]?.length ?? 0,
      }
    )
  })

  return (
    <>
      <Show when={state.status === "connected"}>
        <Show
          when={activeSession()}
          fallback={
            <div class="app-shell">
              <Show when={state.page === "sessions"}>
                <SessionsView
                  sessions={state.sessions}
                  archivedSessions={state.archivedSessions}
                  projects={projectsList()}
                  runtimes={runtimes}
                  contextTotals={contextTotals()}
                  activeSessionID={state.activeSessionID}
                  connected={state.status === "connected"}
                  onSelect={selectSession}
                  onNewSession={createSession}
                  onContextMenu={openContextMenu}
                  onOpenLimits={() => {
                    setState("page", "limits")
                    void loadLimits()
                  }}
                  onLoadArchived={() => void refreshArchived()}
                />
              </Show>
              <Show when={state.page === "limits"}>
                <LimitsView
                  providers={quotaData()}
                  loading={quotaLoading()}
                  updatedAt={quotaUpdatedAt()}
                  openRouterFree={openRouterFree()}
                  onRefresh={() => {
                    triggerHaptic("selection")
                    void loadLimits()
                  }}
                />
              </Show>
              <Show when={state.page === "settings"}>
                <SettingsView
                  serverUrl={state.serverUrl}
                  serverVersion={state.serverVersion}
                  identity={state.identity}
                  token={state.token}
                  providers={providers()}
                  client={client ?? undefined}
                  installPrompt={!!deferredPrompt()}
                  onInstall={handleInstall}
                  onForgetDevice={forgetDevice}
                  onDisconnect={disconnect}
                />
              </Show>

              {/* bottom nav – only when not in chat */}
              <nav class="bottom-nav" aria-label="Main navigation">
                <button
                  class={state.page === "sessions" ? "active" : ""}
                  onClick={() => {
                    setState("page", "sessions")
                    triggerHaptic("selection")
                  }}
                >
                  <span class="nav-icon-wrap">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.75"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M4 6h16" />
                      <path d="M4 12h16" />
                      <path d="M4 18h10" />
                    </svg>
                  </span>
                  <span>Sessions</span>
                </button>
                <button
                  class={state.page === "limits" ? "active" : ""}
                  onClick={() => {
                    setState("page", "limits")
                    triggerHaptic("selection")
                    void loadLimits()
                  }}
                >
                  <span class="nav-icon-wrap">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.75"
                      stroke-linecap="round"
                    >
                      <path d="M4 20V10" />
                      <path d="M11 20V4" />
                      <path d="M18 20v-7" />
                    </svg>
                  </span>
                  <span>Limits</span>
                </button>
                <button
                  class={state.page === "settings" ? "active" : ""}
                  onClick={() => {
                    setState("page", "settings")
                    triggerHaptic("selection")
                  }}
                >
                  <span class="nav-icon-wrap">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.75"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.4.66.75.85.34.2.68.24 1.09.24H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                    </svg>
                  </span>
                  <span>Settings</span>
                </button>
              </nav>

              <Show when={state.contextMenuOpen}>
                <div
                  class="context-menu-overlay"
                  onClick={closeContextMenu}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    closeContextMenu()
                  }}
                >
                  <div class="context-menu" onClick={(e) => e.stopPropagation()}>
                    <div class="context-menu-title">{contextMenuSession()?.title || "Session"}</div>
                    <button
                      onClick={() => {
                        void archiveSession()
                        triggerHaptic("soft")
                      }}
                    >
                      <IconArchive size={16} />{" "}
                      {state.archivedSessions.some((s) => s.id === state.contextMenuSessionID)
                        ? "Unarchive"
                        : "Archive"}{" "}
                      session
                    </button>
                    <button
                      class="destructive"
                      onClick={() => {
                        void deleteSession()
                        triggerHaptic("soft")
                      }}
                    >
                      <IconTrash size={16} /> Delete session
                    </button>
                    <button onClick={closeContextMenu}>
                      <IconClose size={14} /> Cancel
                    </button>
                  </div>
                </div>
              </Show>
            </div>
          }
        >
          {(sess) => (
            <ChatView
              session={sess()}
              messages={state.messages}
              messageStructureRevision={messageStructureRevision()}
              runtimeStatus={activeRuntime().status}
              busySince={activeRuntime().busySince}
              contextTotal={contextTotals()[sess().id] ?? 0}
              providers={providers()}
              draft={state.draft}
              onDraftInput={(v) => setState("draft", v)}
              onSend={() => void send()}
              onStop={() => void stopGeneration()}
              killShell={killShell}
              onBack={() => {
                setState("activeSessionID", undefined)
                triggerHaptic("selection")
              }}
              permissions={state.activeSessionID ? (permissions[state.activeSessionID] ?? []) : []}
              questions={state.activeSessionID ? (questions[state.activeSessionID] ?? []) : []}
              onPermissionReply={(id, reply) => void handlePermissionReply(id, reply)}
              onQuestionSubmit={(id, answers) => void handleQuestionSubmit(id, answers)}
              permissionReplyError={permissionReplyError()}
              questionReplyError={questionReplyError()}
              onModelSelect={handleModelSelect}
              modelPicker={{
                client: () => client,
                preferences: modelPreferences,
                quota: () => quotaData(),
                fetchEndpoints: fetchModelEndpoints,
              }}
              onOpenLimits={() => {
                setState({ page: "limits", activeSessionID: undefined })
                void loadLimits()
              }}
              autoAccept={autoAcceptSessions().has(sess().id)}
              onToggleAutoAccept={() => toggleAutoAccept(sess().id)}
            />
          )}
        </Show>
        {/* context menu also available inside chat (re-rendered here too for drill-in) */}
        <Show when={state.contextMenuOpen && !!state.activeSessionID}>
          <div class="context-menu-overlay" onClick={closeContextMenu}>
            <div class="context-menu" onClick={(e) => e.stopPropagation()}>
              <div class="context-menu-title">{contextMenuSession()?.title || "Session"}</div>
              <button onClick={() => void archiveSession()}>
                <IconArchive size={16} /> Archive
              </button>
              <button class="destructive" onClick={() => void deleteSession()}>
                <IconTrash size={16} /> Delete
              </button>
              <button onClick={closeContextMenu}>Cancel</button>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={state.status !== "connected"}>
        <main class="mobile-shell" style={{ "padding-bottom": "max(18px, env(safe-area-inset-bottom))" }}>
          <header class="mobile-header">
            <div>
              <p class="eyebrow">First-party mobile client</p>
              <h1>OpenCode</h1>
            </div>
          </header>

          <section class="pair-page">
            <div class="pair-title-block">
              <h2>Pair this device</h2>
              <p>Scan the QR from desktop Settings › Devices, or enter the 6-character code.</p>
            </div>

            <div class="segmented" role="tablist">
              <button
                role="tab"
                aria-selected={pairMode() === "scan"}
                classList={{ active: pairMode() === "scan" }}
                onClick={() => {
                  setPairMode("scan")
                  triggerHaptic("selection")
                }}
              >
                Scan QR
              </button>
              <button
                role="tab"
                aria-selected={pairMode() === "code"}
                classList={{ active: pairMode() === "code" }}
                onClick={() => {
                  setPairMode("code")
                  triggerHaptic("selection")
                }}
              >
                Enter code
              </button>
            </div>

            <Show when={isReconnecting()}>
              <div
                style={{
                  display: "flex",
                  "flex-direction": "column",
                  "align-items": "center",
                  gap: "14px",
                  padding: "32px 0 8px",
                }}
              >
                <div class="wave-bars" style={{ height: "14px" }}>
                  {[5, 9, 6, 12, 7, 9].map((h, i) => (
                    <span style={{ height: `${h}px`, "animation-delay": `${i * 0.12}s` }} />
                  ))}
                </div>
                <p style={{ margin: 0, "font-size": "var(--font-sm)", color: "var(--text-muted)", "font-weight": 600 }}>
                  Reconnecting…
                </p>
                <p style={{ margin: 0, "font-size": "var(--font-xs)", color: "var(--text-weakest)" }}>
                  {state.serverUrl}
                </p>
              </div>
            </Show>

            <Show when={!isReconnecting() && pairMode() === "scan"}>
              <PairingCamera
                onPairCode={(code, serverUrl) => {
                  if (!import.meta.env.DEV && serverUrl) {
                    setState("serverUrl", serverUrl)
                  }
                  setState({ pairing: code, error: "" })
                  triggerHaptic("success")
                  void connectFromPair(true)
                }}
                onError={(msg) => setState("error", msg)}
              />
            </Show>

            <Show when={!isReconnecting() && pairMode() === "code"}>
              <PairingCodeInput
                value={state.pairing}
                onChange={(v) => setState("pairing", v)}
                disabled={state.status === "connecting"}
              />
              <button
                class="primary-button"
                style={{ width: "100%", "margin-top": "0" }}
                onClick={() => {
                  triggerHaptic("soft")
                  void (canClaim() ? connectFromPair() : connect())
                }}
                disabled={submitDisabled()}
              >
                {submitLabel()}
              </button>
            </Show>

            <button class="pair-advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
              {advancedOpen() ? "Hide advanced options" : "Advanced: server URL & device token"}
            </button>
            <Show when={advancedOpen()}>
              <div class="pair-advanced-panel">
                <label>
                  Server URL
                  <input
                    value={state.serverUrl}
                    onInput={(e) => setState("serverUrl", (e.currentTarget as HTMLInputElement).value)}
                    placeholder="https://your-server.dev"
                  />
                </label>
                <label>
                  Device token
                  <input
                    type="password"
                    value={state.token}
                    onInput={(e) => setState("token", (e.currentTarget as HTMLInputElement).value)}
                    placeholder="Paste a device token"
                  />
                </label>
              </div>
            </Show>

            <Show when={state.error}>
              <p class="error-message">{state.error}</p>
            </Show>

            <div class="pair-footer">
              <p class="pair-footer-note">
                Pairing codes expire after 90 seconds and never touch server logs. Connecting from {pwaOrigin()}.
              </p>
              <button class="text-button" onClick={() => setHowOpen((v) => !v)}>
                {howOpen() ? "Hide" : "How pairing works"}
              </button>
              <Show when={howOpen()}>
                <p class="pair-footer-note">
                  A scanned or typed code exchanges once for a persistent device token, which then authenticates every
                  request as <code>Basic device:&lt;token&gt;</code>. No server username or password is ever accepted by
                  the mobile client.
                </p>
              </Show>
            </div>
          </section>
        </main>
      </Show>
    </>
  )
}
