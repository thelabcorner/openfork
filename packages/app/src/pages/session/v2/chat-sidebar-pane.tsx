import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  getOwner,
  lazy,
  Match,
  on,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  Suspense,
  Switch,
  type Accessor,
  type JSX,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import { A, useIsRouting, useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { showToast } from "@/utils/toast"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { DenseWorkingIndicator } from "@opencode-ai/ui/spinner"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getProjectAvatarVariant, useLayout, type LocalProject } from "@/context/layout"
import { useGlobal } from "@/context/global"
import { useServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useTabs } from "@/context/tabs"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { sessionGroupMemberSession, useSessionGroups } from "@/context/session-groups"
import { sessionPreviewProjectionCache } from "@/components/session-preview/session-preview-cache"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { sessionHref } from "@/utils/session-route"
import { startupMark, startupTransportDiagnostic } from "@/utils/startup-perf"
import { indexChatSidebarStickyHeaders, stickyChatSidebarHeader } from "./chat-sidebar-sticky-index"
import { sidebarFixedBlockHeight, sidebarStickyBlockOffset } from "./chat-sidebar-virtual-layout"
import { mergeSortedChatSidebarSessions } from "./chat-sidebar-session-merge"
import { countSidebarWaiting } from "./chat-sidebar-counts"
import { visibleChatSidebarGroups } from "./chat-sidebar-group-scope"
import { sameChatSidebarDirectoryScope, sameChatSidebarIDSet, sameChatSidebarSessionDirectories } from "./chat-sidebar-scope-equality"
import { reuseChatSidebarVirtualBlocks } from "./chat-sidebar-virtual-reuse"
import { indexChatSidebarWorkingIDs } from "./chat-sidebar-working-index"
import { indexChatSidebarRowStates, sameChatSidebarRowStateIndex } from "./chat-sidebar-state-index"
import { buildChatSidebarSparseStatusSections, indexChatSidebarSparseSource } from "./chat-sidebar-status-sparse"
import { buildChatSidebarGroupedSparseStatusSections, indexChatSidebarGroupedStatusSource } from "./chat-sidebar-status-grouped"
import { buildChatSidebarSparseRecentSection } from "./chat-sidebar-recent-sparse"
import { createChatSidebarWorkingOrder } from "./chat-sidebar-working-order"
import { withChatSidebarDirectory } from "./chat-sidebar-directory"
import { createChatSidebarSourceCache } from "./chat-sidebar-source-cache"
import { chatSidebarIndexedProjectGroupRevisions, createChatSidebarProjectSectionCache, indexChatSidebarProjectMembership, reuseChatSidebarProjectMemberLists, workingChatSidebarProjects } from "./chat-sidebar-project-cache"

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
let sessionPreviewCardModule: Promise<typeof import("@/components/session-preview/session-preview-card")> | undefined
const loadSessionPreviewCard = () =>
  (sessionPreviewCardModule ??= import("@/components/session-preview/session-preview-card"))
const SessionPreviewCard = lazy(() => loadSessionPreviewCard().then((m) => ({ default: m.SessionPreviewCard })))
type ChatSidebarSearchRuntime = import("./chat-sidebar-search-runtime").ChatSidebarSearchRuntime
let chatSidebarSearchRuntimeModule: Promise<typeof import("./chat-sidebar-search-runtime")> | undefined
const loadChatSidebarSearchRuntime = () =>
  (chatSidebarSearchRuntimeModule ??= import("./chat-sidebar-search-runtime"))
