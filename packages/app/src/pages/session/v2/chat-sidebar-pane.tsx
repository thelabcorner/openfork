import {
  createEffect,
  createMemo,
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
import { A, useIsRouting, useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
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
import { useProviders } from "@/hooks/use-providers"
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
  shouldAutoHydrateChatSidebarMetrics,
  type ChatSidebarPaneState,
} from "./chat-sidebar-pane-state"
import { CHAT_PROJECT_NAME } from "@opencode-ai/core/project/chat"
import { findChatProject, isChatProjectAlias, isReservedChatProjectPath } from "@/utils/chat-project"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2/client"

type ProviderList = ReturnType<ReturnType<typeof useProviders>["all"]> extends Map<string, infer P> ? P[] : never

type ChatSidebarMetricsRuntime = {
  aggregateSessionContextByModel: typeof import("@/components/session/session-context-model-metrics")["aggregateSessionContextByModel"]
  liveGenerationProgress: typeof import("@/components/session/session-context-model-metrics")["liveGenerationProgress"]
  getSessionContext: typeof import("@/components/session/session-context-metrics")["getSessionContext"]
  computeMeasuredRate: typeof import("@/components/prompt-input/live-generation-rate-math")["computeMeasuredRate"]
}

let chatSidebarMetricsRuntime: Promise<ChatSidebarMetricsRuntime> | undefined
const loadChatSidebarMetricsRuntime = () =>
  (chatSidebarMetricsRuntime ??= Promise.all([
    import("@/components/session/session-context-model-metrics"),
    import("@/components/session/session-context-metrics"),
    import("@/components/prompt-input/live-generation-rate-math"),
  ]).then(([modelMetrics, contextMetrics, rateMath]) => ({
    aggregateSessionContextByModel: modelMetrics.aggregateSessionContextByModel,
    liveGenerationProgress: modelMetrics.liveGenerationProgress,
    getSessionContext: contextMetrics.getSessionContext,
    computeMeasuredRate: rateMath.computeMeasuredRate,
  })))

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

type ChatSessionGroup = {
  key: string
  label: string
  directory: string
  project?: LocalProject
  sessions: Session[]
  total: number
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
  const language = useLanguage()
  const layout = useLayout()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const platform = usePlatform()
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

  // Model context limits are provider-global, so resolving the catalog once for
  // the pane avoids one provider query per row.
  const providers = useProviders(() => layout.projects.list()[0]?.worktree)
  const providerList = createMemo(() => [...providers.all().values()] as ProviderList)

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
  // computed once per run and shared by both the recent merge and the project
  // group — previously the worktree slice was filtered + sorted a second time.
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
    const now = Date.now()
    const slices = new Map<string, Session[]>()
    const sliceOf = (dir: string) => {
      const cached = slices.get(dir)
      if (cached) return cached
      // searchsmith seam: pre-filter roots here (before sortedRootSessions
      // sorts) when search needs to scope the pane's listing.
      const rows = sortedRootSessions(
        {
          session: (serverSync().child(dir, { bootstrap: false })[0].session ?? []).map((session) =>
            withDirectory(session, dir),
          ),
          path: { directory: dir },
        },
        now,
      )
      slices.set(dir, rows)
      return rows
    }
    const recentPool: Session[] = []
    for (const project of projects) {
      for (const dir of [project.worktree, ...(project.sandboxes ?? [])]) recentPool.push(...sliceOf(dir))
    }
    const projectRows = new Map<string, Session[]>()
    for (const project of projects) {
      const rows = [project.worktree, ...(project.sandboxes ?? [])].flatMap((dir) => sliceOf(dir))
      projectRows.set(project.worktree, rows.sort(compareSessionTime))
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

  const archiveSession = async (session: Session) => {
    if (!session.id) return
    try {
      await serverSDK().client?.session?.update?.({
        sessionID: session.id,
        directory: session.directory,
        time: { archived: Date.now() },
      })
      // Hygiene: let a later un-archive re-hydrate metrics from scratch
      // instead of trusting a prefetch that predates the archive.
      hydrated.delete(session.id)
    } catch {
      // ignore
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
      hydrated.delete(session.id)
    } catch {
      // ignore — row stays put; the user can retry
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

  // Cost/metrics need messages+parts, which background sessions don't have.
  // Hydrate each row once when it scrolls into view instead of fetching every
  // visible session up front; session.prefetch dedupes and rate-limits itself.
  const hydrated = new Set<string>()
  const metricsQueue: Session[] = []
  let metricsActive = false
  let metricsDisposed = false

  const pumpMetrics = () => {
    if (metricsDisposed || metricsActive) return
    const session = metricsQueue.shift()
    if (!session) return
    metricsActive = true
    // Secondary row metrics deliberately use one producer slot. The global
    // request scheduler still owns transport priority, but keeping this producer
    // bounded prevents a viewport full of rows from manufacturing a background
    // queue that competes with project/session housekeeping immediately after
    // first paint.
    void serverSync()
      .session.prefetch(session.id, 200)
      .catch(() => hydrated.delete(session.id))
      .finally(() => {
        metricsActive = false
        pumpMetrics()
      })
  }

  const hydrateMetrics = (session: Session) => {
    if (!session.id || !session.directory || hydrated.has(session.id)) return
    hydrated.add(session.id)
    metricsQueue.push(session)
    pumpMetrics()
  }

  onCleanup(() => {
    metricsDisposed = true
    metricsQueue.length = 0
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
      id="chat-sidebar-pane"
      class="relative my-2 ms-2 flex min-h-0 shrink-0 select-none flex-col self-stretch overflow-hidden rounded-[8px] border border-v2-border-border-base/50 bg-v2-background-bg-base shadow-[0_1px_2px_0_var(--v2-alpha-dark-6),0_1px_3px_0_var(--v2-alpha-dark-4),0_0_0_0.5px_var(--v2-alpha-dark-8)]"
      style={{ width: `${props.state.sidebarWidth()}px` }}
      data-chat-sidebar-pane
    >
      {/* ── Title bar — zinc/IDE dense header ─────────────────── */}
      <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-v2-border-border-muted/50 px-2.5">
        <span class="text-[10px] font-[600] uppercase leading-none tracking-[0.08em] text-v2-text-text-muted">
          {language.t("chats.title")}
        </span>
        <Show when={workingCount() > 0}>
          <TooltipV2 value={language.plural("chats.footer.active", workingCount())} placement="bottom">
            <span class="flex items-center gap-1 rounded-full bg-v2-state-bg-success px-1.5 py-0.5 text-[9px] font-[560] leading-none tabular-nums text-v2-state-fg-success">
              <span class="size-1 animate-pulse rounded-full bg-v2-state-fg-success" />
              {workingCount()}
            </span>
          </TooltipV2>
        </Show>

        <div class="ms-auto flex items-center gap-0.5">
          <TooltipV2 value={language.t("usage.panel.title")} placement="bottom">
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              onClick={() => navigate("/usage")}
              aria-label={language.t("usage.panel.title")}
              icon={<IconV2 name="usage" />}
            />
          </TooltipV2>
          <TooltipV2 value={language.t("command.session.new")} placement="bottom">
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              onClick={() => navigateToNewSession()}
              aria-label={language.t("command.session.new")}
              icon={<IconV2 name="plus" />}
            />
          </TooltipV2>
          <TooltipV2 value={language.t("common.collapse")} placement="bottom">
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
          </TooltipV2>
        </div>
      </div>

      {/* ── Session search — zinc inset field ─────────────────── */}
      <div class="shrink-0 bg-v2-background-bg-base px-2 pb-2 pt-2">
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
          <label class="relative z-20 flex h-[26px] w-full items-center gap-1.5 rounded-[7px] border border-v2-border-border-base/60 bg-v2-background-bg-layer-01 px-1.5 text-v2-icon-icon-muted shadow-[inset_0_1px_1px_var(--v2-alpha-dark-6),inset_0_0.5px_0.5px_var(--v2-alpha-dark-4)] transition-[border-color,background-color,box-shadow] duration-150 hover:border-v2-border-border-base hover:bg-v2-background-bg-layer-02 focus-within:border-v2-border-border-strong focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_2px_var(--v2-alpha-dark-8)]">
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
                <section class="flex flex-col pt-2.5 first:pt-0">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(group.key)}
                    aria-expanded={isExpanded(group.key)}
                    aria-controls={`chats-group-${index()}`}
                    class="group/head sticky top-0 z-10 flex h-6 shrink-0 items-center gap-1.5 bg-v2-background-bg-base px-2.5 text-left transition-colors hover:bg-v2-background-bg-layer-01 focus-visible:bg-v2-background-bg-layer-01 focus-visible:outline-none"
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
                      <TooltipV2 value={language.t("command.session.new")} placement="top">
                        <span
                          role="button"
                          tabIndex={0}
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
                      </TooltipV2>
                    </Show>
                  </button>

                  <Show when={isExpanded(group.key)}>
                    <nav id={`chats-group-${index()}`} class="flex flex-col px-1.5 pb-2">
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
                                  now={now}
                                  minuteNow={minuteNow}
                                  providers={providerList}
                                  pending={pendingSessionId() === session().id}
                                  onPending={(id) => {
                                    if (params.id !== id) setPendingSessionId(id)
                                  }}
                                  hydrate={() => hydrateMetrics(session())}
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
                          {language.t("chats.showMore")}
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
            <TooltipV2 value={language.plural("chats.archived.count", archivedState.rows.length)} placement="top">
              <span class="shrink-0 text-[10px] leading-none tabular-nums text-v2-text-text-faint opacity-70">
                {archivedState.rows.length}
              </span>
            </TooltipV2>
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
        <div class="flex h-6 shrink-0 items-center justify-between border-t border-v2-border-border-muted px-2.5 text-[10px] leading-none text-v2-text-text-faint">
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
  now: () => number
  minuteNow: () => number
  providers: () => ProviderList
  pending?: boolean
  onPending?: (id: string) => void
  hydrate: () => void
  archiveSession: () => Promise<void>
  prefetchSession: () => void
  onChangeModel: (request: SessionModelPickerRequest) => void
  onNewSessionInProject: () => void
  onOpenProjectInExplorer: () => void
  onCopyProjectPath: () => void
  onForkConversation?: () => void
}): JSX.Element {
  const language = useLanguage()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const notification = useNotification()
  const permission = usePermission()
  const platform = usePlatform()

  const title = () => sessionTitle(props.session.title)
  // A group may legitimately contain sessions from more than one project.
  // Always route/actions against the member's own directory; the containing
  // project group is only a fallback for legacy rows that lack one.
  const currentDir = props.session.directory || props.directory || ""
  const sessionData = () => serverSync().session.data
  const isWorking = createMemo(() => sessionData().session_working(props.session.id))
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))

  const permissionState = createMemo(() => permission.ensureServerState(ServerConnection.key(serverSDK().server)))
  const pendingPermissions = createMemo(() => {
    const pending = sessionData().permission[props.session.id] ?? []
    return pending.filter((item) => !permissionState().autoResponds(item, currentDir))
  })
  const pendingQuestions = createMemo(() => sessionData().question[props.session.id] ?? [])
  const hasPermissions = createMemo(() => pendingPermissions().length > 0)
  const hasQuestions = createMemo(() => pendingQuestions().length > 0)
  const needsAttention = createMemo(() => hasPermissions() || hasQuestions())
  const hasTreeDisclosure = createMemo(() => props.treeExpanded !== undefined && !!props.onToggleTree)
  const [metricsRuntime, setMetricsRuntime] = createSignal<ChatSidebarMetricsRuntime>()
  const aggregateMetrics = createMemo(() => chatSidebarAggregateMetrics(props.session))
  let disposed = false
  let metricsHoverTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    if (metricsHoverTimer !== undefined) clearTimeout(metricsHoverTimer)
  })
  const activateMetrics = () => {
    if (metricsHoverTimer !== undefined) {
      clearTimeout(metricsHoverTimer)
      metricsHoverTimer = undefined
    }
    props.hydrate()
    if (metricsRuntime()) return
    void loadChatSidebarMetricsRuntime()
      .then((runtime) => {
        if (!disposed) setMetricsRuntime(runtime)
      })
      .catch(() => undefined)
  }
  const scheduleHoverMetrics = () => {
    if (metricsHoverTimer !== undefined) return
    // TooltipV2 waits 400ms before opening. Start richer history hydration
    // shortly before then, but cancel incidental pointer sweeps across rows so
    // merely moving through the sidebar cannot manufacture a prefetch herd.
    metricsHoverTimer = setTimeout(() => {
      metricsHoverTimer = undefined
      activateMetrics()
    }, 250)
  }
  const cancelHoverMetrics = () => {
    if (metricsHoverTimer === undefined) return
    clearTimeout(metricsHoverTimer)
    metricsHoverTimer = undefined
  }
  createEffect(() => {
    if (!shouldAutoHydrateChatSidebarMetrics({ selected: props.selected, working: isWorking() })) return
    activateMetrics()
  })
  const isAutoAccepting = createMemo(() => {
    try {
      return permissionState().isAutoAccepting(props.session.id, currentDir)
    } catch {
      return false
    }
  })

  const messages = createMemo(() => sessionData().message[props.session.id] ?? [])

  /**
   * Historical totals deliberately do NOT read `now()` — only the live turn
   * below does, so the per-second tick re-runs a cheap memo instead of
   * re-aggregating the whole session once a second for every visible row.
   * Guarded: one malformed session must never take down the whole pane.
   */
  const totals = createMemo<
    { generatedSeconds: number; toolSeconds: number; cost: number; cacheHitPercent: number | null } | undefined
  >(() => {
    const runtime = metricsRuntime()
    const aggregate = aggregateMetrics()
    if (!runtime)
      return {
        generatedSeconds: 0,
        toolSeconds: 0,
        cost: aggregate.cost ?? 0,
        cacheHitPercent: aggregate.cacheHitPercent ?? null,
      }
    try {
      const session = runtime.aggregateSessionContextByModel(messages(), sessionData().part, []).session
      return {
        generatedSeconds: session.generatedSeconds,
        toolSeconds: session.toolSeconds,
        cost: aggregate.cost ?? session.cost,
        cacheHitPercent: aggregate.cacheHitPercent === undefined ? session.cacheHitPercent : aggregate.cacheHitPercent,
      }
    } catch {
      return {
        generatedSeconds: 0,
        toolSeconds: 0,
        cost: aggregate.cost ?? 0,
        cacheHitPercent: aggregate.cacheHitPercent ?? null,
      }
    }
  })

  const contextPercent = createMemo(() => {
    const runtime = metricsRuntime()
    if (!runtime) return null
    return runtime.getSessionContext(messages(), props.providers())?.usage ?? null
  })

  const modelInfo = createMemo(() => {
    const list = messages()
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i]
      if (msg.role !== "assistant") continue
      const assistant = msg as AssistantMessage
      return { modelID: assistant.modelID, variant: assistant.variant }
    }
    return aggregateMetrics().model
  })

  const live = createMemo(() => {
    if (!isWorking()) return undefined
    const runtime = metricsRuntime()
    if (!runtime) return undefined
    const list = messages()
    const parts = sessionData().part
    let active: AssistantMessage | undefined
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i]
      if (msg.role === "assistant" && !msg.time.completed) {
        active = msg as AssistantMessage
        break
      }
    }
    const accumulated = totals()
    if (!active)
      return {
        turnSeconds: 0,
        accumulatedSeconds: (accumulated?.generatedSeconds ?? 0) + (accumulated?.toolSeconds ?? 0),
        rate: null,
      }
    try {
      const activeParts = parts[active.id]
      const progress = runtime.liveGenerationProgress(active, activeParts, props.now())
      const turnSeconds = progress.generatedSeconds + progress.toolSeconds
      return {
        turnSeconds,
        accumulatedSeconds: (accumulated?.generatedSeconds ?? 0) + (accumulated?.toolSeconds ?? 0) + turnSeconds,
        rate: runtime.computeMeasuredRate(activeParts, props.now())?.rate ?? null,
      }
    } catch {
      return { turnSeconds: 0, accumulatedSeconds: 0, rate: null }
    }
  })

  const slug = () => base64Encode(currentDir || props.session.directory || "")
  const warm = () => props.prefetchSession()
  const serverKey = createMemo(() => {
    try {
      return serverSDK().server ? ServerConnection.key(serverSDK().server) : undefined
    } catch {
      return undefined
    }
  })
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

  // Rich hover card — mirrors model-tooltip v2 density + image-1.png (title + project/branch rows)
  const hoverProjectName = () => {
    try {
      const name = (props.session as unknown as { projectName?: string }).projectName as string | undefined
      if (name) return name
      const dir = currentDir || props.session.directory || ""
      const segs = dir.replace(/\\/g, "/").split("/").filter(Boolean)
      return segs[segs.length - 1] ?? dir
    } catch {
      return currentDir || props.session.directory || ""
    }
  }
  const hoverBranch = () => {
    try {
      const meta =
        (props.session as unknown as { branch?: string; vcsBranch?: string }).branch ??
        (props.session as unknown as { vcsBranch?: string }).vcsBranch
      if (meta) return meta
    } catch {}
    return "main"
  }

  return (
    <>
      <TooltipV2
      placement="right"
      gutter={8}
      contentClass="!p-0 overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 shadow-[var(--v2-elevation-floating)]"
      value={
        <div class="flex w-[260px] flex-col gap-2.5 px-3 py-2.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="flex size-5 shrink-0 items-center justify-center rounded-md bg-v2-background-bg-layer-02 text-[10px] font-[700] leading-none text-v2-text-text-muted">
              {(hoverProjectName()[0] ?? "•").toUpperCase()}
            </span>
            <span class="min-w-0 flex-1 truncate text-[12px] font-[600] leading-4 tracking-[-0.01em] text-v2-text-text-base">
              {title() || hoverProjectName()}
            </span>
            <span class="shrink-0 text-[11px] leading-none tabular-nums text-v2-text-text-faint">
              {relativeLabel(props.session, props.minuteNow())}
            </span>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col gap-1.5">
            <div class="flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
              <IconV2 name="folder" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
              <span class="min-w-0 flex-1 truncate text-v2-text-text-muted">{hoverProjectName()}</span>
              <span class="shrink-0 truncate text-[11px] text-v2-text-text-faint">
                {currentDir ? currentDir.replace(/\\/g, "/").split("/").slice(-2).join("/") : ""}
              </span>
            </div>
            <div class="flex items-center gap-1.5 text-[11px] leading-4">
              <IconV2 name="branch" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
              <span class="text-v2-text-text-muted">{hoverBranch()}</span>
              <Show when={modelInfo()}>
                {(info) => (
                  <span class="ml-auto flex min-w-0 items-center gap-1 truncate text-v2-text-text-faint">
                    <IconV2 name="cache" size="small" class="size-2.5 shrink-0 opacity-60" />
                    <span class="truncate">{info().modelID}</span>
                    <Show when={info().variant}>{(v) => <span class="shrink-0">· {v()}</span>}</Show>
                  </span>
                )}
              </Show>
            </div>
          </div>
          <Show
            when={
              totals() && ((totals()!.cost ?? 0) > 0 || contextPercent() !== null || totals()!.cacheHitPercent !== null)
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
      }
    >
        <div
          class="group/session relative min-w-0 rounded-md transition-colors hover:bg-v2-background-bg-layer-01 focus-within:bg-v2-background-bg-layer-01 has-[.active]:bg-v2-background-bg-layer-02 has-[data-selected]:bg-v2-background-bg-layer-02 [[data-model-picker-open]_&]:bg-v2-background-bg-layer-01"
          style={{ "margin-inline-start": `${Math.min(Math.max(props.depth ?? 0, 0), 8) * 14}px` }}
          onPointerEnter={scheduleHoverMetrics}
          onPointerLeave={cancelHoverMetrics}
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
            class="relative flex min-w-0 flex-col gap-[3px] rounded-md py-[5px] pe-1.5 ps-2 text-v2-text-text-muted transition-colors focus-visible:outline-none group-hover/session:text-v2-text-text-base [&.active]:text-v2-text-text-base [&.active]:before:absolute [&.active]:before:inset-y-[5px] [&.active]:before:start-0 [&.active]:before:w-[2px] [&.active]:before:rounded-full [&.active]:before:bg-v2-background-bg-accent [&.active]:before:content-[''] data-[selected]:text-v2-text-text-base data-[selected]:before:absolute data-[selected]:before:inset-y-[5px] data-[selected]:before:start-0 data-[selected]:before:w-[2px] data-[selected]:before:rounded-full data-[selected]:before:bg-v2-background-bg-accent data-[selected]:before:content-['']"
            data-selected={props.selected ? "" : undefined}
            aria-current={props.selected ? "page" : undefined}
            onPointerDown={warm}
            onFocus={() => {
              warm()
              activateMetrics()
            }}
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

              <span class="min-w-0 flex-1 truncate text-[12px] leading-[16px]">{title()}</span>

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
                <TooltipV2 value={language.t("chats.badge.permission")} placement="top">
                  <span class="flex shrink-0 items-center gap-0.5 rounded bg-v2-state-bg-warning px-1 py-[1px] text-[9px] font-[560] leading-none tabular-nums text-v2-state-fg-warning">
                    <IconV2 name="shield" size="small" class="size-2.5" />
                    {pendingPermissions().length}
                  </span>
                </TooltipV2>
              </Show>
              <Show when={hasQuestions()}>
                <TooltipV2 value={language.t("chats.badge.question")} placement="top">
                  <span class="flex shrink-0 items-center gap-0.5 rounded bg-v2-state-bg-info px-1 py-[1px] text-[9px] font-[560] leading-none tabular-nums text-v2-state-fg-info">
                    <IconV2 name="help" size="small" class="size-2.5" />
                    {pendingQuestions().length}
                  </span>
                </TooltipV2>
              </Show>

              {/* Archive replaces the timestamp on hover so the row never reflows */}
              <div class="flex shrink-0 items-center">
                <span class="text-[10px] leading-none tabular-nums text-v2-text-text-muted group-hover/session:hidden">
                  {relativeLabel(props.session, props.minuteNow())}
                </span>
                <TooltipV2 value={language.t("common.archive")} placement="top">
                  <button
                    type="button"
                    aria-label={language.t("common.archive")}
                    class="hidden size-4 items-center justify-center rounded text-v2-icon-icon-muted transition-colors hover:bg-v2-background-bg-layer-03 hover:text-v2-icon-icon-base group-hover/session:flex"
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      void props.archiveSession()
                    }}
                  >
                    <IconV2 name="archive" size="small" class="size-3" />
                  </button>
                </TooltipV2>
              </div>
            </div>

            {/* Line 2 — left metrics (truncate) + right timer (pinned, never squeezed) */}
            <div class="flex min-w-0 items-center gap-1.5 ps-[18px]">
              <div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                <Show when={contextPercent() !== null}>
                  <TooltipV2 value={language.t("chats.metric.context")} placement="top">
                    <span class="flex shrink-0 items-center gap-1">
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
                  </TooltipV2>
                </Show>

                <Show when={(totals()?.cost ?? 0) > 0}>
                  <span class="shrink-0 text-[10px] leading-none tabular-nums text-v2-text-text-faint">
                    {formatCost(totals()!.cost)}
                  </span>
                </Show>

                <Show when={totals()?.cacheHitPercent !== null && totals()?.cacheHitPercent !== undefined}>
                  <TooltipV2 value={language.t("context.tooltip.cacheHit")} placement="top">
                    <span class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums text-v2-text-text-faint opacity-70">
                      <IconV2 name="cache" size="small" class="size-2.5 opacity-70" />
                      <span>{totals()!.cacheHitPercent}%</span>
                    </span>
                  </TooltipV2>
                </Show>

                <Show when={modelInfo()}>
                  {(info) => (
                    <span class="min-w-0 flex-1 truncate text-[10px] leading-none text-v2-text-text-faint opacity-70">
                      {info().modelID}
                      <Show when={info().variant}>{(variant) => ` · ${variant()}`}</Show>
                    </span>
                  )}
                </Show>

                <Show when={isAutoAccepting()}>
                  <TooltipV2 value={language.t("chats.badge.autoAccept")} placement="top">
                    <span class="flex shrink-0 items-center rounded-[3.5px] bg-v2-state-bg-info px-0.5 py-[1px] text-[9px] font-[560] leading-none text-v2-state-fg-info">
                      <IconV2 name="shield-check" size="small" class="size-2.5" />
                    </span>
                  </TooltipV2>
                </Show>
              </div>

              <Show
                when={isWorking()}
                fallback={
                  <Show when={(totals()?.generatedSeconds ?? 0) + (totals()?.toolSeconds ?? 0) > 1}>
                    <TooltipV2 value={language.t("chats.timer.accumulated")} placement="top">
                      <span class="shrink-0 text-[10px] leading-none tabular-nums text-v2-text-text-faint opacity-70">
                        {formatDuration((totals()!.generatedSeconds ?? 0) + (totals()!.toolSeconds ?? 0))}
                      </span>
                    </TooltipV2>
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
                <TooltipV2
                  value={
                    <span>
                      {`${language.t("chats.timer.accumulated")} · ${formatDuration(live()?.accumulatedSeconds ?? 0)}`}
                    </span>
                  }
                  placement="top"
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
                </TooltipV2>
              </Show>
            </div>
          </A>
        </div>
      </TooltipV2>
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
