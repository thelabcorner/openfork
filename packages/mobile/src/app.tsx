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
  IDENTITY_REQUIRED_MESSAGE,
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
import { reduceMessageEvent } from "./messageStream"
import { normalizeLegacyProviders } from "./providerCatalog"

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
  const [state, setState] = createStore({
    serverUrl: launch.serverUrl ?? "",
    token: readStorage(DEVICE_TOKEN_KEY) ?? "",
    status: "disconnected" as ConnectionStatus,
    serverVersion: "",
    identity: undefined as InstanceIdentity | undefined,
    instanceNotice: "",
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
  const canClaim = () => state.pairing.trim().length === PAIR_CODE_LENGTH
  const canConnect = () => !state.pairing && !!state.token.trim() && !!state.serverUrl.trim()
  const submitDisabled = () => state.status === "connecting" || (!canClaim() && !canConnect())
  const submitLabel = () => (state.status === "connecting" ? "Connecting…" : canClaim() ? "Claim device" : "Connect")
  const isReconnecting = () => state.status === "connecting" && hasStoredToken() && !!state.serverUrl.trim()

  let client: OpencodeClient | undefined
  let eventsAbort: AbortController | undefined
  let refreshInFlight = false
  let refreshPending = false
  let messageRevision = 0
  let messageRequest = 0
  let streamFrame: number | undefined
  const pendingMessageEvents: Array<{ type: string; props: any }> = []
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
        if (all.length > 0) return [...new Map(all.map((s) => [s.id, s] as const)).values()]
        if (!opts.archived) {
          // V2 returned 0 actives but server had data — fall through to legacy rather than empty
          if (
            (await v2.list({ limit: 1, order: "desc" }, { throwOnError: true }).catch(() => null))?.data?.data?.length
          )
            throw new Error("v2 empty actives")
          return []
        }
      }
    } catch {}
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
    runtimeRevision.set(sessionID, (runtimeRevision.get(sessionID) ?? 0) + 1)
    setRuntimes(sessionID, runtime)
  }

  const reconcileActiveSessions = async (source: OpencodeClient) => {
    const started = new Map(runtimeRevision)
    try {
      const directories = [
        ...new Set(
          state.sessions.flatMap((session) => {
            if (!session.directory) return []
            const subpath = (session as any).path
            return subpath
              ? [
                  session.directory,
                  `${session.directory.replace(/[\\/]$/, "")}\\${String(subpath).replace(/^[\\/]/, "")}`,
                ]
              : [session.directory]
          }),
        ),
      ]
      const [currentResult, ...compatibilityResults] = await Promise.all([
        source.v2.session.active({ throwOnError: true }).catch(() => undefined),
        ...directories.map((directory) =>
          source.session.status({ directory }, { throwOnError: true }).catch(() => undefined),
        ),
      ])
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
      if (Object.keys(active).some((sessionID) => !known.has(sessionID))) void refresh()
      for (const sessionID of new Set([...known, ...Object.keys(runtimes), ...Object.keys(active)])) {
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
      if (response.data) setState("messages", response.data as MessageBundle[])
    } catch (e) {
      setState("error", e instanceof Error ? e.message : "Failed to load messages")
    }
  }

  const flushMessageEvents = () => {
    if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
    streamFrame = undefined
    if (!pendingMessageEvents.length) return
    const events = pendingMessageEvents.splice(0)
    let messages = state.messages
    let changed = false
    let stale = false
    let hapticText = ""
    for (const event of events) {
      const result = reduceMessageEvent(messages, event.type, event.props)
      messages = result.messages
      changed ||= result.changed
      stale ||= !!result.stale
      if (event.type.endsWith(".delta")) hapticText += event.props.delta ?? ""
    }
    if (changed) {
      messageRevision++
      setState("messages", messages)
      if (hapticText) triggerDeltaHaptic(hapticText)
    }
    if (stale && state.activeSessionID) void refreshMessages(state.activeSessionID)
  }

  const queueMessageEvent = (type: string, props: any) => {
    const isDelta = type.endsWith(".delta")
    if (!isDelta) flushMessageEvents()
    pendingMessageEvents.push({ type, props })
    if (!isDelta) {
      flushMessageEvents()
      return
    }
    if (streamFrame === undefined) streamFrame = requestAnimationFrame(flushMessageEvents)
  }

  const refreshPermissions = async (sessionID: string) => {
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
  const refreshQuestions = async (sessionID: string) => {
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
      void Promise.all([refresh(), reconcileActiveSessions(client!), reconcilePushSubscription(client!)])
      return
    }

    if (
      type === "session.created" ||
      type === "session.updated" ||
      type === "session.deleted" ||
      type === "session.moved"
    ) {
      void refresh()
      if (type === "session.deleted" && sessionID) {
        runtimeRevision.delete(sessionID)
        setRuntimes(sessionID, undefined!)
        if (sessionID === state.activeSessionID) setState("activeSessionID", undefined)
      }
    }
    if (type.startsWith("message.")) {
      if (sessionID === state.activeSessionID) queueMessageEvent(type, props)
      if (type === "message.updated" && props.info?.time?.completed) void refresh()
    }
    if (type.startsWith("session.next.")) {
      // Any session.next activity except terminal step means generating.
      // This catches prompt/admitted, step/text/reasoning/tool started,
      // deltas, and resumed — the gap between prompt and first delta would
      // otherwise show idle until the first token.
      if (sessionID && !type.endsWith(".ended") && !type.endsWith(".failed")) {
        setRuntime(sessionID, {
          status: "generating",
          permissions: permissions[sessionID]?.length ?? 0,
          questions: questions[sessionID]?.length ?? 0,
          busySince: runtimes[sessionID]?.busySince ?? Date.now(),
        })
      }
      if (sessionID === state.activeSessionID) {
        queueMessageEvent(type, props)
        if (
          type === "session.next.step.ended" ||
          type === "session.next.step.failed" ||
          type === "session.next.tool.success" ||
          type === "session.next.tool.failed"
        ) {
          window.setTimeout(() => void refreshMessages(sessionID), 120)
        }
        // Session list's time.updated/cost/tokens are driven by refresh()
        // on session.updated, but V2 only emits session.next.* — refresh
        // the list on step boundaries so the sessions page doesn't lag.
        if (type === "session.next.step.started" || type === "session.next.step.ended") void refresh()
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

  const waitForReconnect = (signal: AbortSignal, delay = 500) =>
    new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, delay)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout)
          resolve()
        },
        { once: true },
      )
    })

  const runEventLoop = async (source: OpencodeClient, signal: AbortSignal, channel: "current" | "compatibility") => {
    let delay = 500
    while (!signal.aborted) {
      try {
        await openEvents(source, signal, channel, handleServerEvent)
        delay = 500
      } catch {
        // Live events have no replay. Reopening plus authoritative snapshots
        // below repairs state whether the stream failed or ended normally.
      }
      if (signal.aborted) return
      await waitForReconnect(signal, delay)
      if (signal.aborted) return
      await Promise.all([
        refresh(),
        reconcileActiveSessions(source),
        state.activeSessionID ? refreshMessages(state.activeSessionID) : Promise.resolve(),
      ])
      delay = Math.min(delay * 2, 10_000)
    }
  }

  const startEventLoop = (source: OpencodeClient) => {
    eventsAbort?.abort()
    eventsAbort = new AbortController()
    void runEventLoop(source, eventsAbort.signal, "current")
    void runEventLoop(source, eventsAbort.signal, "compatibility")
  }

  /** Drops everything scoped to one server process. */
  const resetInstanceState = () => {
    setState({ sessions: [], archivedSessions: [], messages: [], activeSessionID: undefined })
    for (const id of Object.keys(runtimes)) setRuntimes(id, undefined!)
    for (const id of Object.keys(permissions)) setPermissions(id, undefined!)
    for (const id of Object.keys(questions)) setQuestions(id, undefined!)
    setQuotaData([])
    setOpenRouterFree(undefined)
    setProviders([])
    setProjectsList([])
  }

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
      const nextClient = createClient(serverUrl, state.token || undefined)
      // Identity first, and unauthenticated: it establishes *which* opencode
      // is at this address before the device token is sent to it.
      const identity = await fetchIdentity(serverUrl)
      if (!identity) throw new Error(IDENTITY_REQUIRED_MESSAGE)
      const instance = compareInstance({ pinned: readStorage(INSTANCE_ID_KEY), observed: identity?.instanceID })
      const health = await nextClient.global.health({ throwOnError: true })
      if (!health.data) throw new Error("Server returned no health info")
      if (instance.state === "changed") {
        // Same address, different process. Everything cached below belongs to
        // the instance that just went away; keeping it would blend two
        // servers' sessions into one list.
        resetInstanceState()
      }
      if (instance.state === "adopted" || instance.state === "changed")
        writeStorage(INSTANCE_ID_KEY, instance.instanceID)
      client = nextClient
      writeStorage(SERVER_URL_KEY, serverUrl)
      if (state.token) writeStorage(DEVICE_TOKEN_KEY, state.token)
      setState({
        serverUrl,
        serverVersion: health.data.version,
        status: "connected",
        identity,
        instanceNotice:
          instance.state === "changed"
            ? "Reconnected to a different OpenCode instance at this address — cached sessions were cleared."
            : "",
      })
      // Archived is lazy — only fetched when the Archive tab is opened (saves 1 RTT on launch)
      await Promise.all([refresh(), loadProviders(), loadProjects(), loadLimits()])
      await reconcileActiveSessions(nextClient)

      startEventLoop(nextClient)
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
      // Pairing is also a bind operation. Prove the API identity before
      // sending the short-lived pairing credential to any address.
      if (!(await fetchIdentity(serverUrl))) throw new Error(IDENTITY_REQUIRED_MESSAGE)
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
    if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
    streamFrame = undefined
    pendingMessageEvents.length = 0
    messageRevision++
    messageRequest++
    setState({ activeSessionID: sessionID, messages: mockEnabled ? (mockMessages as MessageBundle[]) : [] })
    triggerHaptic("soft")
    if (mockEnabled) return
    await Promise.all([refreshMessages(sessionID), refreshPermissions(sessionID), refreshQuestions(sessionID)])
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
    // Ensure list shows active immediately even before SSE arrives
    void refresh()
    void reconcileActiveSessions(client!)
    try {
      await client.session.prompt({ sessionID: sid, parts: [{ type: "text" as const, text }] }, { throwOnError: true })
      // Don't block on full snapshot — SSE will stream deltas token-by-token
      void refreshMessages()
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
      instanceNotice: "",
    })
    setQuotaData([])
    setOpenRouterFree(undefined)
    setProviders([])
    setProjectsList([])
  }

  const forgetDevice = async () => {
    eventsAbort?.abort()
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

  const [autoAcceptSessions, setAutoAcceptSessions] = createSignal<Set<string>>(new Set())
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
      // Mobile browsers commonly suspend SSE while backgrounded. Restarting
      // on foreground and reconciling snapshots closes that unobservable gap.
      startEventLoop(client)
      void Promise.all([
        refresh(),
        reconcileActiveSessions(client),
        state.activeSessionID ? refreshMessages(state.activeSessionID) : Promise.resolve(),
      ])
    }
    const pushNavigate = (e: Event) => {
      const url = (e as CustomEvent<{ url: string }>).detail?.url
      if (!url) return
      const match = new URL(url, location.origin).pathname.match(/\/session\/([^/]+)/)
      if (match) {
        setState({ page: "sessions", activeSessionID: match[1] })
        triggerHaptic("selection")
      }
    }
    window.addEventListener("beforeinstallprompt", handler as any)
    window.addEventListener("online", resumeSync)
    window.addEventListener("opencode:push-navigate", pushNavigate)
    document.addEventListener("visibilitychange", resumeSync)
    const activePoll = window.setInterval(() => {
      if (!client || state.status !== "connected" || document.visibilityState !== "visible") return
      // The stream is live-only and can lose events on mobile network changes.
      // This cheap process-local snapshot is a safety net, not the primary feed.
      void reconcileActiveSessions(client)
    }, 15_000)
    onCleanup(() => {
      clearInterval(activePoll)
      window.removeEventListener("beforeinstallprompt", handler as any)
      window.removeEventListener("online", resumeSync)
      window.removeEventListener("opencode:push-navigate", pushNavigate)
      document.removeEventListener("visibilitychange", resumeSync)
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
      if (!new URLSearchParams(location.search).has("large")) void selectSession("s1")
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
      {/* A silent rebind is the failure this guards against, so say it out
          loud once rather than letting another instance's state look like ours. */}
      <Show when={state.instanceNotice}>
        <div class="instance-notice" role="status">
          <span>{state.instanceNotice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setState("instanceNotice", "")}>
            <IconClose size={12} />
          </button>
        </div>
      </Show>
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