import {
  CHAT_SIDEBAR_RECENT_LIMIT_MIN,
  chatSidebarAggregateMetrics,
  chatSidebarWorkingIndicatorAnimated,
  createChatSidebarIndicatorBudget,
  uniqueSidebarSessions,
  chatSidebarRootSessionVisible,
  type ChatSidebarPaneState,
} from "./chat-sidebar-pane-state"
import {
  buildChatSidebarSections,
  compareChatSidebarSessions,
  canReuseChatSidebarItemSlot,
  CHAT_SIDEBAR_SORT_MODES,
  CHAT_SIDEBAR_VIEW_MODES,
  chatSidebarStatusBucket,
  countChatSidebarClusterStates,
  reconcileChatSidebarSlots,
  reuseChatSidebarSections,
  sameChatSidebarClusterCounts,
  type ChatSidebarClusterItem,
  type ChatSidebarClusterScope,
  type ChatSidebarItem,
  type ChatSidebarSlot,
  type ChatSidebarSlotState,
  type ChatSidebarDensity,
  type ChatSidebarRowState,
  type ChatSidebarSection,
  type ChatSidebarSortMode,
  type ChatSidebarStatusBucket,
  type ChatSidebarViewMode,
} from "./chat-sidebar-tree"
import { ChatSidebarOxpSection } from "./chat-sidebar-oxp-section"
import "./chat-sidebar-pane.css"
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
function contextTone(percent: number): "danger" | "warning" | undefined {
  if (percent >= 85) return "danger"
  if (percent >= 65) return "warning"
  return undefined
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
  update: (session: Session) => void
  release: () => void
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
  const permission = usePermission()
  const sessionGroups = useSessionGroups()
  // One shared ticker for every live timer in the pane — per-row intervals
  // would multiply timers by the number of visible sessions. Suppress this
  // 1-Hz timer completely while the pane is closed or every session is idle.
  // A Solid effect (rather than a permanent interval) preserves live-edge
  // updates immediately when the first working Session appears.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!props.opened || !workingIDs().size) return
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(tick))
  })

  // Rations animated working dots (each is a compositor layer) across the pane.
  const indicatorBudget = createChatSidebarIndicatorBudget()

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
  createEffect(() => {
    if (!props.opened) return
    setMinuteNow(Date.now())
    const minuteTick = setInterval(() => setMinuteNow(Date.now()), 30_000)
    onCleanup(() => clearInterval(minuteTick))
  })

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

  // Deliberately non-reactive: entries are assigned the first time a session is
  // observed working and deleted when it goes idle, so pinned rows keep their
  // relative arrival order for the whole generation instead of reshuffling.
  const workingOrder = createChatSidebarWorkingOrder()
  const workingIDs = createMemo(
    () => {
      const data = serverSync().session.data
      return indexChatSidebarWorkingIDs(data.session_status, data.paused)
    },
    undefined,
    { equals: sameChatSidebarIDSet },
  )

  // Reads the global session store directly: telemetry cold-start/live edges
  // reconcile this canonical status projection in server-sync, so the sidebar
  // does not own a second activity signal or any per-row transport.
  const isWorking = (session: Pick<Session, "id">) => {
    if (!session.id) return false
    return serverSync().session.data.session_working(session.id)
  }

  const pinWorkingFirst = (rows: Session[]) => workingOrder.pin(rows, workingIDs())

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
            withChatSidebarDirectory(session, dir),
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
              ].sort(compareSessionTime)
          // Canonical project-index slices were already sorted at their owner;
          // do not sort (and mutate) the shared directory memo's array again.
          return rows
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
    const recentSources: Session[][] = []
    const projectRows = new Map<string, Session[]>()
    for (const project of projects) {
      const rows = projectSlice(project)()
      recentSources.push(rows)
      projectRows.set(project.worktree, rows)
    }
    const recent = mergeSortedChatSidebarSessions(recentSources)
    if (recent.length > 0) {
      startupMark("sidebar.first-rows", { rows: recent.length, projects: projects.length })
      startupTransportDiagnostic("sidebar.first-rows.transport")
    }
    const projectByID = new Map(projects.flatMap((project) => (project.id ? [[project.id, project] as const] : [])))
    return { projects, projectByID, recentPool: recent, projectRows }
  })

  const visibleRootIDs = createMemo(
    () => new Set(baseGroups().recentPool.map((session) => session.id)),
    undefined,
    { equals: sameChatSidebarIDSet },
  )
  // Child sessions are intentionally absent from the root slices. Group rows
  // and the global state badges use their compact SessionGroup projections,
  // without hydrating history or creating per-member requests.
  const visibleMemberGroups = createMemo(() => {
    return visibleChatSidebarGroups(visibleRootIDs(), sessionGroups.list())
  })

  // SessionGroup detail is the authoritative compact roster. Root session
  // slices omit parented workers, so deriving delegation/manual cluster members
  // from those slices alone silently shrinks a batch to whichever roots happen
  // to be loaded. Structural plugin/Swarm workers remain in the rich inspector.
  const sidebarRootSessionsByID = createMemo(
    () => new Map(baseGroups().recentPool.map((session) => [session.id, session] as const)),
  )
  const sidebarClusterGroups = createMemo(() => {
    const byGroup = new Map<string, Session[]>()
    const groupBySession = new Map<string, { id: string; name: string; kind: string }>()
    const sessionsByID = new Map<string, Session>()
    let roots: Map<string, Session> | undefined
    const groups = visibleMemberGroups()
      .filter((group) => group.kind !== "subagent")
      .sort((left, right) => {
        const priority = (kind: string) => (kind === "delegation" ? 0 : kind === "user" ? 1 : 2)
        return priority(left.kind) - priority(right.kind)
      })
    for (const group of groups) {
      const identity = { id: group.id, name: group.name, kind: group.kind }
      const members: Session[] = []
      for (const member of group.sessions) {
        if (member.time?.archived != null) continue
        let session = sessionGroupMemberSession(member)
        if (!session) {
          roots ??= sidebarRootSessionsByID()
          session = roots.get(member.id)
        }
        if (!session) continue
        members.push(session)
        if (groupBySession.has(session.id)) continue
        groupBySession.set(session.id, identity)
        if (group.kind === "delegation" || group.kind === "user") sessionsByID.set(session.id, session)
      }
      byGroup.set(group.id, members)
    }
    return { byGroup, groupBySession, sessions: [...sessionsByID.values()] }
  })

  const sidebarGroupSessions = createMemo(() => {
    const roots = sidebarRootSessionsByID()
    return sidebarClusterGroups().sessions.map((session) => roots.get(session.id) ?? session)
  })
  const presentSidebarSessionIDs = createMemo(() => {
    const ids = new Set(baseGroups().recentPool.map((session) => session.id))
    for (const session of sidebarGroupSessions()) ids.add(session.id)
    return ids
  })
  // The common ungrouped Status view needs only a few dozen active IDs and the
  // first idle page. Index canonical, sorted roots ONCE per index revision, not
  // on every status/permission/notification event. Any mixed/legacy/grouped
  // case retains the comprehensive, previously-tested full-tree fallback.
  const sparseStatusSource = createMemo(() => {
    if (props.state.view() !== "status" || props.state.sort() !== "updated") return undefined
    if (sidebarClusterGroups().groupBySession.size || sidebarGroupSessions().length) return undefined
    return indexChatSidebarSparseSource(baseGroups().recentPool)
  })
  const sidebarSourceCache = createChatSidebarSourceCache()
  onCleanup(() => sidebarSourceCache.clear())
  const recentWithGroupMembers = createMemo(() => {
    const rows = baseGroups().recentPool
    // Projects use their own scoped group membership lists. Do not also
    // perform the global Recent merge and member sort while viewing Projects.
    if (props.state.view() === "projects") {
      sidebarSourceCache.clear()
      return rows
    }
    return sidebarSourceCache.merge(rows, sidebarGroupSessions())
  })

  // Stage 2 — view projection. The only stage that reads working/attention
  // state, so a flip storm re-runs just the cheap pin/bucket/fold pass while
  // stage 1's per-directory sorts stay cached; reuseChatSidebarSections then
  // keeps every unchanged row component (and its runtime lease) alive.
  //
  // Exactly one view renders. Root sessions stay single-row; delegation/manual
  // clusters add their parented members from the compact roster so each batch
  // remains complete without adding one top-level row per worker.
  const titleOf = (session: Session) => sessionTitle(session.title) ?? ""

  // O(1) per session against already-materialized stores; no history reads.
  const needsInput = (session: Pick<Session, "id"> & Partial<Pick<Session, "directory">>) => {
    const data = serverSync().session.data
    if ((data.question[session.id] ?? []).length > 0) return true
    const pending = data.permission[session.id] ?? []
    if (pending.length === 0) return false
    const directory = session.directory ?? ""
    for (const item of pending) if (!permissionState().autoResponds(item, directory)) return true
    return false
  }

  const rowState = (session: Session): ChatSidebarRowState => {
    if (needsInput(session)) return "attention"
    if (notification.session.unseenHasError(session.id)) return "error"
    if (isWorking(session)) return "working"
    if (notification.session.unseenCount(session.id) > 0) return "unread"
    return "idle"
  }

  // The Status view used to subscribe to four individual reactive slots for
  // EVERY loaded root (including thousands of idle sessions). The data owners
  // already provide compact sparse maps; derive semantic status from those
  // projections once and make each row's bucket lookup O(1) without wiring N
  // subscriptions. Only this view consumes the index; other views remain cold.
  const statusDirectories = createMemo(() => {
    if (props.state.view() !== "status") return new Map<string, string>()
    const dirs = new Map<string, string>()
    for (const session of baseGroups().recentPool) dirs.set(session.id, session.directory ?? "")
    for (const session of sidebarGroupSessions()) {
      if (!dirs.has(session.id)) dirs.set(session.id, session.directory ?? "")
    }
    return dirs
  }, new Map<string, string>(), { equals: sameChatSidebarSessionDirectories })
  const statusStateIndex = createMemo<ReadonlyMap<string, ChatSidebarRowState>>(
    () => {
      if (props.state.view() !== "status") return new Map()
      const data = serverSync().session.data
      return indexChatSidebarRowStates({
        statuses: data.session_status,
        paused: data.paused,
        questions: data.question,
        permissions: data.permission,
        unseenCounts: notification.session.unseenCounts(),
        unseenErrors: notification.session.unseenErrors(),
        directoryByID: statusDirectories(),
        autoResponds: (request, directory) => permissionState().autoResponds(request, directory),
      })
    },
    new Map<string, ChatSidebarRowState>(),
    { equals: sameChatSidebarRowStateIndex },
  )

  // Subagent groups anchor hidden child sessions, never sibling roots. Other
  // direct memberships, including delegation batches, fold from the roster.
  const groupOf = (session: Session) => sidebarClusterGroups().groupBySession.get(session.id)
  const sortedSparseRows = createMemo(() => {
    // Only one sidebar view renders; title's locale-aware 10k-row sort must
    // never wake while Projects consumes per-project sections instead.
    const view = props.state.view()
    if (view === "projects") {
      sidebarSourceCache.clear()
      return undefined
    }
    const sort = props.state.sort()
    if (view === "status" && sort === "updated" && !sidebarClusterGroups().groupBySession.size) {
      // The ungrouped updated Status view has a cheaper root-only source.
      sidebarSourceCache.clearSorted()
      return undefined
    }
    return sidebarSourceCache.sort(recentWithGroupMembers(), sort, titleOf)
  })
  const indexedSparseSource = createMemo(() => {
    const rows = sortedSparseRows()
    if (!rows) return undefined
    const sort = props.state.sort()
    // Recent and Status use the SAME source index: toggling views need not
    // resort titles, re-validate metadata or rebuild an O(10k) group Map.
    return indexChatSidebarGroupedStatusSource(
      rows, groupOf, compareChatSidebarSessions(sort, titleOf),
      // sortChatSidebarSessions() explicitly sorted the newly produced rows
      // above; avoid re-running an O(N) Intl.Collator verification on the
      // title-sort cold path. Updated roots retain the conservative check.
      sort !== "updated",
    )
  })
  const groupedStatusSource = createMemo(() => {
    if (props.state.view() !== "status") return undefined
    return indexedSparseSource()
  })
  const recentSparseSource = createMemo(() => {
    if (props.state.view() !== "recent") return undefined
    return indexedSparseSource()
  })

  type ChatProjectHead = { key: string; label: string; directory: string; project: LocalProject; total: number }

  const projectHeads = createMemo(() => {
    const { projects, projectByID, projectRows } = baseGroups()
    const heads = new Map<string, ChatProjectHead & { sessions: Session[] }>()
    for (const project of projects) {
      const rows = projectRows.get(project.worktree) ?? []
      if (rows.length === 0 && project.id !== "chats") continue
      const [store] = serverSync().child(project.worktree, { bootstrap: false })
      const key = pathKey(project.worktree)
      heads.set(key, {
        key,
        label: displayName(project),
        directory: project.worktree,
        project: (rows[0] ? projectForSession(rows[0], projects, projectByID) : undefined) ?? project,
        // sessionTotal starts at 0 (not undefined) until the first load, so the
        // loaded-row count is the honest fallback while the estimate is cold.
        total: store.sessionTotal > 0 ? store.sessionTotal : rows.length,
        sessions: rows,
      })
    }
    return heads
  })

  const sidebarGroupSessionsByProject = createMemo<Map<string, Session[]>>((previous) => {
    // Project-head attribution is not used by Recent or Status. Do not
    // materialize the per-project reverse map for every global member update
    // while either of those views is active.
    if (props.state.view() !== "projects") return new Map<string, Session[]>()
    const heads = projectHeads()
    const byProject = new Map<string, Session[]>([...heads.keys()].map((key) => [key, []]))
    const keysByProjectID = new Map<string, string[]>()
    for (const head of heads.values()) {
      const id = head.project.id
      if (!id) continue
      const keys = keysByProjectID.get(id)
      if (keys) keys.push(head.key)
      else keysByProjectID.set(id, [head.key])
    }
    for (const session of sidebarGroupSessions()) {
      const keys = keysByProjectID.get(session.projectID) ?? []
      const directoryKey = pathKey(session.directory)
      for (const key of keys) byProject.get(key)?.push(session)
      // The canonical project ID and its worktree may identify the same head.
      // Avoid a per-member Set allocation while retaining distinct paths.
      if (byProject.has(directoryKey) && !keys.includes(directoryKey)) byProject.get(directoryKey)!.push(session)
    }
    // Reuse unaffected member arrays even when a different group's roster
    // changes. The Project section cache uses these exact identities to avoid
    // touching unrelated projects on worker-spawn/complete events.
    return reuseChatSidebarProjectMemberLists(previous, byProject)
  })
  // Index directory-scoped canonical roots only on root-index revisions;
  // group renames/member shuffles must not scan 10k unrelated idle roots just
  // to discover which projects contain their sparse group IDs.
  const hasScopedSidebarGroups = createMemo(() => sidebarClusterGroups().groupBySession.size > 0)
  const projectRootMembership = createMemo(() => {
    if (props.state.view() !== "projects") return new Map<string, readonly string[]>()
    // No group membership means no group-signature lookups. Avoid allocating
    // a dense reverse-root index during the common all-ungrouped cold paint.
    // The boolean memo stays stable across ordinary group title/member edits.
    if (!hasScopedSidebarGroups()) return new Map<string, readonly string[]>()
    return indexChatSidebarProjectMembership([...projectHeads().values()], new Map())
  })
  const projectGroupRevisions = createMemo(() => {
    if (props.state.view() !== "projects") return new Map<string, string>()
    const projection = sidebarClusterGroups()
    return chatSidebarIndexedProjectGroupRevisions(
      projectHeads().keys(), projectRootMembership(), sidebarGroupSessionsByProject(),
      projection.groupBySession, projection.byGroup,
    )
  })
  const hasWorkingSessions = createMemo(() => workingIDs().size > 0)
  const projectWorkingMembership = createMemo(() => {
    // Only updated-time sort applies working-first pinning. A worker state
    // transition under title/created sort must not reindex project membership.
    // No busy rows = no reason to build a 10k-entry reverse map on first paint.
    if (props.state.view() !== "projects" || props.state.sort() !== "updated")
      return new Map<string, readonly string[]>()
    if (!hasWorkingSessions()) return new Map<string, readonly string[]>()
    return indexChatSidebarProjectMembership([...projectHeads().values()], sidebarGroupSessionsByProject())
  })
  const projectSectionCache = createChatSidebarProjectSectionCache()
  onCleanup(() => projectSectionCache.clear())
  createEffect(() => {
    // A keep-mounted sidebar must not retain all Project sections and their
    // Session references while rendering Recent or Status instead.
    if (props.state.view() !== "projects") projectSectionCache.clear()
  })
  let projectedServer = paneServerKey()

  const memberInSidebarScope = (
    session: Session,
    scope: ChatSidebarClusterScope,
    stateOf: (session: Session) => ChatSidebarRowState = rowState,
  ) => {
    if (scope.kind === "recent") return true
    if (scope.kind === "status") return chatSidebarStatusBucket(stateOf(session)) === scope.status
    const project = projectHeads().get(scope.projectKey)
    if (!project) return false
    if (project.project.id && session.projectID === project.project.id) return true
    return pathKey(session.directory) === scope.projectKey
  }

  const groupMembersInSidebarScope = (
    group: { id: string; kind: string },
    scope: ChatSidebarClusterScope,
    stateOf: (session: Session) => ChatSidebarRowState = rowState,
  ) => {
    if (group.kind !== "delegation" && group.kind !== "user") return []
    const projection = sidebarClusterGroups()
    const roots = sidebarRootSessionsByID()
    const result: Session[] = []
    for (const member of projection.byGroup.get(group.id) ?? []) {
      if (projection.groupBySession.get(member.id)?.id !== group.id) continue
      const session = roots.get(member.id) ?? member
      if (memberInSidebarScope(session, scope, stateOf)) result.push(session)
    }
    return result
  }

  const sections = createMemo<ChatSidebarSection[]>((previous) => {
    const server = paneServerKey()
    if (server !== projectedServer) {
      // Synchronous invalidation before this render matters: an after-render
      // effect could clear the nonreactive arrival/cache state too late, leaving
      // the first paint in the new server ordered by the previous server's IDs.
      workingOrder.clear()
      projectSectionCache.clear()
      projectedServer = server
      previous = undefined
    }
    const { recentPool } = baseGroups()
    const mode = props.state.view()
    const sort = props.state.sort()
    // Created/title sorting never pins working rows. Avoid subscribing these
    // entire structural sections to execution flips: live badges/timers are
    // already reactive at the mounted-row runtime level. On returning to
    // updated-time ordering, prune the arrival policy against the latest
    // authoritative working set before the first pinned projection.
    if (sort === "updated") workingOrder.prune(presentSidebarSessionIDs(), workingIDs())
    if (mode === "projects") {
      const supplemental = sidebarGroupSessionsByProject()
      return reuseChatSidebarSections(previous, projectSectionCache.build({
        projects: [...projectHeads().values()],
        supplemental,
        working: sort === "updated"
          ? workingChatSidebarProjects(workingIDs(), projectWorkingMembership())
          : new Map<string, ReadonlySet<string>>(),
        sort,
        groupRevision: projectGroupRevisions(),
        groupOf,
        groupMembersOf: (group, scope) => groupMembersInSidebarScope(group, scope),
        titleOf,
        pin: pinWorkingFirst,
      }))
    }
    const recentSource = mode === "recent" ? recentSparseSource() : undefined
    if (recentSource) {
      const section = buildChatSidebarSparseRecentSection({
        source: recentSource,
        working: sort === "updated" ? workingIDs() : new Set<string>(),
        limit: props.state.recentLimit(),
        pinWorking: sort === "updated" ? pinWorkingFirst : (rows) => rows,
        compare: compareChatSidebarSessions(sort, titleOf),
        titleOf,
        groupMembersOf: (group) => groupMembersInSidebarScope(group, { kind: "recent" }),
      })
      if (section || recentSource.rows.length === 0)
        return reuseChatSidebarSections(previous, section ? [section] : [])
    }
    const sparseSource = mode === "status" && sort === "updated" ? sparseStatusSource() : undefined
    if (sparseSource) {
      return reuseChatSidebarSections(
        previous,
        buildChatSidebarSparseStatusSections({
          source: sparseSource,
          states: statusStateIndex(),
          limit: props.state.recentLimit(),
          pin: pinWorkingFirst,
        }),
      )
    }
    const groupedSource = mode === "status" ? groupedStatusSource() : undefined
    if (groupedSource) {
      const state = statusStateIndex()
      return reuseChatSidebarSections(
        previous,
        buildChatSidebarGroupedSparseStatusSections({
          source: groupedSource,
          states: state,
          limit: props.state.recentLimit(),
          pin: sort === "updated" ? pinWorkingFirst : (rows) => rows,
          compare: compareChatSidebarSessions(sort, titleOf),
          titleOf,
          groupMembersOf: (group, scope) =>
            groupMembersInSidebarScope(group, scope, (session) => state.get(session.id) ?? "idle"),
        }),
      )
    }
    // All status-relevant sparse owner values have already been indexed above.
    // The absence of an ID is semantically idle, never an implicit fetch.
    const stateForProjection = (session: Session) =>
      mode === "status" ? statusStateIndex().get(session.id) ?? "idle" : rowState(session)
    const scopedStatusMembers = new Map<ChatSidebarStatusBucket, Session[]>()
    if (mode === "status") {
      for (const member of sidebarGroupSessions()) {
        const bucket = chatSidebarStatusBucket(stateForProjection(member))
        const list = scopedStatusMembers.get(bucket)
        if (list) list.push(member)
        else scopedStatusMembers.set(bucket, [member])
      }
    }
    const next = buildChatSidebarSections({
      mode,
      sort,
      recent: sort === "updated" ? recentWithGroupMembers() : recentPool,
      projects: [],
      groupOf,
      stateOf: mode === "status" ? stateForProjection : rowState,
      titleOf,
      pin: pinWorkingFirst,
      limit: props.state.recentLimit(),
      cluster: true,
      sessionsForScope: (scope) =>
        scope.kind === "project"
          ? sidebarGroupSessionsByProject().get(scope.projectKey) ?? []
          : scope.kind === "recent"
            ? sidebarGroupSessions()
            : scopedStatusMembers.get(scope.status) ?? [],
      groupMembersOf: (group, scope) => groupMembersInSidebarScope(group, scope, stateForProjection),
    })
    return reuseChatSidebarSections(previous, next)
  })

  const sectionExpanded = (key: string) => !props.state.isGroupCollapsed(key)


  // <For> keys by reference; sections and cluster items are re-minted whenever
  // a count/total/member order moves. Render through key-stable slots instead so
  // such changes update in place and never remount the section or its rows.
  const createSlot = <T,>(key: string, value: T): ChatSidebarSlot<T> => {
    const [get, set] = createSignal(value, { equals: false })
    return { key, get, set: (next) => set(() => next) }
  }
  let sectionSlotState: ChatSidebarSlotState<ChatSidebarSection> | undefined
  const sectionSlots = createMemo(() => {
    const next = sections()
    return untrack(() => {
      sectionSlotState = reconcileChatSidebarSlots(sectionSlotState, next, (section) => section.key, () => true, createSlot)
      return sectionSlotState.slots
    })
  })
  const itemSlotStates = new Map<string, ChatSidebarSlotState<ChatSidebarItem>>()
  const itemSlots = (sectionKey: string, items: readonly ChatSidebarItem[]) => {
    const state = reconcileChatSidebarSlots(
      itemSlotStates.get(sectionKey),
      items,
      (item) => item.key,
      // A metadata update to an existing session is consumed reactively by its
      // mounted row; never tear down its observer or session runtime lease.
      canReuseChatSidebarItemSlot,
      createSlot,
    )
    itemSlotStates.set(sectionKey, state)
    return state.slots
  }

  // Footer counts server-known roots per directory (sessionTotal estimates),
  // not loaded rows — loaded rows are capped per store and would undercount.
  const totalSessions = createMemo(() => {
    let sum = 0
    for (const head of projectHeads().values()) sum += head.total
    return sum
  })

  // Preserve the exact session scope of the previous row scans without
  // subscribing this footer to every idle row's reactive state. Runtime status
  // and pending responses are materialized in the shared server-session owner.
  const footerScope = createMemo(() => {
    const directories = new Map<string, Set<string>>()
    const add = (id: string, directory: string) => {
      let scopes = directories.get(id)
      if (!scopes) {
        scopes = new Set<string>()
        directories.set(id, scopes)
      }
      scopes.add(directory)
    }
    for (const session of baseGroups().recentPool) add(session.id, session.directory ?? "")
    for (const group of visibleMemberGroups()) {
      for (const member of group.sessions) add(member.id, member.directory ?? "")
    }
    return { directories, ids: new Set(directories.keys()) }
  }, undefined, { equals: sameChatSidebarDirectoryScope })

  const waitingCount = createMemo(() => {
    const data = serverSync().session.data
    return countSidebarWaiting(footerScope().directories, data.question, data.permission, (request, directory) =>
      permissionState().autoResponds(request, directory),
    )
  })

  const workingCount = createMemo(() => {
    // Reuse the single sparse working projection shared with working-first
    // ordering instead of independently enumerating all status rows again.
    const ids = footerScope().ids
    let count = 0
    for (const id of workingIDs()) if (ids.has(id)) count++
    return count
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
  // Match the selected session by identity, including group-member routes.
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
    const current = sections()
    const anchorID = sessionGroups
      .list()
      .find((group) => group.sessionIds.includes(id) && !!group.anchorSessionID)?.anchorSessionID
    const matches = (session: Session) => session.id === id || session.id === anchorID
    let target: string | undefined
    let cluster: string | undefined
    for (const section of current) {
      for (const item of section.items) {
        if (item.type === "session" ? matches(item.session) : item.members.some(matches)) {
          target = section.key
          if (item.type === "cluster") cluster = item.group.id
          break
        }
      }
      if (target) break
    }
    target ??= current.find((section) => {
      const directory = section.projectKey ? projectHeads().get(section.projectKey)?.directory : undefined
      return directory && base64Encode(directory) === params.dir
    })?.key
    if (!target) return
    revealedFor = id
    props.state.revealGroup(target)
    if (cluster) props.state.revealCluster(cluster)
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
    archivedDirectories()
    // The request reads cached row length to choose its skeleton. That read is
    // not an invalidation signal: only expansion/visibility/directories should
    // refetch, or the response would itself trigger another fetch.
    untrack(() => void fetchArchived())
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
      disposed?: boolean
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
      // Deliberately NOT a memo: memos are eager, so a memo here would re-run at
      // 1 Hz for every working session whose runtime is leased, visible or not.
      // As a plain accessor it subscribes to the shared clock only inside a
      // consumer (ChatRow's visibility-gated rowLive memo).
      const live = (): ChatRowLive | undefined => {
        if (!isWorking()) return undefined
        now()
        return telemetryLive(
          telemetry(),
          serverSync().telemetry.receivedAt(sessionID),
          sessionTelemetryClientNow(),
        )
      }

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
      update: (next) => {
        if (next.id === session.id && !entry!.disposed) entry!.update(next)
      },
      release: () => {
        if (released) return
        released = true
        const current = rowRuntimeEntries.get(session.id)
        if (current !== entry) return
        current.refs -= 1
        if (current.refs > 0) return
        // A view switch / section re-key disposes the old row subtree and mounts
        // the new one in the same task. Tearing the runtime down eagerly would
        // rebuild ~14 memos per row only to recreate them a moment later, so give
        // re-leasing one microtask of grace before disposing.
        queueMicrotask(() => {
          if (current.refs > 0 || current.disposed) return
          current.disposed = true
          if (rowRuntimeEntries.get(session.id) === current) rowRuntimeEntries.delete(session.id)
          current.dispose()
        })
      },
    }
  }

  onCleanup(() => {
    for (const entry of rowRuntimeEntries.values()) {
      entry.disposed = true
      entry.dispose()
    }
    rowRuntimeEntries.clear()
  })

  // Dense sidebars cannot afford one Kobalte/floating-ui controller per
  // tooltip anchor. Follow the model selector's proven architecture instead:
  // one pane-level intent controller, one portal, one positioning RAF, and at
  // most one MutationObserver (only while a dynamic plain-text tooltip is
  // actually open). Rows publish metadata through data attributes; pointer and
  // focus intent is handled here via event delegation.
  const SESSION_PREVIEW_HOVER_DELAY_MS = 650
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
  const [tooltipSurfaceRequested, setTooltipSurfaceRequested] = createSignal(false)
  const [richPreviewRequested, setRichPreviewRequested] = createSignal(false)
  createEffect(() => {
    const current = sharedTooltip()
    if (!current) return
    setTooltipSurfaceRequested(true)
    if (current.sessionID) setRichPreviewRequested(true)
  })
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
    const closingPending = !anchor || pendingTooltip?.anchor === anchor
    if (closingPending) pendingTooltip = undefined
    if (closingPending && tooltipOpenTimer !== undefined) {
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
    if (current.sessionID) setHoveredTreeKey(undefined)
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
      if (intent.sessionID) {
        const block = intent.anchor.closest<HTMLElement>("[data-chat-sidebar-virtual-block]")
        setHoveredTreeKey(block?.dataset.blockKey)
      }
      syncTooltipText(intent)
      queueSharedTooltipPosition()
      return
    }
    describeTooltipAnchor(intent.anchor)
    syncTooltipText(intent)
    if (intent.sessionID) {
      const block = intent.anchor.closest<HTMLElement>("[data-chat-sidebar-virtual-block]")
      setHoveredTreeKey(block?.dataset.blockKey)
    } else {
      setHoveredTreeKey(undefined)
    }
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
    // The rich inspector is hover-only. Start downloading its chunk during the
    // intent window instead of paying for that module graph at sidebar startup.
    if (intent.sessionID) void loadSessionPreviewCard()
    const current = sharedTooltip()
    if (current?.anchor === intent.anchor) {
      if (pendingTooltip && pendingTooltip.anchor !== intent.anchor) {
        pendingTooltip = undefined
        if (tooltipOpenTimer !== undefined) {
          clearTimeout(tooltipOpenTimer)
          tooltipOpenTimer = undefined
        }
      }
      if (tooltipCloseGraceTimer !== undefined) {
        clearTimeout(tooltipCloseGraceTimer)
        tooltipCloseGraceTimer = undefined
      }
      return
    }
    if (tooltipOpenTimer !== undefined) clearTimeout(tooltipOpenTimer)
    pendingTooltip = intent
    // A session inspector needs a deliberate initial dwell. Once it is open,
    // keep it responsive while the pointer moves between related rows.
    const skipDelay = intent.sessionID
      ? !!current?.sessionID
      : !!current || performance.now() - lastTooltipClosedAt < 300
    if (skipDelay) {
      showSharedTooltip(intent)
      return
    }
    const delay = intent.sessionID ? SESSION_PREVIEW_HOVER_DELAY_MS : 400
    tooltipOpenTimer = setTimeout(() => {
      tooltipOpenTimer = undefined
      if (pendingTooltip !== intent) return
      showSharedTooltip(intent)
    }, delay)
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
    if (pendingTooltip?.anchor === anchor) {
      pendingTooltip = undefined
      if (tooltipOpenTimer !== undefined) {
        clearTimeout(tooltipOpenTimer)
        tooltipOpenTimer = undefined
      }
    }
    const current = sharedTooltip()
    if (!current) return
    if (!current.sessionID) {
      if (current.anchor === anchor) closeSharedTooltip(anchor)
      return
    }
    if (tooltipCloseGraceTimer !== undefined) clearTimeout(tooltipCloseGraceTimer)
    const closingAnchor = current.anchor
    tooltipCloseGraceTimer = setTimeout(() => {
      tooltipCloseGraceTimer = undefined
      if (sharedTooltipCardHovered || sharedTooltipCardContextMenuOpen()) return
      if (closingAnchor.matches(":hover")) return
      closeSharedTooltip(closingAnchor)
    }, 200)
  }

  const handleTooltipPointerOut = (event: PointerEvent) => {
    const previous = tooltipAnchorFrom(event.target)
    const next = tooltipAnchorFrom(event.relatedTarget)
    if (!previous || previous === next) return
    if (suppressedTooltipAnchor === previous) suppressedTooltipAnchor = undefined
    if (next) {
      const intent = tooltipIntentFrom(next)
      if (intent) {
        scheduleCloseSharedTooltip(previous)
        scheduleSharedTooltip(intent)
      }
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
    if (!sessionID) return undefined
    const groups = sessionGroups.list()
    return sessionPreviewProjectionCache.session({ sessionID, groups, index: sessionGroups.previewIndex() })
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

  const tooltipVisible = createMemo(() => !!sharedTooltip())
  createEffect(() => {
    if (!tooltipVisible()) return
    // One active positioning observer pair per pane, zero listeners while
    // closed; switching hovered rows does not re-register these listeners.
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

  const showMoreInSection = (section: ChatSidebarSection) => {
    if (section.kind !== "project") {
      // Recent and the Status idle tail are already held in memory, so
      // revealing more is pure client state.
      props.state.showMoreRecent()
      return
    }
    const head = section.projectKey ? projectHeads().get(section.projectKey) : undefined
    if (!head) return
    const [, setStore] = serverSync().child(head.directory, { bootstrap: false })
    setStore("limit", (prev) => (prev ?? 5) + 5)
    void serverSync().project.loadSessions(head.directory, { projectID: head.project.id })
  }

  const canShowLessInSection = (section: ChatSidebarSection) => {
    if (section.kind !== "project") {
      if (section.kind === "status" && section.status !== "idle") return false
      return props.state.recentLimit() > CHAT_SIDEBAR_RECENT_LIMIT_MIN
    }
    const head = section.projectKey ? projectHeads().get(section.projectKey) : undefined
    return !!head && (serverSync().child(head.directory, { bootstrap: false })[0].limit ?? 5) > 5
  }

  const showLessInSection = (section: ChatSidebarSection) => {
    if (section.kind !== "project") {
      props.state.showLessRecent()
      return
    }
    const head = section.projectKey ? projectHeads().get(section.projectKey) : undefined
    if (!head) return
    const [store] = serverSync().child(head.directory, { bootstrap: false })
    void serverSync().project.loadSessions(head.directory, {
      shrinkTo: Math.max(5, (store.limit ?? 5) - 5),
      projectID: head.project.id,
    })
  }

  type ChatSidebarVirtualBlock =
    | { type: "oxp"; key: "oxp" }
    | { type: "empty"; key: "empty" }
    | { type: "section-head"; key: string; section: ChatSidebarSlot<ChatSidebarSection> }
    | {
        type: "session"
        key: string
        section: ChatSidebarSlot<ChatSidebarSection>
        item: ChatSidebarSlot<ChatSidebarItem>
        sectionHeadKey: string
      }
    | {
        type: "cluster-head"
        key: string
        section: ChatSidebarSlot<ChatSidebarSection>
        item: ChatSidebarSlot<ChatSidebarItem>
        sectionHeadKey: string
      }
    | {
        type: "cluster-member"
        key: string
        section: ChatSidebarSlot<ChatSidebarSection>
        item: ChatSidebarSlot<ChatSidebarItem>
        sectionHeadKey: string
        clusterHeadKey: string
        member: Session
        memberID: string
        memberIndex: number
      }
    | { type: "more"; key: string; section: ChatSidebarSlot<ChatSidebarSection>; sectionHeadKey: string }
    | { type: "less"; key: string; section: ChatSidebarSlot<ChatSidebarSection>; sectionHeadKey: string }
    | { type: "archived"; key: "archived" }

  const sameVirtualBlock = (a: ChatSidebarVirtualBlock, b: ChatSidebarVirtualBlock) => {
    if (a.type !== b.type || a.key !== b.key) return false
    if (a.type === "oxp" || a.type === "empty" || a.type === "archived") return true
    if (b.type === "oxp" || b.type === "empty" || b.type === "archived") return false
    if (a.type === "section-head" && b.type === "section-head") return a.section === b.section
    if (a.type === "more" && b.type === "more") return a.section === b.section
    if (a.type === "less" && b.type === "less") return a.section === b.section
    if (a.type === "session" && b.type === "session") {
      return a.section === b.section && a.item === b.item && a.sectionHeadKey === b.sectionHeadKey
    }
    if (a.type === "cluster-head" && b.type === "cluster-head") {
      return a.section === b.section && a.item === b.item && a.sectionHeadKey === b.sectionHeadKey
    }
    if (a.type === "cluster-member" && b.type === "cluster-member") {
      return (
        a.section === b.section &&
        a.item === b.item &&
        a.sectionHeadKey === b.sectionHeadKey &&
        a.clusterHeadKey === b.clusterHeadKey &&
        a.member === b.member &&
        a.memberID === b.memberID &&
        a.memberIndex === b.memberIndex
      )
    }
    return false
  }

  const treeVirtualBlocks = createMemo<ChatSidebarVirtualBlock[]>((previous = []) => {
    const slots = sectionSlots()
    const next: ChatSidebarVirtualBlock[] = [{ type: "oxp", key: "oxp" }]
    const liveSectionKeys = new Set<string>()

    if (slots.length === 0) next.push({ type: "empty", key: "empty" })

    for (const sectionSlot of slots) {
      const section = sectionSlot.get()
      const sectionKey = sectionSlot.key
      const sectionHeadKey = `section-head:${sectionKey}`
      liveSectionKeys.add(sectionKey)
      next.push({ type: "section-head", key: sectionHeadKey, section: sectionSlot })
       if (!sectionExpanded(sectionKey)) {
         // A collapsed section retains no mounted rows; drop its row slots too
         // instead of holding references to its former full session list.
         itemSlotStates.delete(sectionKey)
         continue
       }

      const slotsForSection = untrack(() => itemSlots(sectionKey, section.items))
      for (const itemSlot of slotsForSection) {
        const item = itemSlot.get()
        if (item.type === "session") {
          next.push({
            type: "session",
            key: `session:${sectionKey}:${item.session.id}`,
            section: sectionSlot,
            item: itemSlot,
            sectionHeadKey,
          })
          continue
        }

        const clusterHeadKey = `cluster-head:${sectionKey}:${item.group.id}`
        next.push({
          type: "cluster-head",
          key: clusterHeadKey,
          section: sectionSlot,
          item: itemSlot,
          sectionHeadKey,
        })
        if (!props.state.isClusterExpanded(item.group.id)) continue
        for (let memberIndex = 0; memberIndex < item.members.length; memberIndex++) {
          const member = item.members[memberIndex]
          if (!member) continue
          next.push({
            type: "cluster-member",
            key: `cluster-member:${sectionKey}:${item.group.id}:${member.id}`,
            section: sectionSlot,
            item: itemSlot,
            sectionHeadKey,
            clusterHeadKey,
            member,
            memberID: member.id,
            memberIndex,
          })
        }
      }

      if (section.total > section.sessionCount) {
        next.push({ type: "more", key: `more:${sectionKey}`, section: sectionSlot, sectionHeadKey })
      }
      if (canShowLessInSection(section)) {
        next.push({ type: "less", key: `less:${sectionKey}`, section: sectionSlot, sectionHeadKey })
      }
    }

    for (const key of itemSlotStates.keys()) {
      if (!liveSectionKeys.has(key)) itemSlotStates.delete(key)
    }
    next.push({ type: "archived", key: "archived" })

    return reuseChatSidebarVirtualBlocks(previous, next, sameVirtualBlock)
  })

  const [treeScrollRoot, setTreeScrollRoot] = createSignal<HTMLDivElement>()
  const [treeScrollOffset, setTreeScrollOffset] = createSignal(0)
  // Session ordering can change while the user is interacting (status moves,
  // working-first pinning, group expansion). Persist a block identity rather
  // than its index, otherwise a reorder pins an unrelated row and can trap
  // keyboard focus or leave the tooltip attached to a recycled virtual slot.
  const [focusedTreeKey, setFocusedTreeKey] = createSignal<string>()
  const [hoveredTreeKey, setHoveredTreeKey] = createSignal<string>()
  const treeBlockIndexByKey = createMemo(() => {
    const result = new Map<string, number>()
    const blocks = treeVirtualBlocks()
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]
      if (block) result.set(block.key, index)
    }
    return result
  })
  const focusedTreeBlock = createMemo(() => {
    const key = focusedTreeKey()
    return key ? treeBlockIndexByKey().get(key) ?? -1 : -1
  })
  const hoveredTreeBlock = createMemo(() => {
    const key = hoveredTreeKey()
    return key ? treeBlockIndexByKey().get(key) ?? -1 : -1
  })
  const stickyMarkers = createMemo(() => indexChatSidebarStickyHeaders(treeVirtualBlocks()))
  // TanStack caches virtual measurements by item key. Recreating getItemKey
  // whenever reactive options are evaluated changes the callback identity and
  // can invalidate measurements while the user is scrolling; keep it stable.
  const treeItemKey = (index: number) => treeVirtualBlocks()[index]?.key ?? index
  const treeRangeExtractor = (range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range)
    const sticky = stickyChatSidebarHeader(stickyMarkers(), range.startIndex)
    for (const pinned of [focusedTreeBlock(), hoveredTreeBlock(), sticky]) {
      if (pinned >= 0 && pinned < range.count && !indexes.includes(pinned)) indexes.push(pinned)
    }
    return indexes.sort((a, b) => a - b)
  }
  const treeVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return treeVirtualBlocks().length
    },
    getScrollElement: () => treeScrollRoot() ?? null,
    onChange: (instance) => setTreeScrollOffset(instance.scrollOffset ?? 0),
    initialRect: { width: 320, height: 720 },
    // Keep the estimator callback stable. A fresh closure on each virtualizer
    // options read can invalidate sizing while sessions stream/reorder.
    estimateSize: (index) => {
      const block = treeVirtualBlocks()[index]
      if (!block) return 24
      const fixed = sidebarFixedBlockHeight(block.type, props.state.density())
      if (fixed !== undefined) return fixed
      if (block.type === "empty") return 100
      if (block.type === "oxp") return props.state.isGroupCollapsed("oxp") ? 24 : 180
      return props.state.isArchivedExpanded()
        ? 24 + Math.max(1, Math.min(archivedState.rows.length, props.state.archivedLimit())) * 30
        : 24
    },
    overscan: 8,
    paddingEnd: 6,
    getItemKey: treeItemKey,
    rangeExtractor: treeRangeExtractor,
  })
  // Only density changes reset measured coordinates. An ordinary session
  // update must never make an already painted row fall back to a 0px slot.
  createEffect(on(
    () => props.state.density(),
    (_density, previous) => {
      if (previous !== undefined) treeVirtualizer.measure()
    },
  ))
  const activeStickyTreeBlock = createMemo(() => {
    treeScrollOffset() // The virtualizer's range is mutable; subscribe to scroll.
    const start = treeVirtualizer.range?.startIndex
    if (start === undefined) return -1
    return stickyChatSidebarHeader(stickyMarkers(), start)
  })
  const treeVirtualRows = createMemo<
    Array<{
      virtualRow: ReturnType<typeof treeVirtualizer.getVirtualItems>[number]
      block: ChatSidebarVirtualBlock | undefined
      key: string | number
    }>
  >((previous = []) => {
    const prior = new Map(previous.map((entry) => [entry.key, entry] as const))
    const blocks = treeVirtualBlocks()
    return treeVirtualizer.getVirtualItems().map((virtualRow) => {
      const block = blocks[virtualRow.index]
      const key = block?.key ?? virtualRow.index
      const existing = prior.get(key)
      if (
        existing &&
        existing.block === block &&
        existing.virtualRow.index === virtualRow.index &&
        existing.virtualRow.start === virtualRow.start &&
        existing.virtualRow.size === virtualRow.size
      ) {
        return existing
      }
      return { virtualRow, block, key }
    })
  })

