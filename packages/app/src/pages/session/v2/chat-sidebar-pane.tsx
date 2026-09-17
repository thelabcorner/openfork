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
import { Spinner } from "@opencode-ai/ui/spinner"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getProjectAvatarVariant, useLayout, type LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useSessionGroups } from "@/context/session-groups"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { startupMark, startupTransportDiagnostic } from "@/utils/startup-perf"

startupMark("sidebar.module-evaluated")
import { buildChatSidebarSessionTreeRows } from "./chat-sidebar-session-tree"
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
  chatSidebarRootSessionVisible,
  type ChatSidebarPaneState,
} from "./chat-sidebar-pane-state"
import { CHAT_PROJECT_NAME } from "@opencode-ai/core/project/chat"
import { findChatProject, isChatProjectAlias, isReservedChatProjectPath } from "@/utils/chat-project"
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
function telemetryLive(value: SessionTelemetryInfo | undefined, now: number): ChatRowLive | undefined {
  if (!value || value.phase === "idle") return undefined
  const step = value.step
  const openMs = value.phaseStartedAt === undefined ? 0 : Math.max(0, now - value.phaseStartedAt)
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
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const platform = usePlatform()
  const notification = useNotification()
  const permission = usePermission()
  const sessionGroups = useSessionGroups()

  // One shared ticker for every live timer in the pane — per-row intervals
  // would multiply timers by the number of visible sessions.
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))

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

  const isExpanded = (key: string) => !props.state.isGroupCollapsed(key)
  const toggleExpanded = (key: string) => props.state.toggleGroup(key)

  // Deliberately non-reactive: entries are assigned the first time a session is
  // observed working and deleted when it goes idle, so pinned rows keep their
  // relative arrival order for the whole generation instead of reshuffling.
  const workingArrival = new Map<string, number>()
  let arrivalSeq = 0

  // Reads the global session store directly: the dir-context proxy routes
  // session_working to this exact store regardless of directory
  // (context/directory-sync.ts), so routing through ensureDirSyncContext here
  // only added refcount churn per row per recompute — plus a dispose-thrash
  // hazard when this pane was the context's sole holder.
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
  const directorySlices = new Map<string, Accessor<Session[]>>()
  const projectSlices = new Map<string, Accessor<Session[]>>()
  const directorySlice = (dir: string, projectID?: string) => {
    const key = `${pathKey(dir)}\u0000${projectID ?? ""}`
    const cached = directorySlices.get(key)
    if (cached) return cached
    const created = runWithOwner(paneOwner, () =>
      createMemo(() => {
        const sessions = (serverSync().child(dir, { bootstrap: false })[0].session ?? []).map((session) =>
          withDirectory(session, dir),
        )
        return projectID
          ? sessions.filter((session) => chatSidebarRootSessionVisible(session, dir, projectID)).sort(compareSessionTime)
          : sortedRootSessions({ session: sessions, path: { directory: dir } }, 0)
      }),
    )!
    directorySlices.set(key, created)
    return created
  }
  const projectSlice = (project: LocalProject) => {
    const key = [
      pathKey(project.worktree),
      project.id ?? "",
      ...(project.sandboxes ?? []).map((sandbox) => pathKey(sandbox)),
    ].join("\u0000")
    const cached = projectSlices.get(key)
    if (cached) return cached
    const created = runWithOwner(paneOwner, () =>
      createMemo(() => {
        const rows = [
          ...directorySlice(project.worktree, project.id)(),
          ...(project.sandboxes ?? []).flatMap((sandbox) => directorySlice(sandbox)()),
        ]
        return rows.sort(compareSessionTime)
      }),
    )!
    projectSlices.set(key, created)
    return created
  }
  onCleanup(() => {
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
    const recentPool: Session[] = []
    const projectRows = new Map<string, Session[]>()
    for (const project of projects) {
      const rows = projectSlice(project)()
      recentPool.push(...rows)
      projectRows.set(project.worktree, rows)
    }
    const recent = [...recentPool].sort(compareSessionTime)
    if (recent.length > 0) {
      startupMark("sidebar.first-rows", { rows: recent.length, projects: projects.length })
      startupTransportDiagnostic("sidebar.first-rows.transport")
    }
    const projectByID = new Map(projects.flatMap((project) => (project.id ? [[project.id, project] as const] : [])))
    return { projects, projectByID, recentPool: recent, projectRows }
  })

  const visibleRootIDs = createMemo(() => new Set(baseGroups().recentPool.map((session) => session.id)))
  const visibleStructuralGroups = createMemo(() => {
    const roots = visibleRootIDs()
    return sessionGroups
      .list()
      .filter(
        (group) =>
          (group.kind === "subagent" || group.kind === "plugin") &&
          !!group.anchorSessionID &&
          roots.has(group.anchorSessionID),
      )
  })

  // Modern group-detail responses include a lightweight session projection, so
  // structural children can render without turning a tiny navigation row into a
  // full per-directory instance bootstrap. Keep the old resolve path only as a
  // compatibility fallback for older servers whose group members lack that
  // projection.
  const treeInfoPending = new Set<string>()
  const treeInfoFailedAt = new Map<string, number>()
  createEffect(() => {
    for (const group of visibleStructuralGroups()) {
      for (const member of group.sessions) {
        if (member.slug && member.projectID && member.directory && member.version && member.time) continue
        if (serverSync().session.peek(member.id) || treeInfoPending.has(member.id)) continue
        const failedAt = treeInfoFailedAt.get(member.id)
        if (failedAt !== undefined && Date.now() - failedAt < 30_000) continue
        treeInfoPending.add(member.id)
        void serverSync().session.resolve(member.id, { priority: "background" })
          .then(
            () => treeInfoFailedAt.delete(member.id),
            () => treeInfoFailedAt.set(member.id, Date.now()),
          )
          .finally(() => treeInfoPending.delete(member.id))
      }
    }
  })

  // Stage 2 — pinning + assembly. The only stage that reads working state, so
  // a flip storm re-runs just this (~pin cost) while stage 1's sorts stay
  // cached; stableGroups below then finds nothing visibly changed and keeps
  // every row component alive.
  const groups = createMemo<ChatSessionGroup[]>(() => {
    const { projects, projectByID, recentPool, projectRows } = baseGroups()
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

  // Bootstrap compact metrics once for every session this pane can render.
  // Duplicates across Recent/project/tree groups collapse in the server-scoped
  // telemetry cache and its request batcher.
  createEffect(() => {
    const ids = new Set<string>()
    for (const group of stableGroups()) for (const session of group.sessions) ids.add(session.id)
    for (const group of visibleStructuralGroups()) for (const member of group.sessions) ids.add(member.id)
    serverSync().telemetry.ensure(ids)
  })

  const sessionTreeRows = (rows: Session[]) =>
    buildChatSidebarSessionTreeRows({
      roots: rows,
      groups: sessionGroups.list(),
      sessionByID: (sessionID) => serverSync().session.peek(sessionID),
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
  const params = useParams<{ serverKey?: string; dir?: string; id?: string; sessionId?: string }>()
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
  let revealedFor: string | undefined
  createEffect(() => {
    const id = params.id
    if (!id || revealedFor === id) return
    const current = stableGroups()
    const memberships = sessionGroups.list().filter((group) => group.sessionIds.includes(id))
    const membership = memberships.find((group) => !!group.anchorSessionID) ?? memberships[0]
    const anchorID = membership?.anchorSessionID
    const target =
      current.find((group) => group.sessions.some((session) => session.id === id || session.id === anchorID))?.key ??
      current.find((group) => group.directory && base64Encode(group.directory) === params.dir)?.key
    if (!target) return
    revealedFor = id
    props.state.revealGroup(target)
    if (anchorID) props.state.revealGroup(`session-tree:${anchorID}`)
    else if (membership) props.state.revealGroup(`session-group:${membership.id}`)
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
    error: false,
    rows: [] as Session[],
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

  const fetchArchived = async () => {
    const dirs = archivedDirectories()
    if (dirs.length === 0) return
    const seq = ++archivedFetchSeq
    // Stale-while-revalidate: keep cached rows visible on refetch, only show
    // the skeleton when there is nothing to paint yet.
    setArchivedState({ loading: archivedState.rows.length === 0, error: false })
    try {
      const results = await Promise.all(
        dirs.map(async (directory) => {
          // The archived filter lives on the experimental session list
          // (/experimental/session); the plain client.session.list has no
          // archived param.
          const result = await serverSDK().client?.experimental?.session?.list?.({ directory, archived: true })
          return { directory, rows: result?.data ?? [] }
        }),
      )
      if (seq !== archivedFetchSeq) return
      // The server's archived:true only DROPS the "not archived" filter — it
      // still returns active sessions — and spans child sessions, so keep just
      // archived roots here.
      const seen = new Set<string>()
      const rows = results
        .flatMap((entry) => entry.rows)
        .filter((session) => !!session.id && session.time?.archived != null && !session.parentID)
        .filter((session) => !seen.has(session.id) && seen.add(session.id))
        .sort(compareSessionTime)
      setArchivedState({ rows, loading: false, error: false })
    } catch {
      if (seq !== archivedFetchSeq) return
      setArchivedState({ loading: false, error: true })
    }
  }

  // Refetch on every expansion (freshness) while cached rows keep the group
  // responsive; also covers a persisted-expanded group on pane mount.
  createEffect(() => {
    if (!props.state.isArchivedExpanded()) return
    void fetchArchived()
  })

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
        return telemetryLive(telemetry(), now())
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
    const current = sharedTooltip()
    if (anchor && current?.anchor !== anchor) return
    if (!current) return
    clearTooltipDescription()
    stopTooltipTextObserver()
    setSharedTooltip(undefined)
    setSharedTooltipPosition(undefined)
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
    let x = rect.left + (rect.width - width) / 2
    let y = rect.top - height - gutter

    if (intent.placement === "right") {
      x = rect.right + gutter
      y = rect.top
      if (x + width > window.innerWidth - margin) x = rect.left - width - gutter
    } else if (intent.placement === "bottom") {
      y = rect.bottom + gutter
      if (y + height > window.innerHeight - margin) y = rect.top - height - gutter
    } else if (y < margin) {
      y = rect.bottom + gutter
    }

    x = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin))
    y = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - height - margin))
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
    const anchor = target.closest<HTMLElement>("[data-chat-tooltip-text],[data-chat-tooltip-session]")
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
    closeSharedTooltip(previous)
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
  const sharedTooltipBranch = () => {
    const session = sharedTooltipSession() as (Session & { branch?: string; vcsBranch?: string }) | undefined
    return session?.branch ?? session?.vcsBranch ?? "main"
  }

  createEffect(() => {
    void sharedTooltip()
    queueSharedTooltipPosition()
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

                  <Show when={isExpanded(group.key)}>
                    <nav id={`chats-group-${index()}`} class="flex flex-col gap-px px-1 pb-1.5 pt-0.5">
                      <For each={sessionTreeRows(group.sessions)}>
                        {(item) => {
                          const session = () => item.session
                          const groupEntry = () => item.group
                          const collapseKey = () => item.treeKey ?? (groupEntry() ? `session-group:${groupEntry()!.id}` : "")
                          const isStructuralTree = () => !!item.treeKey
                          const isStructuralAnchor = () => !!item.first && isStructuralTree()
                          const working = () => !!groupEntry()?.sessions.some((member) => isWorking(member))
                          const locked = () => !!groupEntry()?.sessions.some((member) => member.locked)
                          const visibleCount = () => item.visibleCount ?? groupEntry()?.sessions.length ?? 0
                          return (
                            <>
                              {/* Anchored subagent/plugin groups are structural
                                  lineage, not a second folder above the parent. Their
                                  anchor row owns disclosure directly. This
                                  removes the duplicate "group title → same
                                  session title" layer and leaves the useful
                                  parent → indented-child hierarchy intact. */}
                              <Show when={item.first && !isStructuralTree() ? groupEntry() : undefined} keyed>
                                {(entry) => (
                                  <button
                                    type="button"
                                    class="group/session-collection flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-start text-[10px] text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-01 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-base"
                                    aria-expanded={isExpanded(collapseKey())}
                                    aria-label={`${entry.name}, ${visibleCount()} sessions`}
                                    onClick={() => toggleExpanded(collapseKey())}
                                  >
                                    <IconV2
                                      name="chevron-down"
                                      size="small"
                                      aria-hidden="true"
                                      class={`size-3 shrink-0 text-v2-icon-icon-muted transition-transform duration-150 ${isExpanded(collapseKey()) ? "" : "-rotate-90"}`}
                                    />
                                    <IconV2 name="layers" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted opacity-70" />
                                    <span class="min-w-0 flex-1 truncate font-[560] text-v2-text-text-muted transition-colors group-hover/session-collection:text-v2-text-text-base">
                                      {entry.name}
                                    </span>
                                    <Show when={working()}>
                                      <span
                                        class="flex size-3 shrink-0 items-center justify-center"
                                        aria-label={language.t("sessionGroup.working")}
                                      >
                                        <span class="size-1.5 animate-pulse rounded-full bg-v2-state-fg-success" />
                                      </span>
                                    </Show>
                                    <Show when={locked()}>
                                      <span
                                        class="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-v2-background-bg-layer-02 text-v2-icon-icon-muted"
                                        aria-label={language.t("sessionGroup.locked")}
                                      >
                                        <IconV2 name="shield" size="small" class="size-2.5" />
                                      </span>
                                    </Show>
                                    <span class="shrink-0 tabular-nums text-v2-text-text-faint">
                                      {visibleCount()}
                                    </span>
                                  </button>
                                )}
                              </Show>
                              <Show
                                when={
                                  !groupEntry() ||
                                  (isStructuralTree()
                                    ? isStructuralAnchor() || isExpanded(collapseKey())
                                    : isExpanded(collapseKey()))
                                }
                              >
                                <ChatRow
                                  session={session()}
                                  directory={group.directory}
                                  inGroupId={groupEntry()?.id}
                                  depth={item.depth}
                                  treeExpanded={isStructuralAnchor() ? isExpanded(collapseKey()) : undefined}
                                  treeCount={isStructuralAnchor() ? visibleCount() : undefined}
                                  onToggleTree={
                                    isStructuralAnchor()
                                      ? () => toggleExpanded(collapseKey())
                                      : undefined
                                  }
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
                                  onNewSessionInProject={() =>
                                    navigateToNewSession(session().directory || group.directory)
                                  }
                                  onOpenProjectInExplorer={() => {
                                    const directory = session().directory || group.directory
                                    if (directory) void platform.revealPath?.(directory)
                                  }}
                                  onCopyProjectPath={() => {
                                    const directory = session().directory || group.directory
                                    if (directory) void navigator.clipboard.writeText(directory)
                                  }}
                                  onForkConversation={() => {
                                    void import("@/components/dialog-fork").then(({ DialogFork }) =>
                                      dialog.show(() => <DialogFork sessionID={session().id} />),
                                    )
                                  }}
                                />
                              </Show>
                            </>
                          )
                        }}
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
                            void serverSync().project.loadSessions(group.directory)
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
                limit={props.state.archivedLimit()}
                minuteNow={minuteNow}
                activeSessionId={activeSessionId() ?? undefined}
                pendingSessionId={pendingSessionId() ?? undefined}
                onPending={(id) => {
                  if (params.id !== id) setPendingSessionId(id)
                }}
                onRetry={() => void fetchArchived()}
                onUnarchive={unarchiveSession}
                onShowMore={props.state.showMoreArchived}
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
                  class={
                    intent().sessionID
                      ? "!p-0 overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 shadow-[var(--v2-elevation-floating)]"
                      : undefined
                  }
                  style={
                    {
                      position: "fixed",
                      left: `${position().x}px`,
                      top: `${position().y}px`,
                      "pointer-events": "none",
                      "z-index": 1000,
                      "max-width": "calc(100vw - 30px)",
                      "max-height": "calc(100vh - 30px)",
                    } as JSX.CSSProperties
                  }
                >
                  <Show when={intent().sessionID && sharedTooltipRuntime()} fallback={sharedTooltipText()}>
                    <Show when={sharedTooltipRuntime()}>
                      {(runtime) => {
                        const session = () => runtime().session()
                        const currentDir = () => runtime().currentDir()
                        const totals = runtime().totals
                        const contextPercent = runtime().contextPercent
                        const modelInfo = runtime().modelInfo
                        const modelLabel = runtime().modelLabel
                        const isAutoAccepting = runtime().isAutoAccepting
                        return (
                          <div class="flex w-[260px] flex-col gap-2.5 px-3 py-2.5">
                            <div class="flex min-w-0 items-center gap-2">
                              <span class="flex size-5 shrink-0 items-center justify-center rounded-md bg-v2-background-bg-layer-02 text-[10px] font-[700] leading-none text-v2-text-text-muted">
                                {(sharedTooltipProjectName()[0] ?? "•").toUpperCase()}
                              </span>
                              <span class="min-w-0 flex-1 truncate text-[12px] font-[600] leading-4 tracking-[-0.01em] text-v2-text-text-base">
                                {sessionTitle(session().title) || sharedTooltipProjectName()}
                              </span>
                              <span class="shrink-0 text-[11px] leading-none tabular-nums text-v2-text-text-faint">
                                {relativeLabel(session(), minuteNow())}
                              </span>
                            </div>
                            <div class="h-px bg-v2-border-border-muted" />
                            <div class="flex flex-col gap-1.5">
                              <div class="flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
                                <IconV2 name="folder" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
                                <span class="min-w-0 flex-1 truncate text-v2-text-text-muted">
                                  {sharedTooltipProjectName()}
                                </span>
                                <span class="shrink-0 truncate text-[11px] text-v2-text-text-faint">
                                  {currentDir() ? currentDir().replace(/\\/g, "/").split("/").slice(-2).join("/") : ""}
                                </span>
                              </div>
                              <div class="flex items-center gap-1.5 text-[11px] leading-4">
                                <IconV2 name="branch" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
                                <span class="text-v2-text-text-muted">{sharedTooltipBranch()}</span>
                                <Show when={modelInfo()}>
                                  {(info) => (
                                    <span class="ml-auto flex min-w-0 items-center gap-1 truncate text-v2-text-text-faint">
                                      <IconV2 name="cache" size="small" class="size-2.5 shrink-0 opacity-60" />
                                      <span class="truncate">{modelLabel()}</span>
                                      <Show when={info().variant}>{(variant) => <span class="shrink-0">· {variant()}</span>}</Show>
                                    </span>
                                  )}
                                </Show>
                              </div>
                            </div>
                            <Show
                              when={
                                totals() &&
                                ((totals()!.cost ?? 0) > 0 ||
                                  contextPercent() !== null ||
                                  totals()!.cacheHitPercent !== null)
                              }
                            >
                              <div class="h-px bg-v2-border-border-muted" />
                              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-none tabular-nums">
                                <Show when={(totals()?.cost ?? 0) > 0}>
                                  <span class="text-v2-text-text-base">{formatCost(totals()!.cost)}</span>
                                </Show>
                                <Show when={contextPercent() !== null}>
                                  <span class="flex items-center gap-1 text-v2-text-text-muted">
                                    <span class="h-[3px] w-8 overflow-hidden rounded-full bg-v2-background-bg-layer-03">
                                      <span
                                        class={`block h-full rounded-full ${contextTone(contextPercent()!).bar}`}
                                        style={{ width: `${Math.min(100, Math.max(2, contextPercent()!))}%` }}
                                      />
                                    </span>
                                    {contextPercent()}%
                                  </span>
                                </Show>
                                <Show when={totals()?.cacheHitPercent !== null}>
                                  <span class="flex items-center gap-1 text-v2-text-text-faint">
                                    <IconV2 name="cache" size="small" class="size-3 opacity-60" />
                                    {totals()!.cacheHitPercent}%
                                  </span>
                                </Show>
                                <Show when={isAutoAccepting()}>
                                  <span class="ml-auto flex items-center gap-1 rounded-[3.5px] bg-v2-state-bg-info px-1 py-0.5 text-[9px] font-[600] leading-none text-v2-state-fg-info">
                                    <IconV2 name="shield-check" size="small" class="size-2.5" />
                                    Auto
                                  </span>
                                </Show>
                              </div>
                            </Show>
                          </div>
                        )
                      }}
                    </Show>
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
  inGroupId?: string
  depth?: number
  treeExpanded?: boolean
  treeCount?: number
  onToggleTree?: () => void
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
  const hasTreeDisclosure = createMemo(() => props.treeExpanded !== undefined && !!props.onToggleTree)

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
          data-chat-tooltip-session={props.session.id}
          data-chat-tooltip-placement="right"
          class="group/session relative w-full min-w-0 rounded-[5px] transition-[background-color,box-shadow] duration-100 hover:bg-v2-background-bg-layer-01 focus-within:bg-v2-background-bg-layer-01 has-[.active]:bg-v2-background-bg-layer-02 has-[.active]:shadow-[inset_0_0_0_0.5px_var(--v2-alpha-dark-8)] has-[data-selected]:bg-v2-background-bg-layer-02 has-[data-selected]:shadow-[inset_0_0_0_0.5px_var(--v2-alpha-dark-8)] [[data-model-picker-open]_&]:bg-v2-background-bg-layer-01"
          style={{ "margin-inline-start": `${Math.min(Math.max(props.depth ?? 0, 0), 8) * 14}px` }}
          onContextMenu={(event) => {
            event.preventDefault()
            setContextMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <Show when={(props.depth ?? 0) > 0}>
            <span
              aria-hidden="true"
              class="pointer-events-none absolute inset-y-0 w-px bg-v2-border-border-muted opacity-60"
              style={{ "inset-inline-start": "-6px" }}
            />
            <span
              aria-hidden="true"
              class="pointer-events-none absolute top-[15px] h-px w-[6px] bg-v2-border-border-muted opacity-60"
              style={{ "inset-inline-start": "-6px" }}
            />
          </Show>
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
                <Show when={hasTreeDisclosure()} fallback={
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
                        <Spinner class="size-3 text-v2-icon-icon-base" />
                      </Show>
                    }
                  >
                    <LoaderV2 class="size-3" aria-hidden="true" />
                  </Show>
                }>
                  <button
                    type="button"
                    class="flex size-4 -m-0.5 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-colors hover:bg-v2-background-bg-layer-03 hover:text-v2-icon-icon-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-base"
                    aria-expanded={props.treeExpanded}
                    aria-label={props.treeExpanded ? language.t("home.server.collapse") : language.t("home.server.expand")}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      props.onToggleTree?.()
                    }}
                  >
                    <IconV2
                      name="chevron-down"
                      size="small"
                      class={`size-3 transition-transform duration-150 ${props.treeExpanded ? "" : "-rotate-90"}`}
                    />
                  </button>
                </Show>
              </span>

              <span class="min-w-0 flex-1 truncate text-[11.5px] font-[460] leading-[15px] tracking-[-0.01em] group-has-[data-selected]/session:font-[560]">{title()}</span>

              <Show when={hasTreeDisclosure() && (props.treeCount ?? 0) > 1}>
                <span
                  aria-label={language.plural("sessionGroup.sessions", Math.max((props.treeCount ?? 1) - 1, 0))}
                  class="flex shrink-0 items-center gap-0.5 rounded-[4px] bg-v2-background-bg-layer-02 px-1 py-[1px] text-[9px] font-[520] leading-none tabular-nums text-v2-text-text-faint"
                >
                  <IconV2 name="branch" size="small" class="size-2.5 opacity-70" />
                  {Math.max((props.treeCount ?? 1) - 1, 0)}
                </span>
              </Show>

              <Show when={hasTreeDisclosure() && (props.pending || isWorking() || needsAttention() || hasError() || unseenCount() > 0)}>
                <span class="flex size-2.5 shrink-0 items-center justify-center" aria-hidden="true">
                  <Show
                    when={props.pending}
                    fallback={
                      <Show
                        when={isWorking()}
                        fallback={
                          <span
                            class={`size-1.5 rounded-full ${
                              hasError()
                                ? "bg-v2-state-fg-danger"
                                : needsAttention()
                                  ? "bg-v2-state-fg-warning"
                                  : "bg-v2-background-bg-accent"
                            }`}
                          />
                        }
                      >
                        <Spinner class="size-2.5 text-v2-icon-icon-base" />
                      </Show>
                    }
                  >
                    <LoaderV2 class="size-2.5" />
                  </Show>
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
                  data-chat-tooltip-text={`${language.t("chats.timer.accumulated")} · ${formatDuration(live()?.accumulatedSeconds ?? 0)}`}
                  data-chat-tooltip-placement="top"
                  class="flex shrink-0"
                >
                  <Switch>
                    <Match when={hasPermissions() || hasQuestions()}>
                      <span class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums text-v2-state-fg-warning">
                        <IconV2 name="hourglass" size="small" class="size-3 animate-pulse" />
                        <span class="font-[560]">{language.t("chats.timer.waiting")}</span>
                        <Show when={(live()?.turnSeconds ?? 0) > 1}>
                          <span class="font-[560] opacity-70">{formatDuration(live()!.turnSeconds)}</span>
                        </Show>
                      </span>
                    </Match>
                    <Match when={(live()?.rate ?? null) !== null}>
                      <span class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums">
                        <span class="text-v2-text-text-accent opacity-80">
                          {language.t("chats.metric.rate", { rate: live()?.rate?.toFixed(0) ?? "0" })}
                        </span>
                        <span class="font-[560] text-v2-text-text-accent">
                          {formatDuration(live()?.turnSeconds ?? 0)}
                        </span>
                      </span>
                    </Match>
                    <Match when={(live()?.turnSeconds ?? 0) > 1}>
                      <span class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums text-v2-text-text-muted">
                        <IconV2 name="layers" size="small" class="size-2.5 opacity-70" />
                        <span>{language.t("chats.timer.tools")}</span>
                        <span class="opacity-40">·</span>
                        <span class="font-[560] opacity-80">{formatDuration(live()!.turnSeconds)}</span>
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
