import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  getOwner,
  lazy,
  Match,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  Suspense,
  Switch,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { A, useIsRouting, useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { showToast } from "@/utils/toast"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { DenseWorkingIndicator } from "@opencode-ai/ui/spinner"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getProjectAvatarVariant, useLayout, type LocalProject } from "@/context/layout"
import { useGlobal } from "@/context/global"
import { useServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"
import { useOxpActivity } from "@/context/oxp-activity"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useSessionGroups } from "@/context/session-groups"
import { SessionPreviewCard } from "@/components/session-preview/session-preview-card"
import { sessionPreviewRelationships } from "@/components/session-preview/session-preview-model"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { startupMark, startupTransportDiagnostic } from "@/utils/startup-perf"

startupMark("sidebar.module-evaluated")
import {
  compareSessionTime,
  getProjectAvatarSource,
  projectForSession,
  displayName,
  sortedRootSessions,
} from "@/pages/layout/helpers"
import type { SessionModelPickerRequest } from "@/components/session-menu/session-model-picker-runtime"
const SidebarSessionContextMenu = lazy(() =>
  import("@/components/session-menu/session-context-menu").then((m) => ({ default: m.SessionContextMenu })),
)
const SessionModelPicker = lazy(() =>
  import("@/components/session-menu/session-model-picker-runtime").then((m) => ({ default: m.SessionModelPicker })),
)
const ChatSidebarSearchResults = lazy(() =>
  import("./chat-sidebar-search-results").then((m) => ({ default: m.ChatSidebarSearchResults })),
)
const ChatSidebarArchivedBody = lazy(() =>
  import("./chat-sidebar-archived-body").then((m) => ({ default: m.ChatSidebarArchivedBody })),
)
const SidebarResizeHandle = lazy(() =>
  import("@opencode-ai/ui/resize-handle").then((m) => ({ default: m.ResizeHandle })),
)
type ChatSidebarSearchRuntime = import("./chat-sidebar-search-runtime").ChatSidebarSearchRuntime
let chatSidebarSearchRuntimeModule: Promise<typeof import("./chat-sidebar-search-runtime")> | undefined
const loadChatSidebarSearchRuntime = () =>
  (chatSidebarSearchRuntimeModule ??= import("./chat-sidebar-search-runtime"))
import {
  CHAT_SIDEBAR_RECENT_LIMIT_MIN,
  chatSidebarAggregateMetrics,
  chatSidebarWorkingIndicatorAnimated,
  uniqueSidebarSessions,
  chatSidebarRootSessionVisible,
  type ChatSidebarPaneState,
} from "./chat-sidebar-pane-state"
import { CHAT_PROJECT_NAME } from "@opencode-ai/core/project/chat"
import { findChatProject, isChatProjectAlias, isReservedChatProjectPath } from "@/utils/chat-project"
import { sessionTelemetryClientNow, sessionTelemetryElapsedMs } from "@/utils/session-telemetry-time"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { Info as SessionTelemetryInfo, Phase as SessionTelemetryPhase } from "@opencode-ai/schema/session-telemetry"

/** Compact relative stamp ("2h", "3d", "now") for any epoch-ms timestamp. */
function relativeStamp(ts: number | undefined, now: number): string {
  if (!ts) return ""
  const diffMs = now - ts
  const diffM = Math.floor(diffMs / 60000)
  const diffH = Math.floor(diffMs / 3600000)
  const diffD = Math.floor(diffMs / 86400000)
  if (diffD > 0) return `${diffD}d`
  if (diffH > 0) return `${diffH}h`
  if (diffM > 0) return `${diffM}m`
  return "now"
}

function relativeLabel(session: Session, now: number): string {
  return relativeStamp(session.time?.updated ?? session.time?.created ?? 0, now)
}