const memberForBlock = (
  block: Extract<ChatSidebarVirtualBlock, { type: "cluster-member" }>,
) => block.member

  // Warm only rows whose virtual items are mounted. This is deliberately more
  // selective than the old section-level warming: a 500-session project or a
  // 200-member swarm costs roughly one viewport of telemetry subscriptions.
  createEffect(() => {
    const ids = new Set<string>()
    for (const entry of treeVirtualRows()) {
      const block = entry.block
      if (!block) continue
      if (block.type === "session") {
        const item = block.item.get()
        if (item.type === "session") ids.add(item.session.id)
      } else if (block.type === "cluster-head") {
        const item = block.item.get()
        if (item.type === "cluster") ids.add(item.lead.id)
      } else if (block.type === "cluster-member") {
        const member = memberForBlock(block)
        if (member) ids.add(member.id)
      }
    }
    serverSync().telemetry.ensure([...ids])
  })

  // JetBrains-style tree keyboard model over mounted nodes. Crossing a virtual
  // window boundary first scrolls the target block into range, then focuses its
  // first/last tree item on the next frame.
  const TREE_ITEM_SELECTOR = '[data-slot="section-head"], [data-tree-item], [data-component="chats-oxp-activity-row"]'
  let treeElement: HTMLDivElement | undefined
  let treeFocusRequest = 0
  onCleanup(() => {
    // An outstanding animation-frame focus request must not target DOM from
    // a disposed sidebar after the user closes the pane or switches routes.
    treeFocusRequest++
  })
  const focusVirtualBlock = (index: number, edge: "first" | "last", step: -1 | 1) => {
    const request = ++treeFocusRequest
    const seek = (candidate: number) => {
      const blocks = treeVirtualBlocks()
      if (request !== treeFocusRequest || candidate < 0 || candidate >= blocks.length) return
      const key = blocks[candidate]?.key
      if (!key) return
      setFocusedTreeKey(key)
      treeVirtualizer.scrollToIndex(candidate, { align: "auto" })
      let attempts = 0
      const focusWhenMounted = () => {
        if (request !== treeFocusRequest) return
        // Status updates can reorder virtual blocks between the scroll call
        // and this frame. Resolve the same *identity*, not yesterday's index;
        // otherwise ArrowDown/Up may focus a different session.
        const currentIndex = treeBlockIndexByKey().get(key)
        if (currentIndex === undefined) {
          seek(candidate + step)
          return
        }
        if (currentIndex !== candidate) treeVirtualizer.scrollToIndex(currentIndex, { align: "auto" })
        const block = treeElement?.querySelector<HTMLElement>(
          `[data-chat-sidebar-virtual-block][data-index="${currentIndex}"]`,
        )
        const items = block ? [...block.querySelectorAll<HTMLElement>(TREE_ITEM_SELECTOR)] : []
        const target = edge === "first" ? items[0] : items[items.length - 1]
        if (!target) {
          // A virtualizer can take one additional frame to commit its new
          // range after scrollToIndex (or after a same-tick status reorder).
          // Do not skip a legitimate keyboard target before it has mounted.
          // Bound retries so non-focusable footer blocks are still skipped.
          if (attempts++ < 2) {
            requestAnimationFrame(focusWhenMounted)
            return
          }
          seek(currentIndex + step)
          return
        }
        target.focus({ preventScroll: true })
        target.scrollIntoView({ block: "nearest" })
      }
      requestAnimationFrame(focusWhenMounted)
    }
    seek(index)
  }
  const focusVirtualBlockByKey = (key: string | undefined, edge: "first" | "last" = "first") => {
    if (!key) return false
    const index = treeBlockIndexByKey().get(key)
    if (index === undefined) return false
    focusVirtualBlock(index, edge, edge === "first" ? 1 : -1)
    return true
  }
  const handleTreeKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (!(event.target instanceof HTMLElement) || !treeElement) return
    const item = event.target.closest<HTMLElement>(TREE_ITEM_SELECTOR)
    if (!item || !treeElement.contains(item)) return
    const blockElement = item.closest<HTMLElement>("[data-chat-sidebar-virtual-block]")
    const blockIndex = Number(blockElement?.dataset.index)
    const items = blockElement ? [...blockElement.querySelectorAll<HTMLElement>(TREE_ITEM_SELECTOR)] : []
    const index = items.indexOf(item)
    const focus = (target: HTMLElement | undefined | null) => {
      if (!target) return
      treeFocusRequest += 1
      event.preventDefault()
      // preventScroll: scrollIntoView below is the single scroll/layout pass.
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: "nearest" })
    }
    const expanded = item.getAttribute("aria-expanded")
    switch (event.key) {
      case "ArrowDown":
        if (items[index + 1]) focus(items[index + 1])
        else if (Number.isFinite(blockIndex)) {
          event.preventDefault()
          focusVirtualBlock(blockIndex + 1, "first", 1)
        }
        return
      case "ArrowUp":
        if (items[index - 1]) focus(items[index - 1])
        else if (Number.isFinite(blockIndex)) {
          event.preventDefault()
          focusVirtualBlock(blockIndex - 1, "last", -1)
        }
        return
      case "Home":
        event.preventDefault()
        focusVirtualBlock(0, "first", 1)
        return
      case "End":
        event.preventDefault()
        focusVirtualBlock(treeVirtualBlocks().length - 1, "last", -1)
        return
      case "ArrowRight":
        if (expanded === "false") {
          event.preventDefault()
          item.click()
        } else if (expanded === "true") {
          if (items[index + 1]) focus(items[index + 1])
          else if (Number.isFinite(blockIndex)) {
            event.preventDefault()
            focusVirtualBlock(blockIndex + 1, "first", 1)
          }
        }
        return
      case "ArrowLeft": {
        if (expanded === "true") {
          event.preventDefault()
          item.click()
          return
        }
        if (
          focusVirtualBlockByKey(
            blockElement?.dataset.clusterOwnerKey ?? blockElement?.dataset.sectionOwnerKey,
          )
        ) {
          event.preventDefault()
          return
        }
        const cluster = item.closest('[data-slot="cluster-body"]')?.parentElement
        const owner =
          cluster?.querySelector<HTMLElement>('[data-slot="cluster-head"]') ??
          item.closest('[data-slot="section"]')?.querySelector<HTMLElement>('[data-slot="section-head"]')
        if (owner && owner !== item) focus(owner)
        return
      }
    }
  }

  const statusTone: Record<ChatSidebarStatusBucket, ChatSidebarRowState> = {
    attention: "attention",
    working: "working",
    unread: "unread",
    idle: "idle",
  }

  const clusterIcon = (kind: string) =>
    kind === "swarm" ? "layers" : kind === "delegation" ? "branch" : kind === "plugin" ? "workspace" : "folder"

  const clusterKindLabel = (kind: string) => {
    switch (kind) {
      case "swarm":
        return language.t("chats.cluster.kind.swarm")
      case "plugin":
        return language.t("chats.cluster.kind.plugin")
      case "delegation":
        return language.t("chats.cluster.kind.delegation")
      case "subagent":
        return language.t("chats.cluster.kind.subagent")
      default:
        return language.t("chats.cluster.kind.user")
    }
  }

  const renderRow = (
    input: Session | Accessor<Session>,
    options: {
      directory: () => string
      label?: () => string | undefined
      member?: boolean
      inGroupId?: string
    },
  ) => {
    const session = typeof input === "function" ? input : () => input
    const group = () => groupOf(session())
    const fallbackGroup = () => sessionGroups.groupForSession(session().id)
    const relatedCount = () => {
      const current = group()
      return current ? sidebarClusterGroups().byGroup.get(current.id)?.length : fallbackGroup()?.sessionIds.length
    }
    return (
      <ChatRow
        session={session()}
        label={options.label?.()}
        density={options.member ? "compact" : props.state.density()}
        // Group members sit under a head whose bar already shows running state, so
        // they get the static dot; only top-level rows may draw from the pulse budget.
        animateWorkingIndicator={!options.member}
        indicatorBudget={indicatorBudget}
        observeVisibility={observeRowVisibility}
        relatedCount={options.member ? undefined : relatedCount()}
        inGroupId={options.inGroupId ?? group()?.id ?? fallbackGroup()?.id}
        selected={activeSessionId() === session().id}
        minuteNow={minuteNow}
        runtimeLease={leaseRowRuntime}
        pending={pendingSessionId() === session().id}
        onPending={(id) => {
          if (params.id !== id) setPendingSessionId(id)
        }}
        archiveSession={() => archiveSession(session())}
        prefetchSession={() => prefetchSession(session())}
        onChangeModel={openModelPicker}
        onNewSessionInProject={() => navigateToNewSession(session().directory || options.directory())}
        onOpenProjectInExplorer={() => {
          const directory = session().directory || options.directory()
          if (directory) void platform.revealPath?.(directory)
        }}
        onCopyProjectPath={() => {
          const directory = session().directory || options.directory()
          if (directory) void navigator.clipboard.writeText(directory)
        }}
        onForkConversation={() => {
          void import("@/components/dialog-fork").then(({ DialogFork }) =>
            dialog.show(() => <DialogFork sessionID={session().id} />),
          )
        }}
      />
    )
  }

  /** One folded SessionGroup: a single 24px node with a member-state bar. */
  const ClusterNode = (node: {
    item: () => ChatSidebarClusterItem
    directory: () => string
    renderMembers?: boolean
  }) => {
    // The node is the rich preview's anchor for the whole group, so it keeps
    // its lead's shared runtime alive (one lease, not one per member). The item
    // is read through a slot: it is replaced when membership/order changes, but
    // this node (and every expanded member row) stays mounted.
    let leased = leaseRowRuntime(node.item().lead)
    let leasedID = node.item().lead.id
    createEffect(() => {
      const lead = node.item().lead
      if (lead.id === leasedID) return
      const next = leaseRowRuntime(lead)
      leased.release()
      leased = next
      leasedID = lead.id
    })
    onCleanup(() => leased.release())
    const groupID = node.item().group.id
    const [groupContextMenu, setGroupContextMenu] = createSignal<{ x: number; y: number }>()
    const expanded = () => props.state.isClusterExpanded(groupID)
    const containsActive = () => node.item().members.some((member) => member.id === activeSessionId())
    // Counts are derived per node from the members' fine-grained state signals,
    // so one member flipping recomputes this tally (and the head bar) only.
    const counts = createMemo(() => countChatSidebarClusterStates(node.item().members, rowState), undefined, {
      equals: sameChatSidebarClusterCounts,
    })
    const segments = createMemo(() => {
      const c = counts()
      return (
        [
          ["error", c.error],
          ["attention", c.attention],
          ["working", c.working],
          ["unread", c.unread],
          ["idle", c.idle],
        ] as const
      ).filter(([, count]) => count > 0)
    })
    const summary = createMemo(() =>
      language.t("chats.cluster.summary", {
        kind: clusterKindLabel(node.item().group.kind),
        running: String(counts().working),
        waiting: String(counts().attention),
        idle: String(counts().idle + counts().unread),
      }),
    )
    return (
      <>
      <div data-slot="cluster" role="treeitem" aria-expanded={expanded()}>
        <button
          type="button"
          data-slot="cluster-head"
          data-tree-item
          data-cluster-id={groupID}
          data-current={containsActive() ? "" : undefined}
          data-chat-tooltip-session={node.item().lead.id}
          data-chat-tooltip-placement="right"
          aria-expanded={expanded()}
          aria-label={`${node.item().group.name}, ${summary()}`}
          onClick={() => props.state.toggleCluster(groupID)}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setGroupContextMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <IconV2 name="chevron-down" size="small" data-slot="cluster-chevron" />
          <span data-slot="cluster-icon">
            <IconV2 name={clusterIcon(node.item().group.kind)} size="small" />
          </span>
          <span data-slot="cluster-label">{node.item().group.name}</span>
          <span data-slot="cluster-bar" aria-hidden="true">
            <For each={segments()}>
              {([tone, count]) => <span data-slot="seg" data-tone={tone} style={{ "flex-grow": count }} />}
            </For>
          </span>
          <span data-slot="cluster-stats">
            <Show when={counts().attention + counts().error > 0}>
              <span data-slot="stat" data-tone={counts().error > 0 ? "error" : "attention"}>
                <span data-slot="dot" data-tone={counts().error > 0 ? "error" : "attention"} />
                {counts().attention + counts().error}
              </span>
            </Show>
            <Show when={counts().working > 0}>
              <span data-slot="stat" data-tone="working">
                <span data-slot="dot" data-tone="working" />
                {counts().working}
              </span>
            </Show>
            <span data-slot="stat">{counts().total}</span>
          </span>
        </button>
        <Show when={node.renderMembers !== false && expanded()}>
          <div data-slot="cluster-body" role="group">
            <For each={node.item().members}>
              {(member, index) =>
                renderRow(member, {
                  directory: node.directory,
                  label: () => node.item().labels[index()],
                  member: true,
                  inGroupId: node.item().group.id,
                })
              }
            </For>
          </div>
        </Show>
      </div>
      <Show when={groupContextMenu()} keyed>
        {(cursor) => (
          <Suspense fallback={null}>
            <SidebarSessionContextMenu
              cursor={cursor}
              where="chats"
              session={node.item().lead}
              server={paneServerKey()}
              isGroup
              groupId={groupID}
              onChangeModel={openModelPicker}
              onOpenChange={(open) => {
                if (!open) setGroupContextMenu(undefined)
              }}
            />
          </Suspense>
        )}
      </Show>
      </>
    )
  }

  const SectionHead = (head: { section: () => ChatSidebarSection }) => {
    const section = head.section
    const project = () => {
      const key = section().projectKey
      return key ? projectHeads().get(key) : undefined
    }
    const label = () => {
      const current = section()
      if (current.kind === "recent") return language.t("chats.view.recent")
      if (current.kind === "status") return language.t(`chats.status.${current.status ?? "idle"}`)
      return project()?.label ?? ""
    }
    return (
      <button
        type="button"
        data-slot="section-head"
        role="treeitem"
        onClick={() => props.state.toggleGroup(section().key)}
        aria-expanded={sectionExpanded(section().key)}
      >
        <IconV2 name="chevron-down" size="small" data-slot="section-chevron" />
        <Switch>
          <Match when={section().kind === "project" && project()}>
            {(meta) => (
              <span data-slot="section-icon">
                <ProjectAvatar
                  class="!size-3.25"
                  fallback={displayName(meta().project)}
                  src={getProjectAvatarSource(meta().project.id, meta().project.icon)}
                  variant={getProjectAvatarVariant(meta().project.icon?.color)}
                />
              </span>
            )}
          </Match>
          <Match when={section().kind === "status"}>
            <span data-slot="section-icon">
              <span data-slot="dot" data-tone={statusTone[section().status ?? "idle"]} />
            </span>
          </Match>
        </Switch>
        <span data-slot="section-label">{label()}</span>
        <Show when={section().kind === "project" && project()?.directory} fallback={<span data-slot="section-spacer" />}>
          {(directory) => (
            <span data-slot="section-meta" data-chat-tooltip-text={directory()} data-chat-tooltip-placement="top">
              {directory()}
            </span>
          )}
        </Show>
        <span data-slot="section-count">{section().total}</span>
        <Show when={section().kind === "project" && project()?.directory}>
          {(directory) => (
            <span
              role="button"
              tabIndex={0}
              data-slot="section-action"
              data-chat-tooltip-text={language.t("command.session.new")}
              data-chat-tooltip-placement="top"
              aria-label={language.t("command.session.new")}
              onClick={(event) => {
                event.stopPropagation()
                event.preventDefault()
                navigateToNewSession(directory())
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.stopPropagation()
                event.preventDefault()
                navigateToNewSession(directory())
              }}
            >
              <IconV2 name="plus" size="small" />
            </span>
          )}
        </Show>
      </button>
    )
  }

  const viewIcon = { recent: "clock", projects: "folder", status: "status" } as const
  const viewLabel = (view: ChatSidebarViewMode) => language.t(`chats.view.${view}`)

  return (
    <div
      ref={(element) => {
        paneElement = element
      }}
      id="chat-sidebar-pane"
      class="relative my-2 ms-2 flex min-h-0 shrink-0 select-none flex-col self-stretch overflow-hidden rounded-[7px] border border-v2-border-border-base/60 bg-v2-background-bg-base shadow-[0_1px_2px_0_var(--v2-alpha-dark-6),0_1px_3px_0_var(--v2-alpha-dark-4),0_0_0_0.5px_var(--v2-alpha-dark-8)]"
      style={{ width: `${props.state.sidebarWidth()}px` }}
      data-chat-sidebar-pane
      data-view={props.state.view()}
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
      {/* ── Tool-window title bar ─────────────────────────────── */}
      <div data-slot="titlebar">
        <span data-slot="title">{language.t("chats.title")}</span>
        <Show when={workingCount() > 0}>
          <span
            data-slot="pill"
            data-tone="success"
            data-chat-tooltip-text={language.plural("chats.footer.active", workingCount())}
            data-chat-tooltip-placement="bottom"
          >
            <span data-slot="dot" class="animate-pulse !bg-v2-state-fg-success" />
            {workingCount()}
          </span>
        </Show>
        <Show when={waitingCount() > 0}>
          <span
            data-slot="pill"
            data-tone="warning"
            data-chat-tooltip-text={language.plural("chats.footer.waiting", waitingCount())}
            data-chat-tooltip-placement="bottom"
          >
            <span data-slot="dot" data-tone="attention" />
            {waitingCount()}
          </span>
        </Show>

        <div data-slot="actions">
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

      {/* ── Toolbar: search + view switch + view options ──────────
          The search root spans the whole toolbar so the floating results
          panel keeps the pane's full width and covers the view controls
          while a query is open. */}
      <div
        ref={(element) => {
          searchRootElement = element
          searchRuntime()?.search.element.setRoot(element)
        }}
        data-slot="toolbar"
        data-component="chats-session-search"
        class="relative z-30"
      >
        <Show when={searchRuntime()} keyed>
          {(runtime) => (
            <Show when={runtime.search.query.open()}>
              <div
                data-component="chats-session-search-panel"
                class="absolute flex flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
                style={{ top: "2px", left: "4px", width: "calc(100% - 8px)" }}
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
            </Show>
          )}
        </Show>
        <label class="relative z-20 flex h-[24px] min-w-0 flex-1 items-center gap-1.5 rounded-[6px] border border-v2-border-border-base/60 bg-v2-background-bg-layer-01 px-1.5 text-v2-icon-icon-muted shadow-[inset_0_1px_1px_var(--v2-alpha-dark-6),inset_0_0.5px_0.5px_var(--v2-alpha-dark-4)] transition-[border-color,background-color,box-shadow] duration-150 hover:border-v2-border-border-base hover:bg-v2-background-bg-layer-02 focus-within:border-v2-border-border-strong focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_2px_var(--v2-alpha-dark-8)]">
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

        <div data-slot="views" role="group" aria-label={language.t("chats.view.label")}>
          <For each={CHAT_SIDEBAR_VIEW_MODES}>
            {(view) => (
              <button
                type="button"
                data-slot="view"
                aria-pressed={props.state.view() === view}
                aria-label={viewLabel(view)}
                data-chat-tooltip-text={viewLabel(view)}
                data-chat-tooltip-placement="bottom"
                onClick={() => props.state.setView(view)}
              >
                <IconV2 name={viewIcon[view]} size="small" />
              </button>
            )}
          </For>
        </div>

        <MenuV2 placement="bottom-end" gutter={6}>
          <MenuV2.Trigger
            as="button"
            type="button"
            data-slot="tool"
            aria-label={language.t("chats.view.options")}
            data-chat-tooltip-text={language.t("chats.view.options")}
            data-chat-tooltip-placement="bottom"
          >
            <IconV2 name="outline-sliders" size="small" />
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Group>
                <MenuV2.GroupLabel>{language.t("chats.sort.label")}</MenuV2.GroupLabel>
                <MenuV2.RadioGroup
                  value={props.state.sort()}
                  onChange={(value) => props.state.setSort(value as ChatSidebarSortMode)}
                >
                  <For each={CHAT_SIDEBAR_SORT_MODES}>
                    {(sort) => <MenuV2.RadioItem value={sort}>{language.t(`chats.sort.${sort}`)}</MenuV2.RadioItem>}
                  </For>
                </MenuV2.RadioGroup>
              </MenuV2.Group>
              <MenuV2.Separator />
              <MenuV2.Group>
                <MenuV2.GroupLabel>{language.t("chats.density.label")}</MenuV2.GroupLabel>
                <MenuV2.RadioGroup
                  value={props.state.density()}
                  onChange={(value) => props.state.setDensity(value as ChatSidebarDensity)}
                >
                  <MenuV2.RadioItem value="compact">{language.t("chats.density.compact")}</MenuV2.RadioItem>
                  <MenuV2.RadioItem value="detailed">{language.t("chats.density.detailed")}</MenuV2.RadioItem>
                </MenuV2.RadioGroup>
              </MenuV2.Group>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>

      {/* ── Session tree ──────────────────────────────────────── */}
      <ScrollView data-slot="tree-scroll" class="min-h-0 flex-1" viewportRef={setTreeScrollRoot}>
        <div
          ref={(element) => {
            treeElement = element
          }}
          data-slot="tree"
          role="tree"
          aria-label={language.t("chats.title")}
          data-virtual-total={treeVirtualBlocks().length}
          data-virtual-mounted={treeVirtualRows().length}
          data-virtual-layout="fixed-slots"
          style={{ height: `${treeVirtualizer.getTotalSize()}px` }}
          onKeyDown={handleTreeKeyDown}
          onFocusIn={(event) => {
            if (!(event.target instanceof Element)) return
            const block = event.target.closest<HTMLElement>("[data-chat-sidebar-virtual-block]")
            if (block?.dataset.blockKey) setFocusedTreeKey(block.dataset.blockKey)
          }}
        >
          <For each={treeVirtualRows()}>
            {(entry) => {
              const block = entry.block
              if (!block) return null
              const virtualRow = entry.virtualRow
              const sectionOwnerKey =
                block.type === "session" ||
                block.type === "cluster-head" ||
                block.type === "cluster-member" ||
                block.type === "more" ||
                block.type === "less"
                  ? block.sectionHeadKey
                  : undefined
              const clusterOwnerKey = block.type === "cluster-member" ? block.clusterHeadKey : undefined
              const sticky = () =>
                block.type === "section-head" && activeStickyTreeBlock() === virtualRow.index
              const fixedHeight = () => sidebarFixedBlockHeight(block.type, props.state.density())
              const offset = () => {
                if (!sticky()) return virtualRow.start
                // A pinned row is still absolutely positioned in the same
                // coordinate system as every other virtual row.
                const next = stickyMarkers().find((marker) => marker.index > virtualRow.index)
                const nextStart = next ? treeVirtualizer.measurementsCache[next.index]?.start : undefined
                return sidebarStickyBlockOffset(
                  virtualRow.start,
                  virtualRow.size,
                  treeScrollOffset(),
                  nextStart,
                )
              }
              const wrap = (content: JSX.Element) => (
                <div
                  // Deterministic-height rows use the authoritative fixed
                  // slot size, not an early/zero ResizeObserver measurement.
                  // Only intrinsically sized sections require DOM measurement.
                  ref={(element) => {
                    if (fixedHeight() !== undefined) return
                    // Solid's ref runs before reactive attributes and sometimes
                    // before descendants are attached. A synchronous size read
                    // can record 0px and collapse every following row.
                    element.setAttribute("data-index", String(virtualRow.index))
                    queueMicrotask(() => {
                      if (!element.isConnected || element.dataset.index !== String(virtualRow.index)) return
                      treeVirtualizer.measureElement(element)
                    })
                  }}
                  role="none"
                  data-chat-sidebar-virtual-block
                  data-block-key={block.key}
                  data-kind={block.type}
                  data-index={virtualRow.index}
                  data-sticky={sticky() || undefined}
                  data-section-owner-key={sectionOwnerKey}
                  data-cluster-owner-key={clusterOwnerKey}
                  style={{
                    position: "absolute",
                    top: "0px",
                    height: fixedHeight() !== undefined ? `${fixedHeight()}px` : undefined,
                    overflow: fixedHeight() !== undefined ? "clip" : undefined,
                    "z-index": sticky() ? 20 : undefined,
                    transform: `translateY(${offset()}px)`,
                  }}
                >
                  {content}
                </div>
              )

              if (block.type === "oxp") {
                return wrap(
                  <ChatSidebarOxpSection
                    collapsed={props.state.isGroupCollapsed("oxp")}
                    onToggle={() => props.state.toggleGroup("oxp")}
                    selectedActivityID={params.activityID}
                    minuteNow={minuteNow}
                    onOpen={(activityID) => navigate(`/oxp/activity/${activityID}`)}
                  />,
                )
              }

              if (block.type === "empty") {
                return wrap(
                  <div data-slot="empty">
                    <IconV2 name="chats" size="small" class="size-5 text-v2-icon-icon-muted opacity-60" />
                    <span>{language.t("chats.empty")}</span>
                  </div>,
                )
              }

              if (block.type === "section-head") {
                const section = block.section.get
                return wrap(
                  <section data-slot="section" data-section={block.section.key}>
                    <SectionHead section={section} />
                  </section>,
                )
              }

              if (block.type === "session") {
                const item = block.item.get()
                if (item.type !== "session") return null
                const section = block.section.get
                const directory = () => {
                  const key = section().projectKey
                  return key ? (projectHeads().get(key)?.directory ?? "") : ""
                }
                return wrap(
                  <div data-slot="virtual-section-row">
                    {renderRow(() => {
                      const current = block.item.get()
                      return current.type === "session" ? current.session : item.session
                    }, { directory })}
                  </div>,
                )
              }

              if (block.type === "cluster-head") {
                const section = block.section.get
                const directory = () => {
                  const key = section().projectKey
                  return key ? (projectHeads().get(key)?.directory ?? "") : ""
                }
                return wrap(
                  <div data-slot="virtual-section-row">
                    <ClusterNode
                      item={block.item.get as () => ChatSidebarClusterItem}
                      directory={directory}
                      renderMembers={false}
                    />
                  </div>,
                )
              }

              if (block.type === "cluster-member") {
                const section = block.section.get
                const directory = () => {
                  const key = section().projectKey
                  return key ? (projectHeads().get(key)?.directory ?? "") : ""
                }
                const label = () => {
                  const item = block.item.get()
                  if (item.type !== "cluster") return undefined
                  const indexed = item.members[block.memberIndex]
                  if (indexed?.id === block.memberID) return item.labels[block.memberIndex]
                  const index = item.members.findIndex((member) => member.id === block.memberID)
                  return index >= 0 ? item.labels[index] : undefined
                }
                const item = block.item.get()
                const isLast =
                  item.type === "cluster" &&
                  block.memberIndex === item.members.length - 1 &&
                  item.members[block.memberIndex]?.id === block.memberID
                return wrap(
                  <div data-slot="virtual-cluster-member" data-last={isLast || undefined}>
                    {renderRow(block.member, {
                      directory,
                      label,
                      member: true,
                      inGroupId: item.type === "cluster" ? item.group.id : undefined,
                    })}
                  </div>,
                )
              }

              if (block.type === "more") {
                const section = block.section.get
                return wrap(
                  <div data-slot="virtual-section-row">
                    <button type="button" data-slot="more" onClick={() => showMoreInSection(section())}>
                      {language.plural("chats.showMoreCount", section().total - section().sessionCount)}
                    </button>
                  </div>,
                )
              }

              if (block.type === "less") {
                const section = block.section.get
                return wrap(
                  <div data-slot="virtual-section-row">
                    <button type="button" data-slot="more" onClick={() => showLessInSection(section())}>
                      {language.t("chats.showLess")}
                    </button>
                  </div>,
                )
              }

              return wrap(
                <section data-slot="section" data-component="chats-archived-group">
                  <button
                    type="button"
                    data-slot="section-head"
                    onClick={() => props.state.toggleArchived()}
                    aria-expanded={props.state.isArchivedExpanded()}
                    aria-controls="chats-group-archived"
                    aria-label={`${language.t("chats.archived.group")}, ${language.plural("chats.archived.count", archivedState.rows.length)}`}
                  >
                    <IconV2 name="chevron-down" size="small" data-slot="section-chevron" />
                    <span data-slot="section-icon">
                      <IconV2 name="archive" size="small" />
                    </span>
                    <span data-slot="section-label">{language.t("chats.archived.group")}</span>
                    <span data-slot="section-spacer" />
                    <span data-slot="section-count">{archivedState.rows.length}</span>
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
                            {() => <div class="h-[22px] rounded-[5px] bg-v2-background-bg-layer-02 animate-pulse" />}
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
                </section>,
              )
            }}
          </For>
        </div>
      </ScrollView>

      {/* ── Status bar ────────────────────────────────────────── */}
      <Show when={totalSessions() > 0}>
        <div data-slot="statusbar">
          <span data-slot="status-item">{language.plural("chats.footer.sessions", totalSessions())}</span>
          <span data-slot="status-spacer" />
          <Show when={waitingCount() > 0}>
            <span data-slot="status-item">
              <span data-slot="dot" data-tone="attention" />
              {language.plural("chats.footer.waiting", waitingCount())}
            </span>
          </Show>
          <Show when={workingCount() > 0}>
            <span data-slot="status-item">
              <span data-slot="dot" data-tone="working" />
              {language.plural("chats.footer.active", workingCount())}
            </span>
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
        <Show when={tooltipSurfaceRequested()}>
          <div
            ref={(element) => {
              sharedTooltipElement = element
              queueSharedTooltipPosition()
            }}
            id={sharedTooltipID}
            role="tooltip"
            data-component="tooltip-v2"
            data-chat-sidebar-shared-tooltip
            data-session-id={sharedTooltip()?.sessionID}
            class={sharedTooltip()?.sessionID ? "!p-0 overflow-hidden" : undefined}
            style={{
              position: "fixed",
              left: `${sharedTooltipPosition()?.x ?? 0}px`,
              top: `${sharedTooltipPosition()?.y ?? 0}px`,
              display: sharedTooltip() && sharedTooltipPosition() ? "block" : "none",
              "pointer-events": sharedTooltip()?.sessionID ? "auto" : "none",
              "z-index": 1000,
              "max-width": "calc(100vw - 30px)",
              "max-height": "calc(100vh - 30px)",
            } as JSX.CSSProperties}
            onPointerEnter={() => {
              if (!sharedTooltip()?.sessionID) return
              sharedTooltipCardHovered = true
              if (tooltipCloseGraceTimer !== undefined) {
                clearTimeout(tooltipCloseGraceTimer)
                tooltipCloseGraceTimer = undefined
              }
            }}
            onPointerLeave={() => {
              if (!sharedTooltip()?.sessionID) return
              sharedTooltipCardHovered = false
              requestAnimationFrame(() => {
                if (sharedTooltipCardHovered || sharedTooltipCardContextMenuOpen()) return
                if (sharedTooltip()?.anchor?.matches(":hover")) return
                closeSharedTooltip()
              })
            }}
          >
            {/* Only one rich card instance in the entire sidebar lifetime.
                It is lazy-created on the first session hover, then reused for
                every other session without recreating its virtualizer. */}
            <Show when={richPreviewRequested()}>
              <div style={{ display: sharedTooltip()?.sessionID ? "block" : "none" }}>
                <Suspense fallback={null}>
                  <SessionPreviewCard
                    data={sharedTooltipData() ?? {}}
                    relationships={sharedTooltipRelationships}
                    currentSessionID={sharedTooltip()?.sessionID}
                    previewKey={sharedTooltip()?.sessionID}
                    server={paneServerKey()}
                    serverCtx={paneServerCtx}
                    active={() => !!sharedTooltip()?.sessionID}
                    onOpenSession={() => closeSharedTooltip()}
                    onRowContextMenuOpenChange={setSharedTooltipCardContextMenuOpen}
                    maxHeight={sharedTooltipMaxHeight}
                  />
                </Suspense>
              </div>
            </Show>
            <Show when={!!sharedTooltip() && !sharedTooltip()?.sessionID}>
              {sharedTooltipText()}
            </Show>
          </div>
        </Show>
      </Portal>
    </div>
  )
}