function formatCost(value: number): string {
  if (value <= 0) return "$0"
  if (value < 0.01) return "<$0.01"
  if (value < 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(2)}`
}

/** Compact clock format: 1h 04m / 4m 09s / 9s — never monospace, always tabular-nums. */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

/**
 * Context pressure is the one metric worth coloring: it is the only value in
 * the row that implies the user must act soon. Everything else stays neutral
 * so the sidebar reads as one calm surface rather than a dashboard.
 */
function contextTone(percent: number) {
  if (percent >= 85) return { bar: "bg-v2-state-fg-danger", text: "text-v2-state-fg-danger" }
  if (percent >= 65) return { bar: "bg-v2-state-fg-warning", text: "text-v2-state-fg-warning" }
  return { bar: "bg-v2-icon-icon-muted", text: "text-v2-text-text-faint" }
}

const TELEMETRY_CHARS_PER_TOKEN = 4
const TELEMETRY_MIN_RATE_WINDOW_MS = 600
const TELEMETRY_MAX_PLAUSIBLE_RATE = 1_000

function telemetryContextPercent(value: SessionTelemetryInfo | undefined) {
  const context = value?.context
  const limit = context?.model.contextLimit
  if (!context || !limit || limit <= 0) return null
  const tokens = context.tokens
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  if (total <= 0) return null
  return Math.round((total / limit) * 100)
}

/**
 * O(1) live sidebar projection. The server accumulates closed generation/tool
 * spans incrementally; the shared pane clock contributes only the currently
 * open semantic phase. No message or Part[] reads occur here.
 */
function telemetryLive(
  value: SessionTelemetryInfo | undefined,
  receivedAt: number | undefined,
  clientNow: number,
): ChatRowLive | undefined {
  if (!value || value.phase === "idle") return undefined
  const step = value.step
  const openMs = sessionTelemetryElapsedMs({
    startedAt: value.phaseStartedAt,
    sampledAt: value.sampledAt,
    updatedAt: value.updatedAt,
    receivedAt,
    now: clientNow,
  })
  const generationOpen = value.phase === "generating" || value.phase === "reasoning" ? openMs : 0
  const toolOpen = value.phase === "tool" ? openMs : 0
  const stepGeneratedMs = (step?.generatedMs ?? 0) + generationOpen
  const stepToolMs = (step?.toolMs ?? 0) + toolOpen
  const accumulatedMs = value.generatedMs + value.toolMs + generationOpen + toolOpen
  const estimatedTokens = ((step?.visibleChars ?? 0) + (step?.reasoningChars ?? 0)) / TELEMETRY_CHARS_PER_TOKEN
  const rateActive = value.phase === "generating" || value.phase === "reasoning"
  const rawRate =
    rateActive && stepGeneratedMs >= TELEMETRY_MIN_RATE_WINDOW_MS && estimatedTokens > 0
      ? estimatedTokens / (stepGeneratedMs / 1000)
      : null
  const rate = rawRate !== null && rawRate <= TELEMETRY_MAX_PLAUSIBLE_RATE ? Math.round(rawRate * 10) / 10 : null
  return {
    phase: value.phase,
    turnSeconds: (stepGeneratedMs + stepToolMs) / 1000,
    accumulatedSeconds: accumulatedMs / 1000,
    rate,
  }
}

type ChatSessionGroup = {
  key: string
  label: string
  directory: string
  project?: LocalProject
  sessions: Session[]
  total: number
}

type ChatRowTotals = {
  generatedSeconds: number
  toolSeconds: number
  cost: number
  cacheHitPercent: number | null
}

type ChatRowLive = {
  turnSeconds: number
  accumulatedSeconds: number
  rate: number | null
  phase: SessionTelemetryPhase
}

type ChatSidebarTooltipPlacement = "top" | "right" | "bottom"

type ChatSidebarTooltipIntent = {
  anchor: HTMLElement
  placement: ChatSidebarTooltipPlacement
  sessionID?: string
  text?: string
}

type ChatRowRuntime = {
  session: Accessor<Session>
  currentDir: Accessor<string>
  isWorking: Accessor<boolean>
  unseenCount: Accessor<number>
  hasError: Accessor<boolean>
  pendingPermissionCount: Accessor<number>
  pendingQuestionCount: Accessor<number>
  hasPermissions: Accessor<boolean>
  hasQuestions: Accessor<boolean>
  needsAttention: Accessor<boolean>
  isAutoAccepting: Accessor<boolean>
  totals: Accessor<ChatRowTotals | undefined>
  contextPercent: Accessor<number | null>
  modelInfo: Accessor<{ modelID: string; name?: string; variant?: string } | undefined>
  modelLabel: Accessor<string | undefined>
  live: Accessor<ChatRowLive | undefined>
  serverKey: Accessor<ReturnType<typeof ServerConnection.key> | undefined>
}

type ChatRowRuntimeLease = {
  runtime: ChatRowRuntime
  release: () => void
}

const sameRows = (a: Session[], b: Session[]) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Sessions in a directory's store always belong to that directory, but some
// rows carry no `directory` field — backfill it so path comparisons keep them
// attributed to this store instead of filtering them out. Cached per source
// object because <For> keys by reference: a fresh {...session} clone on every
// groups() recompute would remount those rows (and their IntersectionObservers)
// each time anything in the memo moved.
const backfilledDirectory = new WeakMap<Session, Session>()
const withDirectory = (session: Session, dir: string): Session => {
  if (session.directory) return session
  const cached = backfilledDirectory.get(session)
  if (cached) return cached
  const wrapped = { ...session, directory: dir }
  backfilledDirectory.set(session, wrapped)
  return wrapped
}

export function ChatSidebarPane(props: {
  state: ChatSidebarPaneState
  opened: boolean
  onClose: () => void
}): JSX.Element {
  startupMark("sidebar.component-mounted")
  const paneOwner = getOwner()
  if (!paneOwner) throw new Error("ChatSidebarPane must be created within a reactive owner")
  const language = useLanguage()
  const layout = useLayout()
  const global = useGlobal()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const platform = usePlatform()
  const notification = useNotification()
  const oxpActivity = useOxpActivity()
  const permission = usePermission()
  const sessionGroups = useSessionGroups()
  const [oxpLimit, setOxpLimit] = createSignal(5)
  const visibleOxpActivities = createMemo(() =>
    oxpActivity.activities().slice(0, oxpLimit()),
  )

  onMount(() => oxpActivity.ensureLoaded())

  // One shared ticker for every live timer in the pane — per-row intervals
  // would multiply timers by the number of visible sessions.
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))

  // A single observer gates working-indicator animation for all rows in the pane.
  const rowVisibility = new Map<Element, (visible: boolean) => void>()
  let rowVisibilityObserver: IntersectionObserver | undefined
  const observeRowVisibility = (element: Element, update: (visible: boolean) => void) => {
    rowVisibilityObserver ??= new IntersectionObserver((entries) => {
      for (const entry of entries) rowVisibility.get(entry.target)?.(entry.isIntersecting)
    })
    rowVisibility.set(element, update)
    rowVisibilityObserver.observe(element)
    return () => {
      rowVisibility.delete(element)
      rowVisibilityObserver?.unobserve(element)
    }
  }
  onCleanup(() => {
    rowVisibilityObserver?.disconnect()
    rowVisibility.clear()
  })

  // Relative timestamps ("2h", "3d") only change at minute granularity, so
  // they ride a slower shared ticker instead of the 1s one. This also makes
  // them reactive at all: relativeLabel previously read Date.now() inline and
  // could go stale ("now" forever) until an unrelated rerender touched the row.
  const [minuteNow, setMinuteNow] = createSignal(Date.now())
  const minuteTick = setInterval(() => setMinuteNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(minuteTick))

  // The resize handle is an invisible interaction affordance, not first-paint
  // content. Mount it one frame later so its geometry/runtime graph cannot
  // block the sidebar's initial render.
  const [resizeReady, setResizeReady] = createSignal(false)
  let resizeFrame = 0
  onMount(() => {
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0
      setResizeReady(true)
    })
  })
  onCleanup(() => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame)
  })

  // One picker for the pane. Keeping it outside every row's TooltipV2 avoids
  // changing a tooltip trigger from one child to two while its context menu is
  // closing, which would dispose the deferred model popover before it opened.
  const [modelPicker, setModelPicker] = createSignal<SessionModelPickerRequest | null>(null)
  let modelPickerFrame = 0
  const openModelPicker = (request: SessionModelPickerRequest) => {
    if (modelPickerFrame) cancelAnimationFrame(modelPickerFrame)
    modelPickerFrame = requestAnimationFrame(() => {
      modelPickerFrame = 0
      setModelPicker(request)
    })
  }
  onCleanup(() => {
    if (modelPickerFrame) cancelAnimationFrame(modelPickerFrame)
  })

  const permissionState = createMemo(() => permission.ensureServerState(ServerConnection.key(serverSDK().server)))
  const paneServerKey = createMemo(() => {
    try {
      return serverSDK().server ? ServerConnection.key(serverSDK().server) : undefined
    } catch {
      return undefined
    }
  })
  // Same per-server context the titlebar preview reads from — used only by
  // the shared SessionPreviewCard rendered inside the pane's one pooled
  // tooltip portal, for its O(1) peek/telemetry/permission reads.
  const paneServerCtx = createMemo(() => {
    const conn = serverSDK().server
    return conn ? global.ensureServerCtx(conn) : undefined
  })

  const isExpanded = (key: string) => !props.state.isGroupCollapsed(key)
  const toggleExpanded = (key: string) => props.state.toggleGroup(key)

  // Deliberately non-reactive: entries are assigned the first time a session is
  // observed working and deleted when it goes idle, so pinned rows keep their
  // relative arrival order for the whole generation instead of reshuffling.
  const workingArrival = new Map<string, number>()
  let arrivalSeq = 0

  // Reads the global session store directly: telemetry cold-start/live edges
  // reconcile this canonical status projection in server-sync, so the sidebar
  // does not own a second activity signal or any per-row transport.
  const isWorking = (session: Pick<Session, "id">) => {
    if (!session.id) return false
    return serverSync().session.data.session_working(session.id)
  }

  const pinWorkingFirst = (rows: Session[]) => {
    const pinned: Array<{ seq: number; session: Session }> = []
    const rest: Session[] = []
    for (const session of rows) {
      if (!isWorking(session)) {
        workingArrival.delete(session.id)
        rest.push(session)
        continue
      }
      const known = workingArrival.get(session.id)
      const seq = known ?? ++arrivalSeq
      if (known === undefined) workingArrival.set(session.id, seq)
      pinned.push({ seq, session })
    }
    return [...pinned.sort((a, b) => a.seq - b.seq).map((item) => item.session), ...rest]
  }

  // Stage 1 — pure grouping. Deliberately reads NO working-state signals: a
  // working flip must re-run only the cheap pinning pass in `groups` below,
  // never the filters and sorts here. Each directory's root slice is also
  // memoized independently so a session metadata update in one repository
  // cannot make every other opened repository/sandbox filter + sort again.
  // Project aggregates are memoized on top of those slices; the only global
  // work left here is the cross-project Recent merge/sort.
  type OwnedMemo<T> = { read: Accessor<T>; dispose: () => void }
  const directorySlices = new Map<string, OwnedMemo<Session[]>>()
  const projectSlices = new Map<string, OwnedMemo<Session[]>>()
  const projectSliceKey = (project: LocalProject) =>
    [
      pathKey(project.worktree),
      project.id ?? "",
      ...(project.sandboxes ?? []).map((sandbox) => pathKey(sandbox)),
    ].join("\u0000")
  const directorySlice = (dir: string, projectID?: string) => {
    const key = `${pathKey(dir)}\u0000${projectID ?? ""}`
    const cached = directorySlices.get(key)
    if (cached) return cached.read
    const created = runWithOwner(paneOwner, () =>
      createRoot((dispose) => ({
        read: createMemo(() => {
          const sessions = (serverSync().child(dir, { bootstrap: false })[0].session ?? []).map((session) =>
            withDirectory(session, dir),
          )
          return projectID
            ? sessions.filter((session) => chatSidebarRootSessionVisible(session, dir, projectID)).sort(compareSessionTime)
            : sortedRootSessions({ session: sessions, path: { directory: dir } }, 0)
        }),
        dispose,
      })),
    )!
    directorySlices.set(key, created)
    return created.read
  }
  const projectSlice = (project: LocalProject) => {
    const key = projectSliceKey(project)
    const cached = projectSlices.get(key)
    if (cached) return cached.read
    const created = runWithOwner(paneOwner, () =>
      createRoot((dispose) => ({
        read: createMemo(() => {
          // A known project's canonical worktree store is the project-wide,
          // bootstrap-free root Session index. Do not merge sandbox stores back
          // into it: project-scoped roots already include them, and doing so would
          // duplicate the same Session in Recent/project groups. ID-less legacy
          // projects retain the older exact-directory aggregation.
          const rows = project.id
            ? directorySlice(project.worktree, project.id)()
            : [
                ...directorySlice(project.worktree)(),
                ...(project.sandboxes ?? []).flatMap((sandbox) => directorySlice(sandbox)()),
              ]
          return rows.sort(compareSessionTime)
        }),
        dispose,
      })),
    )!
    projectSlices.set(key, created)
    return created.read
  }
  onCleanup(() => {
    for (const entry of projectSlices.values()) entry.dispose()
    for (const entry of directorySlices.values()) entry.dispose()
    directorySlices.clear()
    projectSlices.clear()
  })

  const baseGroups = createMemo(() => {
    const opened = layout.projects.list()
    const canonicalChat = findChatProject(serverSync().data.project)
    const projects: LocalProject[] = canonicalChat
      ? [
          {
            ...(opened.find((project) => isChatProjectAlias(project, canonicalChat)) ?? {}),
            ...canonicalChat,
            name: canonicalChat.name ?? CHAT_PROJECT_NAME,
            worktree: canonicalChat.worktree,
            expanded: true,
          },
          ...opened.filter((project) => !isChatProjectAlias(project, canonicalChat)),
      ]
      : opened.filter((project) => project.id !== "chats" && !isReservedChatProjectPath(project.worktree))
    // Projects/worktrees can be added, removed, and replaced while the sidebar
    // stays mounted. Dispose obsolete memo roots so their child-store
    // subscriptions do not continue reacting to session events forever.
    const activeProjects = new Set(projects.map(projectSliceKey))
    for (const [key, entry] of projectSlices) {
      if (activeProjects.has(key)) continue
      entry.dispose()
      projectSlices.delete(key)
    }
    const activeDirectories = new Set<string>()
    for (const project of projects) {
      if (project.id) {
        activeDirectories.add(`${pathKey(project.worktree)}\u0000${project.id}`)
        continue
      }
      for (const dir of [project.worktree, ...(project.sandboxes ?? [])]) activeDirectories.add(`${pathKey(dir)}\u0000`)
    }
    for (const [key, entry] of directorySlices) {
      if (activeDirectories.has(key)) continue
      entry.dispose()
      directorySlices.delete(key)
    }
    const recentPool: Session[] = []
    const projectRows = new Map<string, Session[]>()
    for (const project of projects) {
      const rows = projectSlice(project)()
      recentPool.push(...rows)
      projectRows.set(project.worktree, rows)
    }
    const recent = uniqueSidebarSessions(recentPool).sort(compareSessionTime)
    if (recent.length > 0) {
      startupMark("sidebar.first-rows", { rows: recent.length, projects: projects.length })
      startupTransportDiagnostic("sidebar.first-rows.transport")
    }
    const projectByID = new Map(projects.flatMap((project) => (project.id ? [[project.id, project] as const] : [])))
    return { projects, projectByID, recentPool: recent, projectRows }
  })

  const visibleRootIDs = createMemo(() => new Set(baseGroups().recentPool.map((session) => session.id)))
  // Hidden structural members (subagents, plugin/native-swarm workers) no
  // longer render inline in the pane — they are reachable through the rich
  // Session preview instead. This projection is still needed for the compact
  // global working-count badge, which must include hidden workers without
  // hydrating them. Legacy per-member resolve() compatibility fallback (for
  // servers predating the lightweight session projection) now lives only in
  // SessionPreviewCard, triggered on demand while a preview is actually open.
  const visibleStructuralGroups = createMemo(() => {
    const roots = visibleRootIDs()
    return sessionGroups
      .list()
      .filter(
        (group) =>
          (group.kind === "swarm" && group.sessions.some((member) => roots.has(member.id))) ||
          ((group.kind === "subagent" || group.kind === "plugin") &&
            !!group.anchorSessionID &&
            roots.has(group.anchorSessionID)),
      )
  })

  // Stage 2 — pinning + assembly. The only stage that reads working state, so
  // a flip storm re-runs just this (~pin cost) while stage 1's sorts stay
  // cached; stableGroups below then finds nothing visibly changed and keeps
  // every row component alive.
  const groups = createMemo<ChatSessionGroup[]>(() => {
    const { projects, projectByID, recentPool, projectRows } = baseGroups()
    const presentRoots = new Set(recentPool.map((session) => session.id))
    for (const sessionID of workingArrival.keys()) {
      if (!presentRoots.has(sessionID)) workingArrival.delete(sessionID)
    }
    const result: ChatSessionGroup[] = []

    if (recentPool.length > 0) {
      const recentOrdered = pinWorkingFirst(recentPool)
      result.push({
        key: "recent",
        label: language.t("chats.group.recent"),
        directory: "",
        sessions: recentOrdered.slice(0, props.state.recentLimit()),
        total: recentOrdered.length,
      })
    }

    for (const project of projects) {
      const rows = pinWorkingFirst(projectRows.get(project.worktree) ?? [])
      if (rows.length === 0 && project.id !== "chats") continue
      const [store] = serverSync().child(project.worktree, { bootstrap: false })
      const meta = (rows[0] ? projectForSession(rows[0], projects, projectByID) : undefined) ?? project
      result.push({
        key: pathKey(project.worktree),
        label: displayName(project),
        directory: project.worktree,
        project: meta,
        sessions: rows,
        // sessionTotal starts at 0 (not undefined) until the first load, so the
        // loaded-row count is the honest fallback while the estimate is cold.
        total: store.sessionTotal > 0 ? store.sessionTotal : rows.length,
      })
    }

    return result
  })

  // <For> keys by reference: without this reuse pass, every groups() recompute
  // (a working flag flipping anywhere, a session list refresh) would produce
  // fresh group objects and tear down + rebuild EVERY section's DOM — all
  // ChatRow subtrees and their IntersectionObservers included. Reusing the
  // previous group object when nothing visible changed keeps row components
  // alive across recomputes; Solid then diffs the inner session lists by the
  // stable per-session references instead of remounting. Same reuse pattern as
  // reuseTimelineRows in timeline/projection.ts.
  const stableGroups = createMemo((previous: ChatSessionGroup[] | undefined) => {
    const next = groups()
    if (!previous) return next
    const byKey = new Map(previous.map((group) => [group.key, group] as const))
    return next.map((group) => {
      const old = byKey.get(group.key)
      if (!old) return group
      if (
        old.label !== group.label ||
        old.directory !== group.directory ||
        old.total !== group.total ||
        old.project !== group.project ||
        !sameRows(old.sessions, group.sessions)
      ) {
        return group
      }
      return old
    })
  })

  // Bootstrap compact metrics once for every session this pane actually
  // renders. Hidden structural members are no longer rendered inline, so they
  // are not warmed here — SessionPreviewCard ensures their telemetry in one
  // coalesced batch only while a preview covering them is open.
  createEffect(() => {
    const ids = new Set<string>()
    for (const group of stableGroups()) {
      // Collapsed groups have no mounted ChatRows. Avoid warming telemetry for
      // their entire loaded session slice until the user expands that group.
      if (!isExpanded(group.key)) continue
      for (const session of group.sessions) ids.add(session.id)
    }
    serverSync().telemetry.ensure(ids)
  })

  // Footer counts server-known roots per directory (sessionTotal estimates),
  // not loaded rows — loaded rows are capped per store and would undercount.
  const totalSessions = createMemo(() =>
    (groups() ?? []).reduce((sum, group) => (group?.key === "recent" ? sum : sum + (group?.total ?? 0)), 0),
  )

  const workingCount = createMemo(() => {
    const seen = new Set<string>()
    for (const session of baseGroups().recentPool) if (isWorking(session)) seen.add(session.id)
    // Structural members may be absent from the loaded root slices. Once their
    // anchor is part of this pane, include their work state in the global badge.
    for (const group of visibleStructuralGroups()) {
      for (const member of group.sessions) if (isWorking(member)) seen.add(member.id)
    }
    return seen.size
  })

  // Reveal-once semantics: the active session's group expands when navigation
  // LANDS on it, never continuously — otherwise collapsing the active group
  // would undo itself on the next store tick and collapse would feel broken.
  // The dir-slug fallback covers sessions that are roots of no listed slice
  // (child sessions, rows beyond the store cap): their project still opens.
  const params = useParams<{
    serverKey?: string
    dir?: string
    id?: string
    sessionId?: string
    activityID?: string
  }>()
  const routing = useIsRouting()
  const [pendingSessionId, setPendingSessionId] = createSignal<string | null>(null)
  // The titlebar navigates to canonical /server/... routes while sidebar rows
  // retain the legacy directory URL. Derive selection from the route's session
  // identity instead of relying on <A>'s URL-matched `active` class.
  const activeSessionId = createMemo(() => params.id ?? params.sessionId)
  let pendingSince = 0
  createEffect(() => {
    const pending = pendingSessionId()
    if (!pending) return
    pendingSince = Date.now()
  })
  createEffect(() => {
    const pending = pendingSessionId()
    if (!pending) return
    if (params.id !== pending) return
    if (routing()) return
    const elapsed = Date.now() - pendingSince
    const minVisible = 550
    if (elapsed < minVisible) {
      const id = setTimeout(() => setPendingSessionId((key) => (key === pending ? null : key)), minVisible - elapsed)
      onCleanup(() => clearTimeout(id))
      return
    }
    setPendingSessionId(null)
  })
  createEffect(() => {
    const pending = pendingSessionId()
    if (!pending) return
    const id = setTimeout(() => setPendingSessionId((key) => (key === pending ? null : key)), 4000)
    onCleanup(() => clearTimeout(id))
  })
  // Reveal-once: expand the Recent/project section containing the navigated
  // session. A hidden structural child (subagent/special agent) is not a root
  // row itself, so fall back to its structural anchor's root — that anchor is
  // always the one whose section actually needs expanding.
  let revealedFor: string | undefined
  createEffect(() => {
    const id = params.id
    if (!id || revealedFor === id) return
    const current = stableGroups()
    const anchorID = sessionGroups
      .list()
      .find((group) => group.sessionIds.includes(id) && !!group.anchorSessionID)?.anchorSessionID
    const target =
      current.find((group) => group.sessions.some((session) => session.id === id || session.id === anchorID))?.key ??
      current.find((group) => group.directory && base64Encode(group.directory) === params.dir)?.key
    if (!target) return
    revealedFor = id
    props.state.revealGroup(target)
  })

  const resizePair = createMemo(() => {
    const group = layout.sessionRow.group()?.()
    const sessionPane = group?.[0]
    if (!sessionPane) return undefined
    return {
      left: {
        size: props.state.sidebarWidth(),
        min: 200,
        max: 420,
        onResize: props.state.resizeSidebar,
        el: () => document.getElementById("chat-sidebar-pane"),
      },
      right: sessionPane,
    }
  })

  // Archiving removes a row from every live group, so it reads as destructive even though it
  // is recoverable. Previously it succeeded silently and failed silently -- the row just
  // vanished, or appeared to do nothing. Confirm the result and carry the inverse action.
  const archiveSession = async (session: Session) => {
    if (!session.id) return
    try {
      await serverSDK().client?.session?.update?.({
        sessionID: session.id,
        directory: session.directory,
        time: { archived: Date.now() },
      })
      showToast({
        title: language.t("chats.archive.done.title"),
        description: sessionTitle(session.title),
        actions: [
          {
            label: language.t("chats.archive.undo"),
            // unarchiveSession already surfaces its own failure toast and rethrows.
            onClick: () => void unarchiveSession(session).catch(() => {}),
          },
        ],
      })
    } catch {
      showToast({
        variant: "error",
        title: language.t("chats.archive.failed.title"),
        description: language.t("chats.archive.failed.description"),
      })
    }
  }

  // ── Archived group ────────────────────────────────────────────────────────
  // Archived roots are filtered out of every live directory store (loadSessions
  // + trimSessions), so they live in this pane-local cache instead: fetched on
  // demand when the group is expanded, never merged into the active stores.
  const [archivedState, setArchivedState] = createStore({
    loading: false,
    fetching: false,
    error: false,
    rows: [] as Session[],
    more: false,
    before: undefined as { archivedAt: number; id: string } | undefined,
  })
  let archivedFetchSeq = 0

  // One request per project slice (worktree + sandboxes), deduped by path —
  // mirrors the directories baseGroups() reads so unarchived rows resurface in
  // exactly the groups this pane renders.
  const archivedDirectories = createMemo(() => {
    const dirs: string[] = []
    const seen = new Set<string>()
    for (const project of layout.projects.list()) {
      for (const dir of [project.worktree, ...(project.sandboxes ?? [])]) {
        const key = pathKey(dir)
        if (seen.has(key)) continue
        seen.add(key)
        dirs.push(dir)
      }
    }
    return dirs
  })

  const fetchArchived = async (reset = true) => {
    const dirs = archivedDirectories()
    const seq = ++archivedFetchSeq
    if (dirs.length === 0) {
      setArchivedState({ loading: false, fetching: false, error: false, rows: [], more: false, before: undefined })
      return
    }
    const cursor = reset ? undefined : archivedState.before
    // Stale-while-revalidate: keep cached rows visible on refetch, only show
    // the skeleton when there is nothing to paint yet.
    setArchivedState({ loading: archivedState.rows.length === 0, fetching: true, error: false })
    try {
      const result = await serverSDK().client.global.archivedSessionRoots({
        globalArchivedSessionRootsInput: {
          directories: dirs,
          limit: 50,
          ...(cursor ? { before: cursor } : {}),
        },
      }, { throwOnError: true })
      if (seq !== archivedFetchSeq) return
      const rows = cursor ? [...archivedState.rows, ...result.data.items] : result.data.items
      setArchivedState({
        rows: uniqueSidebarSessions(rows),
        loading: false,
        fetching: false,
        error: false,
        more: result.data.more,
        before: result.data.before,
      })
    } catch {
      if (seq !== archivedFetchSeq) return
      setArchivedState({ loading: false, fetching: false, error: true })
    }
  }

  // Refetch on every expansion (freshness) while cached rows keep the group
  // responsive; also covers a persisted-expanded group on pane mount.
  createEffect(() => {
    if (!props.state.isArchivedExpanded()) return
    void fetchArchived()
  })

  const showMoreArchived = () => {
    const nextLimit = props.state.archivedLimit() + 5
    props.state.showMoreArchived()
    if (nextLimit >= archivedState.rows.length && archivedState.more && !archivedState.fetching)
      void fetchArchived(false)
  }

  const unarchiveSession = async (session: Session) => {
    if (!session.id) return
    try {
      await serverSDK().client?.session?.update?.({
        sessionID: session.id,
        directory: session.directory,
        // Server contract (httpapi UpdatePayload): `null` clears the archive
        // timestamp; a number archives. Live sync then re-inserts the row
        // into its project group via session.updated.
        time: { archived: null },
      })
      setArchivedState("rows", (rows) => rows.filter((row) => row.id !== session.id))
    } catch (error) {
      // A failed unarchive looks identical to "nothing happened", so say so explicitly, then
      // rethrow so callers (the undo action) can react to the failure too.
      showToast({
        variant: "error",
        title: language.t("chats.unarchive.failed.title"),
        description: language.t("chats.archive.failed.description"),
      })
      throw error
    }
  }

  // Same warm path as tab switching (titlebar-tab-strip.tsx): scope to the
  // session's own directory context and prefetch the first messages before
  // navigation, so the route's mount-time sync() lands on warm stores.
  const prefetchSession = (session: Session) => {
    if (!session.id || !session.directory) return
    try {
      // DirectorySync.session.prefetch is a pure pass-through to this global
      // session store. Avoid constructing a directory context just to warm a
      // session before navigation.
      void serverSync().session.prefetch(session.id, 20).catch(() => {})
    } catch {
      // ignore
    }
  }

  // A session can be presented in both Recent and its project group. Keep the
  // presentation DOM independent, but share all expensive session-derived
  // reactive state between those copies. This preserves the exact UX while
  // preventing duplicate working/notification/permission/message/metrics
  // computation graphs for the same session identity.
  const rowRuntimeEntries = new Map<
    string,
    {
      runtime: ChatRowRuntime
      refs: number
      update: (session: Session) => void
      dispose: () => void
    }
  >()

  const createRowRuntimeEntry = (initial: Session) =>
    createRoot((dispose) => {
      const sessionID = initial.id
      const [fallbackSession, setFallbackSession] = createSignal(initial)
      const session = () => serverSync().session.peek(sessionID) ?? fallbackSession()
      const currentDir = () => session().directory || fallbackSession().directory || ""
      const sessionData = () => serverSync().session.data
      const isWorking = createMemo(() => sessionData().session_working(sessionID))
      const unseenCount = createMemo(() => notification.session.unseenCount(sessionID))
      const hasError = createMemo(() => notification.session.unseenHasError(sessionID))
      const pendingPermissionCount = createMemo(() => {
        const pending = sessionData().permission[sessionID] ?? []
        const directory = currentDir()
        let count = 0
        for (const item of pending) if (!permissionState().autoResponds(item, directory)) count += 1
        return count
      })
      const pendingQuestionCount = createMemo(() => (sessionData().question[sessionID] ?? []).length)
      const hasPermissions = createMemo(() => pendingPermissionCount() > 0)
      const hasQuestions = createMemo(() => pendingQuestionCount() > 0)
      const needsAttention = createMemo(() => hasPermissions() || hasQuestions())
      const isAutoAccepting = createMemo(() => {
        try {
          return permissionState().isAutoAccepting(sessionID, currentDir())
        } catch {
          return false
        }
      })
      const telemetry = createMemo(() => serverSync().telemetry.get(sessionID))
      const aggregateMetrics = createMemo(() => chatSidebarAggregateMetrics(session()))
      const totals = createMemo<ChatRowTotals | undefined>(() => {
        const aggregate = aggregateMetrics()
        const projected = telemetry()
        return {
          generatedSeconds: (projected?.generatedMs ?? 0) / 1000,
          toolSeconds: (projected?.toolMs ?? 0) / 1000,
          cost: aggregate.cost ?? 0,
          cacheHitPercent: aggregate.cacheHitPercent ?? null,
        }
      })
      const contextPercent = createMemo(() => telemetryContextPercent(telemetry()))
      const modelInfo = createMemo(() => {
        const projected = telemetry()
        const model = projected?.context?.model ?? projected?.model
        if (model) return { modelID: model.modelID, name: model.name, variant: model.variant }
        const fallback = aggregateMetrics().model
        return fallback ? { ...fallback, name: undefined } : undefined
      })
      const modelLabel = createMemo(() => {
        const info = modelInfo()
        if (!info) return undefined
        return info.name ?? info.modelID.split("@")[0] ?? info.modelID
      })
      const live = createMemo<ChatRowLive | undefined>(() => {
        if (!isWorking()) return undefined
        now()
        return telemetryLive(
          telemetry(),
          serverSync().telemetry.receivedAt(sessionID),
          sessionTelemetryClientNow(),
        )
      })

      return {
        runtime: {
          session,
          currentDir,
          isWorking,
          unseenCount,
          hasError,
          pendingPermissionCount,
          pendingQuestionCount,
          hasPermissions,
          hasQuestions,
          needsAttention,
          isAutoAccepting,
          totals,
          contextPercent,
          modelInfo,
          modelLabel,
          live,
          serverKey: paneServerKey,
        } satisfies ChatRowRuntime,
        update: (next: Session) => setFallbackSession(next),
        dispose,
      }
    }, paneOwner)

  const leaseRowRuntime = (session: Session): ChatRowRuntimeLease => {
    let entry = rowRuntimeEntries.get(session.id)
    if (!entry) {
      const created = createRowRuntimeEntry(session)
      entry = { ...created, refs: 0 }
      rowRuntimeEntries.set(session.id, entry)
    }
    entry.update(session)
    entry.refs += 1
    let released = false
    return {
      runtime: entry.runtime,
      release: () => {
        if (released) return
        released = true
        const current = rowRuntimeEntries.get(session.id)
        if (current !== entry) return
        current.refs -= 1
        if (current.refs > 0) return
        rowRuntimeEntries.delete(session.id)
        current.dispose()
      },
    }
  }

  onCleanup(() => {
    for (const entry of rowRuntimeEntries.values()) entry.dispose()
    rowRuntimeEntries.clear()
  })

  // Dense sidebars cannot afford one Kobalte/floating-ui controller per
  // tooltip anchor. Follow the model selector's proven architecture instead:
  // one pane-level intent controller, one portal, one positioning RAF, and at
  // most one MutationObserver (only while a dynamic plain-text tooltip is
  // actually open). Rows publish metadata through data attributes; pointer and
  // focus intent is handled here via event delegation.
  let paneElement: HTMLDivElement | undefined
  let sharedTooltipElement: HTMLDivElement | undefined
  let tooltipOpenTimer: ReturnType<typeof setTimeout> | undefined
  let tooltipCloseGraceTimer: ReturnType<typeof setTimeout> | undefined
  let tooltipPositionFrame = 0
  let pendingTooltip: ChatSidebarTooltipIntent | undefined
  let suppressedTooltipAnchor: HTMLElement | undefined
  let lastTooltipClosedAt = 0
  let describedTooltipAnchor: HTMLElement | undefined
  let tooltipTextObserver: MutationObserver | undefined
  const sharedTooltipID = "chat-sidebar-shared-tooltip"
  const [sharedTooltip, setSharedTooltip] = createSignal<ChatSidebarTooltipIntent>()
  const [sharedTooltipText, setSharedTooltipText] = createSignal("")
  const [sharedTooltipPosition, setSharedTooltipPosition] = createSignal<{ x: number; y: number }>()
  // The rich card is a pane-scoped surface, not a free-floating window
  // tooltip — it must never extend beyond the sidebar pane's own vertical
  // extent, however tall the viewport is.
  const [sharedTooltipMaxHeight, setSharedTooltipMaxHeight] = createSignal<number>()
  // True while a row's context menu (rendered by the rich SessionPreviewCard)
  // is open, or while the pointer is over the card itself — both must delay
  // the normal pointerout-driven close for safe row<->card crossing.
  const [sharedTooltipCardContextMenuOpen, setSharedTooltipCardContextMenuOpen] = createSignal(false)
  let sharedTooltipCardHovered = false

  const clearTooltipDescription = () => {
    const anchor = describedTooltipAnchor
    if (!anchor) return
    const tokens = (anchor.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((token) => token && token !== sharedTooltipID)
    if (tokens.length) anchor.setAttribute("aria-describedby", tokens.join(" "))
    else anchor.removeAttribute("aria-describedby")
    describedTooltipAnchor = undefined
  }

  const describeTooltipAnchor = (anchor: HTMLElement) => {
    clearTooltipDescription()
    const tokens = new Set((anchor.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean))
    tokens.add(sharedTooltipID)
    anchor.setAttribute("aria-describedby", [...tokens].join(" "))
    describedTooltipAnchor = anchor
  }

  const stopTooltipTextObserver = () => {
    tooltipTextObserver?.disconnect()
  }

  const syncTooltipText = (intent: ChatSidebarTooltipIntent) => {
    stopTooltipTextObserver()
    if (intent.sessionID) {
      setSharedTooltipText("")
      return
    }
    const read = () => setSharedTooltipText(intent.anchor.dataset.chatTooltipText ?? intent.text ?? "")
    read()
    const Observer = intent.anchor.ownerDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver
    tooltipTextObserver ??= new Observer(() => {
      const current = sharedTooltip()
      if (!current || current.sessionID) return
      setSharedTooltipText(current.anchor.dataset.chatTooltipText ?? current.text ?? "")
    })
    tooltipTextObserver.observe(intent.anchor, {
      attributes: true,
      attributeFilter: ["data-chat-tooltip-text"],
    })
  }

  const closeSharedTooltip = (anchor?: HTMLElement) => {
    if (pendingTooltip && (!anchor || pendingTooltip.anchor === anchor)) pendingTooltip = undefined
    if (tooltipOpenTimer !== undefined) {
      clearTimeout(tooltipOpenTimer)
      tooltipOpenTimer = undefined
    }
    if (tooltipCloseGraceTimer !== undefined) {
      clearTimeout(tooltipCloseGraceTimer)
      tooltipCloseGraceTimer = undefined
    }
    const current = sharedTooltip()
    if (anchor && current?.anchor !== anchor) return
    if (!current) return
    // A row's context menu is portalled outside this subtree. Keep the rich
    // card mounted while it is open, or moving the pointer into the menu
    // would dispose the row (and therefore the menu) underneath the user —
    // mirrors the titlebar preview's own context-menu-open guard.
    if (current.sessionID && sharedTooltipCardContextMenuOpen()) return
    clearTooltipDescription()
    stopTooltipTextObserver()
    setSharedTooltip(undefined)
    setSharedTooltipPosition(undefined)
    setSharedTooltipMaxHeight(undefined)
    lastTooltipClosedAt = performance.now()
  }

  const updateSharedTooltipPosition = () => {
    const intent = sharedTooltip()
    if (!intent) return
    const anchor = intent.anchor
    if (!anchor.isConnected || !paneElement?.contains(anchor)) {
      closeSharedTooltip(anchor)
      return
    }
    const rect = anchor.getBoundingClientRect()
    const paneRect = paneElement.getBoundingClientRect()
    if (
      rect.width === 0 ||
      rect.height === 0 ||
      rect.bottom <= paneRect.top ||
      rect.top >= paneRect.bottom ||
      rect.right <= paneRect.left ||
      rect.left >= paneRect.right
    ) {
      closeSharedTooltip(anchor)
      return
    }

    const measured = sharedTooltipElement?.getBoundingClientRect()
    const width = Math.max(1, measured?.width || (intent.sessionID ? 260 : 120))
    const height = Math.max(1, measured?.height || (intent.sessionID ? 150 : 24))
    const margin = 12
    const gutter = intent.sessionID ? 8 : 6

    // Cap the rich card's own height to what actually fits inside the pane
    // before using it for placement math, so a tall relationship list never
    // pushes the card past the pane's top/bottom edge — it grows its own
    // internal scroll region instead.
    const paneMargin = 8
    const maxHeight = intent.sessionID ? Math.max(120, paneRect.height - paneMargin * 2) : undefined
    if (sharedTooltipMaxHeight() !== maxHeight) setSharedTooltipMaxHeight(maxHeight)
    const cappedHeight = maxHeight !== undefined ? Math.min(height, maxHeight) : height

    let x = rect.left + (rect.width - width) / 2
    let y = rect.top - cappedHeight - gutter

    if (intent.placement === "right") {
      x = rect.right + gutter
      y = rect.top
      if (x + width > window.innerWidth - margin) x = rect.left - width - gutter
    } else if (intent.placement === "bottom") {
      y = rect.bottom + gutter
      if (y + cappedHeight > window.innerHeight - margin) y = rect.top - cappedHeight - gutter
    } else if (y < margin) {
      y = rect.bottom + gutter
    }

    x = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin))
    // The rich card is clamped to the pane's own bounds — a pane-scoped
    // surface, not a free-floating window tooltip. Plain-text micro-tooltips
    // keep the ordinary viewport clamp.
    y = intent.sessionID
      ? Math.min(
          Math.max(paneRect.top + paneMargin, y),
          Math.max(paneRect.top + paneMargin, paneRect.bottom - paneMargin - cappedHeight),
        )
      : Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - cappedHeight - margin))
    const current = sharedTooltipPosition()
    const next = { x: Math.round(x), y: Math.round(y) }
    if (current?.x === next.x && current.y === next.y) return
    setSharedTooltipPosition(next)
  }

  const queueSharedTooltipPosition = () => {
    if (tooltipPositionFrame) return
    tooltipPositionFrame = requestAnimationFrame(() => {
      tooltipPositionFrame = 0
      updateSharedTooltipPosition()
    })
  }

  const showSharedTooltip = (intent: ChatSidebarTooltipIntent) => {
    if (!intent.anchor.isConnected || suppressedTooltipAnchor === intent.anchor) return
    pendingTooltip = undefined
    if (tooltipOpenTimer !== undefined) {
      clearTimeout(tooltipOpenTimer)
      tooltipOpenTimer = undefined
    }
    if (tooltipCloseGraceTimer !== undefined) {
      clearTimeout(tooltipCloseGraceTimer)
      tooltipCloseGraceTimer = undefined
    }
    const current = sharedTooltip()
    if (current?.anchor === intent.anchor && current.sessionID === intent.sessionID) {
      syncTooltipText(intent)
      queueSharedTooltipPosition()
      return
    }
    describeTooltipAnchor(intent.anchor)
    syncTooltipText(intent)
    setSharedTooltip(intent)
    setSharedTooltipPosition(undefined)
    // Paint immediately from the cheap fallback size so an occluded/throttled
    // Electron renderer never waits on requestAnimationFrame just to make the
    // tooltip visible. The portal ref schedules one RAF afterward to refine
    // placement using the measured dimensions.
    updateSharedTooltipPosition()
  }

  const scheduleSharedTooltip = (intent: ChatSidebarTooltipIntent) => {
    if (suppressedTooltipAnchor === intent.anchor) return
    const current = sharedTooltip()
    if (current?.anchor === intent.anchor) return
    if (tooltipOpenTimer !== undefined) clearTimeout(tooltipOpenTimer)
    pendingTooltip = intent
    // Match TooltipV2's 400ms initial intent while preserving the familiar
    // fast handoff between neighboring tooltip targets.
    const skipDelay = !!current || performance.now() - lastTooltipClosedAt < 300
    if (skipDelay) {
      showSharedTooltip(intent)
      return
    }
    tooltipOpenTimer = setTimeout(() => {
      tooltipOpenTimer = undefined
      if (pendingTooltip !== intent) return
      showSharedTooltip(intent)
    }, 400)
  }

  const tooltipAnchorFrom = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return undefined
    // A row's mini-tooltips (context %, cache hit, permission/question
    // badges, archive button, ...) each carry their own data-chat-tooltip-text
    // and live INSIDE that row's data-chat-tooltip-session wrapper. Plain
    // closest() would resolve to whichever is nearer to the actual pointer
    // target, so drifting over any of those nested elements swapped the
    // "intent" out from under the rich card and tore it down. The row-level
    // session anchor always wins over a nested text anchor: the whole row is
    // one hover surface, and the rich card already supersedes these micro
    // tooltips while it owns that surface.
    const sessionAnchor = target.closest<HTMLElement>("[data-chat-tooltip-session]")
    if (sessionAnchor && paneElement?.contains(sessionAnchor)) return sessionAnchor
    const anchor = target.closest<HTMLElement>("[data-chat-tooltip-text]")
    if (!anchor || !paneElement?.contains(anchor)) return undefined
    return anchor
  }

  const tooltipIntentFrom = (anchor: HTMLElement): ChatSidebarTooltipIntent | undefined => {
    const sessionID = anchor.dataset.chatTooltipSession
    const text = anchor.dataset.chatTooltipText
    if (!sessionID && text === undefined) return undefined
    const requested = anchor.dataset.chatTooltipPlacement
    const placement: ChatSidebarTooltipPlacement =
      requested === "right" || requested === "bottom" || requested === "top"
        ? requested
        : sessionID
          ? "right"
          : "top"
    return { anchor, placement, sessionID, text }
  }

  const handleTooltipPointerOver = (event: PointerEvent) => {
    const next = tooltipAnchorFrom(event.target)
    const previous = tooltipAnchorFrom(event.relatedTarget)
    if (!next || next === previous) return
    if (suppressedTooltipAnchor && suppressedTooltipAnchor !== next) suppressedTooltipAnchor = undefined
    const intent = tooltipIntentFrom(next)
    if (intent) scheduleSharedTooltip(intent)
  }

  // The rich card is a `<Portal>` sibling, not a DOM descendant of the row —
  // there is a real pixel gap between them. Closing synchronously the instant
  // the pointer leaves the row (as plain-text tooltips do) means the card
  // vanishes before the pointer can ever reach it. Give the rich card a short
  // grace window instead, cancelled the moment the pointer actually reaches
  // it (card's own onPointerEnter) or re-enters the row.
  const scheduleCloseSharedTooltip = (anchor: HTMLElement) => {
    const current = sharedTooltip()
    if (current?.anchor !== anchor) return
    if (!current.sessionID) {
      closeSharedTooltip(anchor)
      return
    }
    if (tooltipCloseGraceTimer !== undefined) clearTimeout(tooltipCloseGraceTimer)
    tooltipCloseGraceTimer = setTimeout(() => {
      tooltipCloseGraceTimer = undefined
      if (sharedTooltipCardHovered || sharedTooltipCardContextMenuOpen()) return
      if (anchor.matches(":hover")) return
      closeSharedTooltip(anchor)
    }, 200)
  }

  const handleTooltipPointerOut = (event: PointerEvent) => {
    const previous = tooltipAnchorFrom(event.target)
    const next = tooltipAnchorFrom(event.relatedTarget)
    if (!previous || previous === next) return
    if (suppressedTooltipAnchor === previous) suppressedTooltipAnchor = undefined
    if (next) {
      const intent = tooltipIntentFrom(next)
      if (intent) scheduleSharedTooltip(intent)
      return
    }
    scheduleCloseSharedTooltip(previous)
  }

  const handleTooltipFocusIn = (event: FocusEvent) => {
    const anchor = tooltipAnchorFrom(event.target)
    if (!anchor) return
    const intent = tooltipIntentFrom(anchor)
    if (intent) scheduleSharedTooltip(intent)
  }

  const handleTooltipFocusOut = (event: FocusEvent) => {
    const previous = tooltipAnchorFrom(event.target)
    const next = tooltipAnchorFrom(event.relatedTarget)
    if (!previous || previous === next) return
    if (next) {
      const intent = tooltipIntentFrom(next)
      if (intent) scheduleSharedTooltip(intent)
      return
    }
    closeSharedTooltip(previous)
  }

  const suppressTooltipFrom = (target: EventTarget | null) => {
    const anchor = tooltipAnchorFrom(target)
    if (!anchor) return
    suppressedTooltipAnchor = anchor
    closeSharedTooltip(anchor)
  }

  const sharedTooltipRuntime = createMemo(() => {
    const sessionID = sharedTooltip()?.sessionID
    return sessionID ? rowRuntimeEntries.get(sessionID)?.runtime : undefined
  })

  const sharedTooltipSession = createMemo(() => sharedTooltipRuntime()?.session())
  const sharedTooltipProjectName = () => {
    const session = sharedTooltipSession()
    if (!session) return ""
    const name = (session as Session & { projectName?: string }).projectName
    if (name) return name
    const dir = session.directory || sharedTooltipRuntime()?.currentDir() || ""
    const segs = dir.replace(/\\/g, "/").split("/").filter(Boolean)
    return segs[segs.length - 1] ?? dir
  }
  // Feeds the shared rich SessionPreviewCard — same canonical card/model the
  // titlebar tab popover renders. Computed only while the rich branch of the
  // pooled tooltip is actually showing (sharedTooltip()?.sessionID set).
  const sharedTooltipData = createMemo(() => {
    const session = sharedTooltipSession()
    if (!session) return undefined
    const branch = (session as Session & { branch?: string; vcsBranch?: string }).branch ?? undefined
    return {
      project: projectForSession(session, layout.projects.list()),
      directory: session.directory,
      projectName: sharedTooltipProjectName(),
      title: sessionTitle(session.title),
      path: session.directory,
      branch,
    }
  })
  const sharedTooltipRelationships = createMemo(() => {
    const sessionID = sharedTooltip()?.sessionID
    return sessionID ? sessionPreviewRelationships({ sessionID, groups: sessionGroups.list() }) : undefined
  })

  createEffect(() => {
    void sharedTooltip()
    queueSharedTooltipPosition()
  })

  // Safety net: every close path above depends on a specific event actually
  // arriving (pointerout on the row, pointerleave on the portalled card, a
  // context menu announcing its own close). Any one of those can be missed —
  // a fast pointer exit past the OS window edge routinely drops the trailing
  // pointerout/pointerleave in Electron/Windows — and once that happens the
  // rich card is stuck open with no future event left to close it. Poll the
  // authoritative `:hover` pseudo-state instead of trusting only tracked
  // flags, and force-close (bypassing every other guard, including a
  // context-menu-open flag that itself may be the thing that desynced) once
  // the pointer has genuinely been away for a short window.
  createEffect(() => {
    const intent = sharedTooltip()
    if (!intent?.sessionID) return
    let awayTicks = 0
    const POLL_MS = 400
    const AWAY_TICKS_TO_CLOSE = 3
    const timer = setInterval(() => {
      const stillNear = intent.anchor.matches(":hover") || !!sharedTooltipElement?.matches(":hover")
      if (stillNear) {
        awayTicks = 0
        return
      }
      awayTicks += 1
      if (awayTicks < AWAY_TICKS_TO_CLOSE) return
      clearTooltipDescription()
      stopTooltipTextObserver()
      setSharedTooltip(undefined)
      setSharedTooltipPosition(undefined)
      setSharedTooltipMaxHeight(undefined)
      setSharedTooltipCardContextMenuOpen(false)
      sharedTooltipCardHovered = false
      lastTooltipClosedAt = performance.now()
    }, POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  // Electron/OS focus loss (alt-tab, clicking another window) is another
  // event class that can leave the pointer state stale — the watchdog above
  // still catches it within ~1.2s, but closing immediately on blur is both
  // cheap and the behavior users actually expect.
  onMount(() => {
    const onBlur = () => closeSharedTooltip()
    window.addEventListener("blur", onBlur)
    onCleanup(() => window.removeEventListener("blur", onBlur))
  })

  onMount(() => {
    const reposition = () => queueSharedTooltipPosition()
    paneElement?.addEventListener("scroll", reposition, true)
    window.addEventListener("resize", reposition)
    onCleanup(() => {
      paneElement?.removeEventListener("scroll", reposition, true)
      window.removeEventListener("resize", reposition)
    })
  })

  onCleanup(() => {
    if (tooltipOpenTimer !== undefined) clearTimeout(tooltipOpenTimer)
    if (tooltipCloseGraceTimer !== undefined) clearTimeout(tooltipCloseGraceTimer)
    if (tooltipPositionFrame) cancelAnimationFrame(tooltipPositionFrame)
    clearTooltipDescription()
    stopTooltipTextObserver()
  })

  const navigate = useNavigate()

  const navigateToNewSession = (directory?: string) => {
    const dir = directory || layout.projects.list()[0]?.worktree || ""
    navigate(`/${base64Encode(dir)}/session`)
  }

  // Search is interactive, not first-paint content. Keep a tiny local input
  // buffer and instantiate the real Home search controller only on first focus
  // or input. runWithOwner is required because the dynamically imported
  // controller installs Solid effects/cleanup and reads app contexts.
  const searchOwner = getOwner()
  const [searchRuntime, setSearchRuntime] = createSignal<ChatSidebarSearchRuntime>()
  const [searchDraft, setSearchDraft] = createSignal("")
  let searchRuntimePending: Promise<ChatSidebarSearchRuntime | undefined> | undefined
  let searchRootElement: HTMLDivElement | undefined
  let searchInputElement: HTMLInputElement | undefined
  let searchFocused = false
  let searchDisposed = false

  const ensureSearchRuntime = () => {
    const current = searchRuntime()
    if (current) return Promise.resolve(current)
    if (searchRuntimePending) return searchRuntimePending
    searchRuntimePending = loadChatSidebarSearchRuntime().then((module) => {
      if (searchDisposed || !searchOwner) return undefined
      const runtime = runWithOwner(searchOwner, () => module.createChatSidebarSearchRuntime({ prefetchSession }))
      if (!runtime || searchDisposed) return undefined
      if (searchRootElement) runtime.search.element.setRoot(searchRootElement)
      if (searchInputElement) runtime.search.element.setInput(searchInputElement)
      const draft = searchDraft()
      if (draft) runtime.search.query.input(draft)
      if (searchFocused) runtime.search.query.focus()
      setSearchRuntime(runtime)
      return runtime
    })
    return searchRuntimePending
  }

  onCleanup(() => {
    searchDisposed = true
  })

  return (
    <div
      ref={(element) => {
        paneElement = element
      }}
      id="chat-sidebar-pane"
      class="relative my-2 ms-2 flex min-h-0 shrink-0 select-none flex-col self-stretch overflow-hidden rounded-[7px] border border-v2-border-border-base/60 bg-v2-background-bg-base shadow-[0_1px_2px_0_var(--v2-alpha-dark-6),0_1px_3px_0_var(--v2-alpha-dark-4),0_0_0_0.5px_var(--v2-alpha-dark-8)]"
      style={{ width: `${props.state.sidebarWidth()}px` }}
      data-chat-sidebar-pane
      onPointerOver={handleTooltipPointerOver}
      onPointerOut={handleTooltipPointerOut}
      onFocusIn={handleTooltipFocusIn}
      onFocusOut={handleTooltipFocusOut}
      onPointerDown={(event: PointerEvent) => suppressTooltipFrom(event.target)}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") suppressTooltipFrom(event.target)
      }}
      onContextMenu={(event) => suppressTooltipFrom(event.target)}
    >
      {/* ── Title bar — zinc/IDE dense header ─────────────────── */}
      <div class="flex h-8 shrink-0 items-center gap-1.5 border-b border-v2-border-border-muted/60 bg-v2-background-bg-base px-2">
        <span class="select-none text-[10px] font-[620] uppercase leading-none tracking-[0.09em] text-v2-text-text-muted">
          {language.t("chats.title")}
        </span>
        <Show when={workingCount() > 0}>
          <span
            data-chat-tooltip-text={language.plural("chats.footer.active", workingCount())}
            data-chat-tooltip-placement="bottom"
            class="flex items-center gap-1 rounded-[4px] bg-v2-state-bg-success px-1 py-[2px] text-[9px] font-[600] leading-none tabular-nums text-v2-state-fg-success ring-1 ring-inset ring-v2-state-fg-success/20"
          >
            <span class="size-1 animate-pulse rounded-full bg-v2-state-fg-success" />
            {workingCount()}
          </span>
        </Show>

        <div class="ms-auto flex items-center gap-0.5">
          <span
            class="flex"
            data-chat-tooltip-text={language.t("scheduledTasks.title")}
            data-chat-tooltip-placement="bottom"
          >
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              onClick={() => navigate("/scheduled")}
              aria-label={language.t("scheduledTasks.title")}
              icon={<IconV2 name="clock" />}
            />
          </span>
          <span class="flex" data-chat-tooltip-text={language.t("usage.panel.title")} data-chat-tooltip-placement="bottom">
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              onClick={() => navigate("/usage")}
              aria-label={language.t("usage.panel.title")}
              icon={<IconV2 name="usage" />}
            />
          </span>
          <span class="flex" data-chat-tooltip-text={language.t("command.session.new")} data-chat-tooltip-placement="bottom">
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              onClick={() => navigateToNewSession()}
              aria-label={language.t("command.session.new")}
              icon={<IconV2 name="plus" />}
            />
          </span>
          <span class="flex" data-chat-tooltip-text={language.t("common.collapse")} data-chat-tooltip-placement="bottom">
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              onClick={props.onClose}
              aria-label={language.t("common.collapse")}
              aria-expanded={props.opened}
              aria-controls="chat-sidebar-pane"
              icon={<IconV2 name="close" />}
            />
          </span>
        </div>
      </div>

      {/* ── Session search — zinc inset field ─────────────────── */}
      <div class="shrink-0 bg-v2-background-bg-base px-2 pb-1.5 pt-1.5">
        <div
          ref={(element) => {
            searchRootElement = element
            searchRuntime()?.search.element.setRoot(element)
          }}
          data-component="chats-session-search"
          class="relative z-30 w-full"
        >
          <Show when={searchRuntime()} keyed>
            {(runtime) => <Show when={runtime.search.query.open()}>
            <div
              data-component="chats-session-search-panel"
              class="absolute flex flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
              style={{ top: "-4px", left: "-4px", width: "calc(100% + 8px)" }}
            >
              <div class="flex flex-col pt-8">
                <Suspense
                  fallback={
                    <div
                      class="flex flex-col gap-px px-3 py-2"
                      aria-busy="true"
                      aria-label={language.t("common.loading")}
                    >
                      <For each={[0, 1, 2]}>
                        {() => <div class="h-7 rounded-[6px] bg-v2-background-bg-layer-02 animate-pulse" />}
                      </For>
                    </div>
                  }
                >
                  <ChatSidebarSearchResults
                    language={language}
                    search={runtime.search}
                    server={runtime.serverKey}
                    isOpenTab={runtime.isOpenTab}
                  />
                </Suspense>
              </div>
            </div>
            </Show>}
          </Show>
          <label class="relative z-20 flex h-[24px] w-full items-center gap-1.5 rounded-[6px] border border-v2-border-border-base/60 bg-v2-background-bg-layer-01 px-1.5 text-v2-icon-icon-muted shadow-[inset_0_1px_1px_var(--v2-alpha-dark-6),inset_0_0.5px_0.5px_var(--v2-alpha-dark-4)] transition-[border-color,background-color,box-shadow] duration-150 hover:border-v2-border-border-base hover:bg-v2-background-bg-layer-02 focus-within:border-v2-border-border-strong focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_2px_var(--v2-alpha-dark-8)]">
            <IconV2 name="magnifying-glass" size="small" class="shrink-0 opacity-80" />
            <input
              ref={(element) => {
                searchInputElement = element
                searchRuntime()?.search.element.setInput(element)
              }}
              class="relative z-20 min-w-0 flex-1 border-0 bg-transparent text-[12px] font-[440] leading-none tracking-[-0.01em] text-v2-text-text-base outline-0 placeholder:text-v2-text-text-faint/70 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
              type="text"
              value={searchRuntime()?.search.query.value() ?? searchDraft()}
              placeholder={language.t("chats.search.placeholder")}
              aria-label={language.t("chats.search.placeholder")}
              aria-expanded={searchRuntime()?.search.query.open() ?? false}
              aria-controls="chats-session-search-results"
              aria-autocomplete="list"
              aria-activedescendant={
                searchRuntime()?.search.result.active() && searchRuntime()?.search.query.open()
                  ? `chats-session-search-option-${searchRuntime()!.search.result.active()}`
                  : undefined
              }
              onFocus={() => {
                searchFocused = true
                void ensureSearchRuntime()
              }}
              onBlur={() => {
                searchFocused = false
              }}
              onInput={(event) => {
                const value = event.currentTarget.value
                setSearchDraft(value)
                const runtime = searchRuntime()
                if (runtime) {
                  runtime.search.query.input(value)
                  return
                }
                // The loader replays the latest draft exactly once when it
                // resolves. Do not attach one continuation per keystroke while
                // the chunk is in flight; that would manufacture a microtask
                // burst and repeatedly reset the search debounce.
                void ensureSearchRuntime()
              }}
              onKeyDown={(event) => {
                const runtime = searchRuntime()
                if (event.key === "Escape") {
                  event.preventDefault()
                  if (runtime) runtime.search.query.close()
                  else setSearchDraft("")
                  event.currentTarget.blur()
                  return
                }
                if (!runtime || !runtime.search.query.open() || runtime.search.result.list().length === 0) return
                if (event.altKey || event.metaKey) return
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  runtime.search.result.move(1)
                  return
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault()
                  runtime.search.result.move(-1)
                  return
                }
                if (event.key === "Enter" && !event.isComposing) {
                  event.preventDefault()
                  runtime.search.result.selectActive()
                }
              }}
            />
            <Show when={searchRuntime()?.search.query.value() ?? searchDraft()}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="relative z-20 shrink-0"
                icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
                aria-label={language.t("chats.search.placeholder")}
                onClick={() => {
                  setSearchDraft("")
                  const runtime = searchRuntime()
                  if (runtime) {
                    runtime.search.query.close()
                    runtime.search.query.focus()
                    return
                  }
                  searchInputElement?.focus()
                  searchFocused = true
                  void ensureSearchRuntime()
                }}
              />
            </Show>
          </label>
        </div>
      </div>

      {/* ── Session tree ──────────────────────────────────────── */}
      <ScrollView class="min-h-0 flex-1">
        <Show when={oxpActivity.activities().length > 0}>
          <section
            class="flex flex-col border-b border-v2-border-border-muted pb-1.5"
            data-component="chats-oxp-activity-group"
          >
            <div class="sticky top-0 z-10 flex h-[22px] items-center gap-1.5 bg-v2-background-bg-base/95 px-2 backdrop-blur-[6px]">
              <span class="min-w-0 flex-1 truncate text-[10px] font-[620] uppercase leading-none tracking-[0.07em] text-v2-text-text-faint">
                CHATGPT / OXP
              </span>
              <span class="shrink-0 text-[10px] tabular-nums text-v2-text-text-faint opacity-70">
                {oxpActivity.activities().length}
              </span>
            </div>
            <nav class="flex flex-col px-1">
              <For each={visibleOxpActivities()}>
                {(activity) => {
                  const failures = () => Number(activity.failureCount) || 0
                  const calls = () => Number(activity.callCount) || 0
                  const selected = () => params.activityID === activity.id
                  return (
                    <button
                      type="button"
                      data-component="chats-oxp-activity-row"
                      data-activity-id={activity.id}
                      class="group/oxp flex min-h-[34px] min-w-0 items-center gap-2 rounded-[5px] px-2 text-left transition-colors hover:bg-v2-background-bg-layer-01 focus-visible:bg-v2-background-bg-layer-01 focus-visible:outline-none"
                      classList={{
                        "bg-v2-background-bg-layer-02": selected(),
                      }}
                      onClick={() => navigate(`/oxp/activity/${activity.id}`)}
                    >
                      <span
                        class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-muted"
                        classList={{
                          "opacity-100": failures() === 0,
                          "bg-v2-state-fg-danger": failures() > 0,
                        }}
                      />
                      <span class="flex min-w-0 flex-1 flex-col gap-[2px]">
                        <span class="truncate text-[11px] font-[520] leading-[14px] text-v2-text-text-base">
                          {activity.title ??
                            activity.lastRootAlias ??
                            "ChatGPT activity"}
                        </span>
                        <span class="truncate text-[9.5px] leading-[12px] tabular-nums text-v2-text-text-faint">
                          {calls()} calls
                          {failures() > 0 ? ` · ${failures()} failed` : ""}
                          {" · "}
                          {relativeStamp(activity.lastSeenAt, minuteNow())}
                        </span>
                      </span>
                    </button>
                  )
                }}
              </For>
              <Show when={oxpActivity.activities().length > oxpLimit()}>
                <button
                  type="button"
                  class="ms-5 flex h-6 items-center rounded-md px-1 text-start text-[10px] text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-01 focus-visible:outline-none"
                  onClick={() =>
                    setOxpLimit((current) =>
                      Math.min(current + 10, oxpActivity.activities().length),
                    )
                  }
                >
                  Show {Math.min(10, oxpActivity.activities().length - oxpLimit())} more
                </button>
              </Show>
              <Show
                when={
                  oxpActivity.activities().length <= oxpLimit() &&
                  oxpActivity.hasMoreActivities()
                }
              >
                <button
                  type="button"
                  disabled={oxpActivity.loadingMoreActivities()}
                  class="ms-5 flex h-6 items-center rounded-md px-1 text-start text-[10px] text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-01 focus-visible:outline-none disabled:opacity-50"
                  onClick={() => {
                    void oxpActivity.loadOlderActivities().then(() => {
                      setOxpLimit((current) => current + 10)
                    })
                  }}
                >
                  {oxpActivity.loadingMoreActivities()
                    ? "Loading older activity…"
                    : "Load older activity"}
                </button>
              </Show>
            </nav>
          </section>
        </Show>

        <Show
          when={(groups() ?? []).length > 0}
          fallback={
            <div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <IconV2 name="chats" size="small" class="size-5 text-v2-icon-icon-muted opacity-60" />
              <span class="text-[11px] leading-none text-v2-text-text-faint">{language.t("chats.empty")}</span>
            </div>
          }
        >
          <div class="flex flex-col pb-2">
            <For each={stableGroups()}>
              {(group, index) => (
                <section class="flex flex-col pt-1.5 first:pt-0">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(group.key)}
                    aria-expanded={isExpanded(group.key)}
                    aria-controls={`chats-group-${index()}`}
                    class="group/head sticky top-0 z-10 flex h-[22px] shrink-0 items-center gap-1.5 border-y border-transparent bg-v2-background-bg-base/95 px-2 text-left backdrop-blur-[6px] transition-colors hover:border-y-v2-border-border-muted/40 hover:bg-v2-background-bg-layer-01 focus-visible:bg-v2-background-bg-layer-01 focus-visible:outline-none"
                  >
                    <IconV2
                      name="chevron-down"
                      size="small"
                      class={`size-3 shrink-0 text-v2-icon-icon-muted transition-transform duration-150 ${
                        isExpanded(group.key) ? "" : "-rotate-90"
                      }`}
                    />
                    <Show when={group.project}>
                      {(project) => (
                        <ProjectAvatar
                          class="shrink-0 !size-3.25"
                          fallback={displayName(project())}
                          src={getProjectAvatarSource(project().id, project().icon)}
                          variant={getProjectAvatarVariant(project().icon?.color)}
                        />
                      )}
                    </Show>
                    <span class="min-w-0 flex-1 truncate text-[10px] font-[560] uppercase leading-none tracking-[0.06em] text-v2-text-text-faint transition-colors group-hover/head:text-v2-text-text-muted">
                      {group.label}
                    </span>
                    <Show when={group.directory}>
                      <span class="min-w-0 max-w-[45%] shrink truncate text-[9px] leading-none text-v2-text-text-faint opacity-60">
                        {group.directory}
                      </span>
                    </Show>
                    <span class="shrink-0 text-[10px] leading-none tabular-nums text-v2-text-text-faint opacity-70">
                      {group.total}
                    </span>
                    <Show when={group.directory}>
                      <span
                        role="button"
                        tabIndex={0}
                        data-chat-tooltip-text={language.t("command.session.new")}
                        data-chat-tooltip-placement="top"
                        class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-v2-text-text-faint hover:bg-v2-background-bg-layer-03 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-base"
                        aria-label={language.t("command.session.new")}
                        onClick={(event) => {
                          event.stopPropagation()
                          event.preventDefault()
                          navigateToNewSession(group.directory)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.stopPropagation()
                            event.preventDefault()
                            navigateToNewSession(group.directory)
                          }
                        }}
                      >
                        <IconV2 name="plus" size="small" />
                      </span>
                    </Show>
                  </button>

                  {/* Root Sessions are the primary sidebar rows. SessionGroup
                      topology (subagents, delegations, plugin/manual groups,
                      Swarms, special agents) is inspectable through the rich
                      Session preview instead of an inline expandable tree —
                      see session-preview/session-preview-model.ts. */}
                  <Show when={isExpanded(group.key)}>
                    <nav id={`chats-group-${index()}`} class="flex flex-col gap-px px-1 pb-1.5 pt-0.5">
                      <For each={group.sessions}>
                        {(session) => (
                          <ChatRow
                            session={session}
                            directory={group.directory}
                            animateWorkingIndicator={!group.directory}
                            observeVisibility={observeRowVisibility}
                            relatedCount={sessionGroups.groupForSession(session.id)?.sessionIds.length}
                            inGroupId={sessionGroups.groupForSession(session.id)?.id}
                            selected={activeSessionId() === session.id}
                            minuteNow={minuteNow}
                            runtimeLease={leaseRowRuntime}
                            pending={pendingSessionId() === session.id}
                            onPending={(id) => {
                              if (params.id !== id) setPendingSessionId(id)
                            }}
                            archiveSession={() => archiveSession(session)}
                            prefetchSession={() => prefetchSession(session)}
                            onChangeModel={openModelPicker}
                            onNewSessionInProject={() => navigateToNewSession(session.directory || group.directory)}
                            onOpenProjectInExplorer={() => {
                              const directory = session.directory || group.directory
                              if (directory) void platform.revealPath?.(directory)
                            }}
                            onCopyProjectPath={() => {
                              const directory = session.directory || group.directory
                              if (directory) void navigator.clipboard.writeText(directory)
                            }}
                            onForkConversation={() => {
                              void import("@/components/dialog-fork").then(({ DialogFork }) =>
                                dialog.show(() => <DialogFork sessionID={session.id} />),
                              )
                            }}
                          />
                        )}
                      </For>
                      <Show when={group.total > group.sessions.length}>
                        <button
                          type="button"
                          class="ms-[26px] flex h-6 items-center rounded-md pe-2 text-start text-[10px] leading-none text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-muted focus-visible:outline-none"
                          onClick={() => {
                            if (!group.directory) {
                              // Recents has no single directory to page in —
                              // the extra rows are already held in memory, so
                              // revealing them is pure client state.
                              props.state.showMoreRecent()
                              return
                            }
                            const [, setStore] = serverSync().child(group.directory, { bootstrap: false })
                            setStore("limit", (prev) => (prev ?? 5) + 5)
                            void serverSync().project.loadSessions(group.directory, {
                              projectID: group.project?.id,
                            })
                          }}
                        >
                          {language.plural("chats.showMoreCount", group.total - group.sessions.length)}
                        </button>
                      </Show>
                      <Show
                        when={
                          group.directory
                            ? (serverSync().child(group.directory, { bootstrap: false })[0].limit ?? 5) > 5
                            : props.state.recentLimit() > CHAT_SIDEBAR_RECENT_LIMIT_MIN
                        }
                      >
                        <button
                          type="button"
                          class="ms-[26px] flex h-6 items-center rounded-md pe-2 text-start text-[10px] leading-none text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-muted focus-visible:outline-none"
                          onClick={() => {
                            if (!group.directory) {
                              props.state.showLessRecent()
                              return
                            }
                            const [store] = serverSync().child(group.directory, { bootstrap: false })
                            void serverSync().project.loadSessions(group.directory, {
                              shrinkTo: Math.max(5, (store.limit ?? 5) - 5),
                              projectID: group.project?.id,
                            })
                          }}
                        >
                          {language.t("chats.showLess")}
                        </button>
                      </Show>
                    </nav>
                  </Show>
                </section>
              )}
            </For>
          </div>
        </Show>

        {/* ── Archived group ──────────────────────────────────────
            Sits after every project group, separated by a hairline. Rendered
            outside the active-groups <Show> so it stays reachable even when
            no active chats exist. Collapsed by default; expansion and the
            row limit persist independently of Recent/project groups. */}
        <section
          class="flex flex-col border-t border-v2-border-border-muted pb-2 pt-1.5"
          data-component="chats-archived-group"
        >
          <button
            type="button"
            onClick={() => props.state.toggleArchived()}
            aria-expanded={props.state.isArchivedExpanded()}
            aria-controls="chats-group-archived"
            aria-label={`${language.t("chats.archived.group")}, ${language.plural("chats.archived.count", archivedState.rows.length)}`}
            class="group/head sticky top-0 z-10 flex h-6 shrink-0 items-center gap-1.5 bg-v2-background-bg-base px-2.5 text-left transition-colors hover:bg-v2-background-bg-layer-01 focus-visible:bg-v2-background-bg-layer-01 focus-visible:outline-none"
          >
            <IconV2
              name="chevron-down"
              size="small"
              class={`size-3 shrink-0 text-v2-icon-icon-muted transition-transform duration-150 ${
                props.state.isArchivedExpanded() ? "" : "-rotate-90"
              }`}
            />
            <IconV2 name="archive" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
            <span class="min-w-0 flex-1 truncate text-[10px] font-[560] uppercase leading-none tracking-[0.06em] text-v2-text-text-faint transition-colors group-hover/head:text-v2-text-text-muted">
              {language.t("chats.archived.group")}
            </span>
            <span
              data-chat-tooltip-text={language.plural("chats.archived.count", archivedState.rows.length)}
              data-chat-tooltip-placement="top"
              class="shrink-0 text-[10px] leading-none tabular-nums text-v2-text-text-faint opacity-70"
            >
              {archivedState.rows.length}
            </span>
          </button>

          <Show when={props.state.isArchivedExpanded()}>
            <Suspense
              fallback={
                <div
                  class="flex flex-col gap-px px-2 py-1"
                  aria-busy="true"
                  aria-label={language.t("chats.archived.loading")}
                >
                  <For each={[0, 1]}>
                    {() => <div class="h-[26px] rounded-md bg-v2-background-bg-layer-02 animate-pulse" />}
                  </For>
                </div>
              }
            >
              <ChatSidebarArchivedBody
                rows={archivedState.rows}
                loading={archivedState.loading}
                error={archivedState.error}
                more={archivedState.more}
                limit={props.state.archivedLimit()}
                minuteNow={minuteNow}
                activeSessionId={activeSessionId() ?? undefined}
                pendingSessionId={pendingSessionId() ?? undefined}
                onPending={(id) => {
                  if (params.id !== id) setPendingSessionId(id)
                }}
                onRetry={() => void fetchArchived()}
                onUnarchive={unarchiveSession}
                onShowMore={showMoreArchived}
                onShowLess={props.state.showLessArchived}
              />
            </Suspense>
          </Show>
        </section>
      </ScrollView>

      {/* ── Footer summary ────────────────────────────────────── */}
      <Show when={totalSessions() > 0}>
        <div class="flex h-[22px] shrink-0 items-center justify-between border-t border-v2-border-border-muted/70 bg-v2-background-bg-layer-01/40 px-2.5 text-[9.5px] font-[500] leading-none tracking-[0.02em] text-v2-text-text-faint">
          <span class="tabular-nums">{language.plural("chats.footer.sessions", totalSessions())}</span>
          <Show when={workingCount() > 0}>
            <span class="tabular-nums">{language.plural("chats.footer.active", workingCount())}</span>
          </Show>
        </div>
      </Show>

      <Show when={resizeReady()}>
        <Suspense fallback={null}>
          <SidebarResizeHandle
            direction="horizontal"
            edge="end"
            size={props.state.sidebarWidth()}
            min={200}
            max={420}
            onResize={props.state.resizeSidebar}
            pair={resizePair()}
            class="!absolute !inset-y-0 !right-0"
          />
        </Suspense>
      </Show>
      <Show when={modelPicker()} keyed>
        {(request) => <SessionModelPicker {...request} onClose={() => setModelPicker(null)} />}
      </Show>
      <Portal>
        <Show when={sharedTooltip()}>
          {(intent) => (
            <Show when={sharedTooltipPosition()}>
              {(position) => (
                <div
                  ref={(element) => {
                    sharedTooltipElement = element
                    queueSharedTooltipPosition()
                  }}
                  id={sharedTooltipID}
                  role="tooltip"
                  data-component="tooltip-v2"
                  data-chat-sidebar-shared-tooltip
                  class={intent().sessionID ? "!p-0 overflow-hidden" : undefined}
                  style={
                    {
                      position: "fixed",
                      left: `${position().x}px`,
                      top: `${position().y}px`,
                      // The rich Session preview is interactive (row clicks,
                      // context menu, keyboard); plain-text tooltips stay
                      // decorative and click-through.
                      "pointer-events": intent().sessionID ? "auto" : "none",
                      "z-index": 1000,
                      "max-width": "calc(100vw - 30px)",
                      "max-height": "calc(100vh - 30px)",
                    } as JSX.CSSProperties
                  }
                  onPointerEnter={() => {
                    if (!intent().sessionID) return
                    sharedTooltipCardHovered = true
                    if (tooltipCloseGraceTimer !== undefined) {
                      clearTimeout(tooltipCloseGraceTimer)
                      tooltipCloseGraceTimer = undefined
                    }
                  }}
                  onPointerLeave={() => {
                    if (!intent().sessionID) return
                    sharedTooltipCardHovered = false
                    requestAnimationFrame(() => {
                      if (sharedTooltipCardHovered || sharedTooltipCardContextMenuOpen()) return
                      if (sharedTooltip()?.anchor?.matches(":hover")) return
                      closeSharedTooltip()
                    })
                  }}
                >
                  <Show when={intent().sessionID} fallback={sharedTooltipText()}>
                    {(sessionID) => (
                      <SessionPreviewCard
                        data={sharedTooltipData() ?? {}}
                        relationships={sharedTooltipRelationships}
                        currentSessionID={sessionID()}
                        server={paneServerKey()}
                        serverCtx={paneServerCtx}
                        active={() => sharedTooltip()?.sessionID === sessionID()}
                        onOpenSession={() => closeSharedTooltip()}
                        onRowContextMenuOpenChange={setSharedTooltipCardContextMenuOpen}
                        maxHeight={sharedTooltipMaxHeight}
                      />
                    )}
                  </Show>
                </div>
              )}
            </Show>
          )}
        </Show>
      </Portal>
    </div>
  )
}

function ChatRow(props: {
  session: Session
  directory: string
  /** Cheap O(1) related-session count from the compact SessionGroup
   * membership index (subagents/delegations/plugin/manual/Swarm) — the
   * topology itself is only expandable through the rich Session preview. */
  relatedCount?: number
  /** First SessionGroup this root belongs to, if any — powers the context
   * menu's "remove from group" affordance (unrelated to relatedCount). */
  inGroupId?: string
  animateWorkingIndicator?: boolean
  observeVisibility: (element: Element, update: (visible: boolean) => void) => () => void
  selected?: boolean
  minuteNow: () => number
  runtimeLease: (session: Session) => ChatRowRuntimeLease
  pending?: boolean
  onPending?: (id: string) => void
  archiveSession: () => Promise<void>
  prefetchSession: () => void
  onChangeModel: (request: SessionModelPickerRequest) => void
  onNewSessionInProject: () => void
  onOpenProjectInExplorer: () => void
  onCopyProjectPath: () => void
  onForkConversation?: () => void
}): JSX.Element {
  const language = useLanguage()
  const lease = props.runtimeLease(props.session)
  const runtime = lease.runtime
  onCleanup(lease.release)

  const title = () => sessionTitle(props.session.title)
  // A group may legitimately contain sessions from more than one project.
  // Always route/actions against the member's own directory; the containing
  // project group is only a fallback for legacy rows that lack one.
  const currentDir = props.session.directory || props.directory || ""
  const isWorking = runtime.isWorking
  const unseenCount = runtime.unseenCount
  const hasError = runtime.hasError
  const pendingPermissionCount = runtime.pendingPermissionCount
  const pendingQuestionCount = runtime.pendingQuestionCount
  const hasPermissions = runtime.hasPermissions
  const hasQuestions = runtime.hasQuestions
  const needsAttention = runtime.needsAttention
  const isAutoAccepting = runtime.isAutoAccepting
  const totals = runtime.totals
  const contextPercent = runtime.contextPercent
  const modelInfo = runtime.modelInfo
  const modelLabel = runtime.modelLabel
  const live = runtime.live
  const [rowVisible, setRowVisible] = createSignal(false)
  // Timer text is useful only while a row is on screen. Keep hidden rows out of
  // the shared 1 Hz clock's reactive subscriber set; they recompute immediately
  // when IntersectionObserver reports them visible again.
  const rowLive = () => (rowVisible() ? live() : undefined)
  let stopObserving: (() => void) | undefined
  onCleanup(() => stopObserving?.())

  const slug = () => base64Encode(currentDir || props.session.directory || "")
  const warm = () => props.prefetchSession()
  const serverKey = runtime.serverKey
  const navigate = useNavigate()
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number }>()
  const handleOpen = (opts?: { background?: boolean }) => {
    const dir = currentDir || props.session.directory || ""
    if (!dir || !props.session.id) return
    const server = serverKey()
    if (!server) return
    if (opts?.background) {
      void import("@/context/tabs").then(({ useTabs }) => {
        try {
          const tabs = useTabs()
          tabs.addSessionTab({ server, sessionId: props.session.id })
        } catch {}
      })
      return
    }
    props.onPending?.(props.session.id)
    navigate(`/${slug()}/session/${props.session.id}`)
  }

  return (
    <>
      <div
          ref={(element) => {
            stopObserving?.()
            stopObserving = props.observeVisibility(element, setRowVisible)
          }}
          data-chat-tooltip-session={props.session.id}
          data-chat-tooltip-placement="right"
          class="group/session relative min-w-0 rounded-[5px] transition-[background-color,box-shadow] duration-100 hover:bg-v2-background-bg-layer-01 focus-within:bg-v2-background-bg-layer-01 has-[.active]:bg-v2-background-bg-layer-02 has-[.active]:shadow-[inset_0_0_0_0.5px_var(--v2-alpha-dark-8)] has-[data-selected]:bg-v2-background-bg-layer-02 has-[data-selected]:shadow-[inset_0_0_0_0.5px_var(--v2-alpha-dark-8)] [[data-model-picker-open]_&]:bg-v2-background-bg-layer-01"
          onContextMenu={(event) => {
            event.preventDefault()
            setContextMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <A
            href={`/${slug()}/session/${props.session.id}`}
            class="relative flex w-full min-w-0 flex-col gap-[2px] rounded-[5px] py-[4px] pe-1.5 ps-1.5 text-v2-text-text-muted transition-colors focus-visible:outline-none group-hover/session:text-v2-text-text-base [&.active]:text-v2-text-text-base [&.active]:before:absolute [&.active]:before:inset-y-[3px] [&.active]:before:start-0 [&.active]:before:w-[2px] [&.active]:before:rounded-e-full [&.active]:before:bg-v2-background-bg-accent [&.active]:before:shadow-[0_0_6px_var(--v2-background-bg-accent)] [&.active]:before:content-[''] data-[selected]:text-v2-text-text-base data-[selected]:before:absolute data-[selected]:before:inset-y-[3px] data-[selected]:before:start-0 data-[selected]:before:w-[2px] data-[selected]:before:rounded-e-full data-[selected]:before:bg-v2-background-bg-accent data-[selected]:before:shadow-[0_0_6px_var(--v2-background-bg-accent)] data-[selected]:before:content-['']"
            data-selected={props.selected ? "" : undefined}
            aria-current={props.selected ? "page" : undefined}
            onPointerDown={warm}
            onFocus={warm}
            onClick={(event: MouseEvent) => {
              if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button === 1) return
              props.onPending?.(props.session.id)
            }}
          >
            {/* Line 1 — status, title, attention, hover actions */}
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="flex size-3 shrink-0 items-center justify-center">
                <Show
                  when={props.pending}
                  fallback={
                    <Show
                      when={isWorking()}
                      fallback={
                        <Show
                          when={needsAttention() || hasError() || unseenCount() > 0}
                          fallback={
                            <span class="size-1.5 rounded-full border border-v2-border-border-strong group-hover/session:border-v2-icon-icon-muted" />
                          }
                        >
                          <span
                            class={`size-1.5 rounded-full ${
                              hasError()
                                ? "bg-v2-state-fg-danger"
                                : needsAttention()
                                  ? "bg-v2-state-fg-warning"
                                  : "bg-v2-background-bg-accent"
                            }`}
                          />
                        </Show>
                      }
                    >
                      <DenseWorkingIndicator
                        class="text-v2-icon-icon-base"
                        animated={chatSidebarWorkingIndicatorAnimated(
                          props.animateWorkingIndicator === true,
                          true,
                          rowVisible(),
                        )}
                      />
                    </Show>
                  }
                >
                  <LoaderV2 class="size-3" aria-hidden="true" />
                </Show>
              </span>

              <span class="min-w-0 flex-1 truncate text-[11.5px] font-[460] leading-[15px] tracking-[-0.01em] group-has-[data-selected]/session:font-[560]">{title()}</span>

              <Show when={(props.relatedCount ?? 0) > 1}>
                <span
                  data-chat-tooltip-text={language.plural("sessionGroup.sessions", Math.max((props.relatedCount ?? 1) - 1, 0))}
                  data-chat-tooltip-placement="top"
                  class="flex shrink-0 items-center gap-0.5 rounded-[4px] bg-v2-background-bg-layer-02 px-1 py-[1px] text-[9px] font-[520] leading-none tabular-nums text-v2-text-text-faint"
                >
                  <IconV2 name="branch" size="small" class="size-2.5 opacity-70" />
                  {Math.max((props.relatedCount ?? 1) - 1, 0)}
                </span>
              </Show>

              <Show when={hasPermissions()}>
                <span
                  data-chat-tooltip-text={language.t("chats.badge.permission")}
                  data-chat-tooltip-placement="top"
                  class="flex shrink-0 items-center gap-0.5 rounded bg-v2-state-bg-warning px-1 py-[1px] text-[9px] font-[560] leading-none tabular-nums text-v2-state-fg-warning"
                >
                  <IconV2 name="shield" size="small" class="size-2.5" />
                  {pendingPermissionCount()}
                </span>
              </Show>
              <Show when={hasQuestions()}>
                <span
                  data-chat-tooltip-text={language.t("chats.badge.question")}
                  data-chat-tooltip-placement="top"
                  class="flex shrink-0 items-center gap-0.5 rounded bg-v2-state-bg-info px-1 py-[1px] text-[9px] font-[560] leading-none tabular-nums text-v2-state-fg-info"
                >
                  <IconV2 name="help" size="small" class="size-2.5" />
                  {pendingQuestionCount()}
                </span>
              </Show>

              {/* Archive replaces the timestamp on hover so the row never reflows */}
              <div class="flex shrink-0 items-center">
                <span class="text-[10px] leading-none tabular-nums text-v2-text-text-muted group-hover/session:hidden">
                  {relativeLabel(props.session, props.minuteNow())}
                </span>
                <button
                  type="button"
                  aria-label={language.t("common.archive")}
                  data-chat-tooltip-text={language.t("common.archive")}
                  data-chat-tooltip-placement="top"
                  class="hidden size-4 items-center justify-center rounded text-v2-icon-icon-muted transition-colors hover:bg-v2-background-bg-layer-03 hover:text-v2-icon-icon-base group-hover/session:flex"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void props.archiveSession()
                  }}
                >
                  <IconV2 name="archive" size="small" class="size-3" />
                </button>
              </div>
            </div>

            {/* Line 2 — left metrics (truncate) + right timer (pinned, never squeezed) */}
            <div class="flex min-w-0 items-center gap-1.5 ps-[18px] opacity-[0.92] transition-opacity group-hover/session:opacity-100">
              <div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                <Show when={contextPercent() !== null}>
                  <span
                    data-chat-tooltip-text={language.t("chats.metric.context")}
                    data-chat-tooltip-placement="top"
                    class="flex shrink-0 items-center gap-1"
                  >
                    <span class="h-[3px] w-6 overflow-hidden rounded-full bg-v2-background-bg-layer-03">
                      <span
                        class={`block h-full rounded-full transition-[width] duration-500 ${contextTone(contextPercent()!).bar}`}
                        style={{ width: `${Math.min(100, Math.max(2, contextPercent()!))}%` }}
                      />
                    </span>
                    <span class={`text-[10px] leading-none tabular-nums ${contextTone(contextPercent()!).text}`}>
                      {contextPercent()}%
                    </span>
                  </span>
                </Show>

                <Show when={(totals()?.cost ?? 0) > 0}>
                  <span class="shrink-0 text-[10px] leading-none tabular-nums text-v2-text-text-faint">
                    {formatCost(totals()!.cost)}
                  </span>
                </Show>

                <Show when={totals()?.cacheHitPercent !== null && totals()?.cacheHitPercent !== undefined}>
                  <span
                    data-chat-tooltip-text={language.t("context.tooltip.cacheHit")}
                    data-chat-tooltip-placement="top"
                    class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums text-v2-text-text-faint opacity-70"
                  >
                    <IconV2 name="cache" size="small" class="size-2.5 opacity-70" />
                    <span>{totals()!.cacheHitPercent}%</span>
                  </span>
                </Show>

                <Show when={modelInfo()}>
                  {(info) => (
                    <span class="min-w-0 flex-1 truncate text-[10px] leading-none text-v2-text-text-faint opacity-70">
                      {modelLabel()}
                      <Show when={info().variant}>{(variant) => ` · ${variant()}`}</Show>
                    </span>
                  )}
                </Show>

                <Show when={isAutoAccepting()}>
                  <span
                    data-chat-tooltip-text={language.t("chats.badge.autoAccept")}
                    data-chat-tooltip-placement="top"
                    class="flex shrink-0 items-center rounded-[3.5px] bg-v2-state-bg-info px-0.5 py-[1px] text-[9px] font-[560] leading-none text-v2-state-fg-info"
                  >
                    <IconV2 name="shield-check" size="small" class="size-2.5" />
                  </span>
                </Show>
              </div>

              <Show
                when={isWorking()}
                fallback={
                  <Show when={(totals()?.generatedSeconds ?? 0) + (totals()?.toolSeconds ?? 0) > 1}>
                    <span
                      data-chat-tooltip-text={language.t("chats.timer.accumulated")}
                      data-chat-tooltip-placement="top"
                      class="shrink-0 text-[10px] leading-none tabular-nums text-v2-text-text-faint opacity-70"
                    >
                      {formatDuration((totals()!.generatedSeconds ?? 0) + (totals()!.toolSeconds ?? 0))}
                    </span>
                  </Show>
                }
              >
                {/* Keyed off isWorking, not live(): live() returns a fresh object
                 every tick, and a keyed <Show> callback would tear down and
                 recreate the whole tooltip+spans subtree each second. Plain
                 expression children compile to tracked getters, so only the
                 text nodes update in place each tick. Inner Switch swaps
                 between generating / tools / waiting premium states instead of
                 showing 0s. */}
                <span
                  data-chat-tooltip-placement="top"
                  class="flex shrink-0"
                >
                  <Switch>
                    <Match when={hasPermissions() || hasQuestions()}>
                      <span class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums text-v2-state-fg-warning">
                        <IconV2 name="hourglass" size="small" class="size-3 animate-pulse" />
                        <span class="font-[560]">{language.t("chats.timer.waiting")}</span>
                        <Show when={(rowLive()?.turnSeconds ?? 0) > 1}>
                          <span class="font-[560] opacity-70">{formatDuration(rowLive()!.turnSeconds)}</span>
                        </Show>
                      </span>
                    </Match>
                    <Match when={(rowLive()?.rate ?? null) !== null}>
                      <span class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums">
                        <span class="text-v2-text-text-accent opacity-80">
                          {language.t("chats.metric.rate", { rate: rowLive()?.rate?.toFixed(0) ?? "0" })}
                        </span>
                        <span class="font-[560] text-v2-text-text-accent">
                          {formatDuration(rowLive()?.turnSeconds ?? 0)}
                        </span>
                      </span>
                    </Match>
                    <Match when={(rowLive()?.turnSeconds ?? 0) > 1}>
                      <span class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums text-v2-text-text-muted">
                        <IconV2 name="layers" size="small" class="size-2.5 opacity-70" />
                        <span>{language.t("chats.timer.tools")}</span>
                        <span class="opacity-40">·</span>
                        <span class="font-[560] opacity-80">{formatDuration(rowLive()!.turnSeconds)}</span>
                      </span>
                    </Match>
                    <Match when={true}>
                      <span class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums text-v2-text-text-faint">
                        <IconV2 name="hourglass" size="small" class="size-3 animate-pulse opacity-70" />
                        <span>{language.t("chats.timer.thinking")}</span>
                      </span>
                    </Match>
                  </Switch>
                </span>
              </Show>
            </div>
          </A>
        </div>
      <Show when={contextMenu()} keyed>
        {(cursor) => (
          <Suspense fallback={null}>
            <SidebarSessionContextMenu
              cursor={cursor}
              where="chats"
              session={props.session}
              server={serverKey()}
              inGroupId={props.inGroupId}
              onOpenChange={(open) => {
                if (!open) setContextMenu(undefined)
              }}
              onOpen={handleOpen}
              onArchive={() => void props.archiveSession()}
              onChangeModel={props.onChangeModel}
              onNewSessionInProject={props.onNewSessionInProject}
              onOpenProjectInExplorer={props.onOpenProjectInExplorer}
              onCopyProjectPath={props.onCopyProjectPath}
              onForkConversation={props.onForkConversation}
            />
          </Suspense>
        )}
      </Show>
    </>
  )
}