function ChatRow(props: {
  session: Session
  /** Display label override — folded group members drop the shared group prefix. */
  label?: string
  density: ChatSidebarDensity
  /** Cheap O(1) related-session count from the compact SessionGroup
   * membership index (subagents/delegations/plugin/manual/Swarm) — the
   * topology itself is only expandable through the rich Session preview. */
  relatedCount?: number
  /** First SessionGroup this root belongs to, if any — powers the context
   * menu's "remove from group" affordance (unrelated to relatedCount). */
  inGroupId?: string
  animateWorkingIndicator?: boolean
  indicatorBudget: ReturnType<typeof createChatSidebarIndicatorBudget>
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
  const tabs = useTabs()
  const runtime = lease.runtime
  onCleanup(lease.release)
  // A session metadata refresh changes the row's immutable projection without
  // changing identity. Keep the shared runtime fallback current in place.
  createEffect(() => lease.update(props.session))

  const title = () => props.label ?? sessionTitle(props.session.title)
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
  const compact = () => props.density === "compact"
  const [rowVisible, setRowVisible] = createSignal(false)
  // Timer text is useful only while a row is on screen. Keep hidden rows out of
  // the shared 1 Hz clock's reactive subscriber set; they recompute immediately
  // when IntersectionObserver reports them visible again.
  // A memo so the several liveReadout reads share one telemetryLive() evaluation
  // per tick; hidden rows depend only on rowVisible and never touch the clock.
  const rowLive = createMemo(() => (rowVisible() ? live() : undefined))
  // Pulse is rationed pane-wide (see createChatSidebarIndicatorBudget); rows that
  // do not win a slot render the same dot statically.
  const [pulseGranted, setPulseGranted] = createSignal(false)
  const wantsPulse = createMemo(
    () => props.animateWorkingIndicator === true && rowVisible() && isWorking() && !props.pending,
  )
  createEffect(() => {
    if (!wantsPulse()) return
    const release = props.indicatorBudget.acquire(setPulseGranted)
    onCleanup(() => {
      release()
      setPulseGranted(false)
    })
  })
  let stopObserving: (() => void) | undefined
  onCleanup(() => stopObserving?.())

  const dotTone = () =>
    hasError() ? "error" : needsAttention() ? "attention" : unseenCount() > 0 ? "unread" : "idle"

  const warm = () => props.prefetchSession()
  const serverKey = runtime.serverKey
  // Navigate through the same canonical server-scoped tab controller as Home.
  const linkHref = () => {
    const server = serverKey()
    return server ? sessionHref(server, props.session.id) : "#"
  }
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number }>()
  const handleOpen = (opts?: { background?: boolean }) => {
    const server = serverKey()
    if (!server || !props.session.id) return
    const tab = tabs.addSessionTab({ server, sessionId: props.session.id })
    if (opts?.background) return
    props.onPending?.(props.session.id)
    tabs.select(tab)
  }

  // Live phase readout. Plain expression children compile to tracked getters,
  // so only text nodes update on each 1 Hz tick; the Switch swaps between
  // waiting / generating / tools / thinking states instead of showing 0s.
  const liveReadout = () => (
    <Switch>
      <Match when={hasPermissions() || hasQuestions()}>
        <span data-slot="live" data-tone="warning">
          <IconV2 name="hourglass" size="small" />
          <strong>{language.t("chats.timer.waiting")}</strong>
          <Show when={!compact() && (rowLive()?.turnSeconds ?? 0) > 1}>
            <span>{formatDuration(rowLive()!.turnSeconds)}</span>
          </Show>
        </span>
      </Match>
      <Match when={(rowLive()?.rate ?? null) !== null}>
        <span data-slot="live" data-tone="accent">
          <span>{language.t("chats.metric.rate", { rate: rowLive()?.rate?.toFixed(0) ?? "0" })}</span>
          <strong>{formatDuration(rowLive()?.turnSeconds ?? 0)}</strong>
        </span>
      </Match>
      <Match when={(rowLive()?.turnSeconds ?? 0) > 1}>
        <span data-slot="live">
          <IconV2 name="layers" size="small" />
          <Show when={!compact()}>
            <span>{language.t("chats.timer.tools")}</span>
          </Show>
          <strong>{formatDuration(rowLive()!.turnSeconds)}</strong>
        </span>
      </Match>
      <Match when={true}>
        <span data-slot="live" data-tone="faint">
          <IconV2 name="hourglass" size="small" />
          <span>{language.t("chats.timer.thinking")}</span>
        </span>
      </Match>
    </Switch>
  )

  return (
    <>
      <div
        ref={(element) => {
          stopObserving?.()
          stopObserving = props.observeVisibility(element, setRowVisible)
        }}
        data-slot="row"
        data-density={props.density}
        data-selected={props.selected ? "" : undefined}
        data-chat-tooltip-session={props.session.id}
        data-chat-tooltip-placement="right"
        role="treeitem"
        onContextMenu={(event) => {
          event.preventDefault()
          setContextMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <A
          href={linkHref()}
          data-slot="row-link"
          data-tree-item
          data-selected={props.selected ? "" : undefined}
          aria-current={props.selected ? "page" : undefined}
          onPointerDown={warm}
          onFocus={warm}
          onClick={(event: MouseEvent) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button === 1) return
            event.preventDefault()
            handleOpen()
          }}
        >
          {/* Line 1 — status, title, attention, trailing time/actions */}
          <span data-slot="row-line">
            <span data-slot="row-status">
              <Show
                when={props.pending}
                fallback={
                  <Show when={isWorking()} fallback={<span data-slot="dot" data-tone={dotTone()} />}>
                    <DenseWorkingIndicator
                      class="text-v2-icon-icon-base"
                      animated={chatSidebarWorkingIndicatorAnimated(
                        props.animateWorkingIndicator === true,
                        true,
                        pulseGranted(),
                      )}
                    />
                  </Show>
                }
              >
                <LoaderV2 class="size-3" aria-hidden="true" />
              </Show>
            </span>

            <span data-slot="row-title">{title()}</span>

            <Show when={(props.relatedCount ?? 0) > 1}>
              <span
                data-slot="badge"
                data-chat-tooltip-text={language.plural(
                  "sessionGroup.sessions",
                  Math.max((props.relatedCount ?? 1) - 1, 0),
                )}
                data-chat-tooltip-placement="top"
              >
                <IconV2 name="branch" size="small" />
                {Math.max((props.relatedCount ?? 1) - 1, 0)}
              </span>
            </Show>
            <Show when={hasPermissions()}>
              <span
                data-slot="badge"
                data-tone="warning"
                data-chat-tooltip-text={language.t("chats.badge.permission")}
                data-chat-tooltip-placement="top"
              >
                <IconV2 name="shield" size="small" />
                {pendingPermissionCount()}
              </span>
            </Show>
            <Show when={hasQuestions()}>
              <span
                data-slot="badge"
                data-tone="info"
                data-chat-tooltip-text={language.t("chats.badge.question")}
                data-chat-tooltip-placement="top"
              >
                <IconV2 name="help" size="small" />
                {pendingQuestionCount()}
              </span>
            </Show>

            <span data-slot="row-trail">
              <Show
                when={compact() && isWorking()}
                fallback={
                  <>
                    <span data-slot="row-time">{relativeLabel(props.session, props.minuteNow())}</span>
                    <button
                      type="button"
                      data-slot="row-archive"
                      aria-label={language.t("common.archive")}
                      data-chat-tooltip-text={language.t("common.archive")}
                      data-chat-tooltip-placement="top"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void props.archiveSession()
                      }}
                    >
                      <IconV2 name="archive" size="small" class="size-3" />
                    </button>
                  </>
                }
              >
                {liveReadout()}
              </Show>
            </span>
          </span>

          {/* Line 2 (detailed density) — metrics left, live/accumulated timer right */}
          <Show when={!compact()}>
            <span data-slot="row-meta">
              <span data-slot="row-metrics">
                <Show when={contextPercent() !== null}>
                  <span
                    data-slot="metric"
                    data-tone={contextTone(contextPercent()!)}
                    data-chat-tooltip-text={language.t("chats.metric.context")}
                    data-chat-tooltip-placement="top"
                  >
                    <span data-slot="meter" data-tone={contextTone(contextPercent()!)}>
                      <span style={{ width: `${Math.min(100, Math.max(2, contextPercent()!))}%` }} />
                    </span>
                    {contextPercent()}%
                  </span>
                </Show>
                <Show when={(totals()?.cost ?? 0) > 0}>
                  <span data-slot="metric">{formatCost(totals()!.cost)}</span>
                </Show>
                <Show when={totals()?.cacheHitPercent !== null && totals()?.cacheHitPercent !== undefined}>
                  <span
                    data-slot="metric"
                    data-chat-tooltip-text={language.t("context.tooltip.cacheHit")}
                    data-chat-tooltip-placement="top"
                  >
                    <IconV2 name="cache" size="small" />
                    {totals()!.cacheHitPercent}%
                  </span>
                </Show>
                <Show when={modelInfo()}>
                  {(info) => (
                    <span data-slot="metric" data-grow>
                      {modelLabel()}
                      <Show when={info().variant}>{(variant) => ` · ${variant()}`}</Show>
                    </span>
                  )}
                </Show>
                <Show when={isAutoAccepting()}>
                  <span
                    data-slot="metric"
                    data-tone="info"
                    data-chat-tooltip-text={language.t("chats.badge.autoAccept")}
                    data-chat-tooltip-placement="top"
                  >
                    <IconV2 name="shield-check" size="small" />
                  </span>
                </Show>
              </span>

              <Show
                when={isWorking()}
                fallback={
                  <Show when={(totals()?.generatedSeconds ?? 0) + (totals()?.toolSeconds ?? 0) > 1}>
                    <span
                      data-slot="metric"
                      data-chat-tooltip-text={language.t("chats.timer.accumulated")}
                      data-chat-tooltip-placement="top"
                    >
                      {formatDuration((totals()!.generatedSeconds ?? 0) + (totals()!.toolSeconds ?? 0))}
                    </span>
                  </Show>
                }
              >
                {liveReadout()}
              </Show>
            </span>
          </Show>
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
