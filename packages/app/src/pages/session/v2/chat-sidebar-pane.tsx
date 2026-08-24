import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { A, useIsRouting, useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { useLanguage } from "@/context/language"
import { getProjectAvatarVariant, useLayout, type LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { createHomeSessionSearchController, type HomeSearchHit } from "@/pages/home/home-session-search-controller"
import {
  HomeSessionLeadingController,
  HomeSessionProjectName,
  HomeSessionTitle,
  isBackgroundOpen,
} from "@/pages/home/home-rows"
import type { HomeSessionRecord, OpenSessionOptions } from "@/pages/home/home-sessions-controller"
import { getRelativeTime } from "@/utils/time"
import { useProviders } from "@/hooks/use-providers"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { compareSessionTime, getProjectAvatarSource, projectForSession, displayName, sortedRootSessions } from "@/pages/layout/helpers"
import { aggregateSessionContextByModel, liveGenerationProgress } from "@/components/session/session-context-model-metrics"
import { getSessionContext } from "@/components/session/session-context-metrics"
import { computeMeasuredRate } from "@/components/prompt-input/live-generation-rate-math"
import { SessionContextMenu } from "@/components/session-menu/session-context-menu"
import { CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN, CHAT_SIDEBAR_RECENT_LIMIT_MIN, type ChatSidebarPaneState } from "./chat-sidebar-pane-state"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2/client"

type ProviderList = ReturnType<ReturnType<typeof useProviders>["all"]> extends Map<string, infer P>
  ? P[]
  : never

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
  const language = useLanguage()
  const layout = useLayout()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()

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
  const isWorking = (session: Session) => {
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
    const projects = layout.projects.list()
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
    for (const project of projects) projectRows.set(project.worktree, sliceOf(project.worktree))
    return { projects, recentPool: [...recentPool].sort(compareSessionTime), projectRows }
  })

  // Stage 2 — pinning + assembly. The only stage that reads working state, so
  // a flip storm re-runs just this (~pin cost) while stage 1's sorts stay
  // cached; stableGroups below then finds nothing visibly changed and keeps
  // every row component alive.
  const groups = createMemo<ChatSessionGroup[]>(() => {
    const { projects, recentPool, projectRows } = baseGroups()
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
      if (rows.length === 0) continue
      const [store] = serverSync().child(project.worktree, { bootstrap: false })
      const meta = projectForSession(rows[0], projects) ?? project
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

  // Footer counts server-known roots per directory (sessionTotal estimates),
  // not loaded rows — loaded rows are capped per store and would undercount.
  const totalSessions = createMemo(() =>
    groups().reduce((sum, group) => (group.key === "recent" ? sum : sum + group.total), 0),
  )

  const workingCount = createMemo(() => {
    const seen = new Set<string>()
    for (const group of groups()) {
      for (const session of group.sessions) {
        if (isWorking(session)) seen.add(session.id)
      }
    }
    return seen.size
  })

  // Reveal-once semantics: the active session's group expands when navigation
  // LANDS on it, never continuously — otherwise collapsing the active group
  // would undo itself on the next store tick and collapse would feel broken.
  // The dir-slug fallback covers sessions that are roots of no listed slice
  // (child sessions, rows beyond the store cap): their project still opens.
  const params = useParams<{ serverKey?: string; dir?: string; id?: string }>()
  const routing = useIsRouting()
  const [pendingSessionId, setPendingSessionId] = createSignal<string | null>(null)
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
    const target =
      current.find((group) => group.sessions.some((session) => session.id === id))?.key ??
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

  const archiveSession = async (session: Session) => {
    if (!session.id) return
    try {
      await serverSDK()
        .client?.session?.update?.({
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
    for (const project of layout.projects.list()) {
      for (const dir of [project.worktree, ...(project.sandboxes ?? [])]) {
        if (dirs.some((existing) => pathKey(existing) === pathKey(dir))) continue
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
      await serverSDK()
        .client?.session?.update?.({
          sessionID: session.id,
          directory: session.directory,
          // Server contract (httpapi UpdatePayload): `null` clears the archive
          // timestamp; a number archives. Live sync then re-inserts the row
          // into its project group via session.updated.
          time: { archived: null },
        })
      setArchivedState(
        "rows",
        (rows) => rows.filter((row) => row.id !== session.id),
      )
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
      void serverSync()
        .ensureDirSyncContext(session.directory)
        .session.prefetch(session.id, 20)
        .catch(() => {})
    } catch {
      // ignore
    }
  }

  // Cost/metrics need messages+parts, which background sessions don't have.
  // Hydrate each row once when it scrolls into view instead of fetching every
  // visible session up front; session.prefetch dedupes and rate-limits itself.
  const hydrated = new Set<string>()
  const hydrateMetrics = (session: Session) => {
    if (!session.id || !session.directory || hydrated.has(session.id)) return
    hydrated.add(session.id)
    try {
      void serverSync()
        .ensureDirSyncContext(session.directory)
        .session.prefetch(session.id, 200)
        .catch(() => hydrated.delete(session.id))
    } catch {
      hydrated.delete(session.id)
    }
  }

  // One pane-level IntersectionObserver drives per-row metrics hydration —
  // N rows each constructing their own observer multiplied observer count by
  // row count and remount-amplified churn whenever rows were recreated. Rows
  // register their element; first intersection unobserves and fires that
  // row's hydrate exactly once, same semantics as the old per-row observers.
  const hydrationTargets = new Map<Element, () => void>()
  const hydrationObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const hydrate = hydrationTargets.get(entry.target)
        hydrationObserver.unobserve(entry.target)
        hydrationTargets.delete(entry.target)
        hydrate?.()
      }
    },
    { rootMargin: "60px" },
  )
  onCleanup(() => hydrationObserver.disconnect())
  const observeHydration = (el: Element, hydrate: () => void) => {
    hydrationTargets.set(el, hydrate)
    hydrationObserver.observe(el)
    onCleanup(() => {
      hydrationObserver.unobserve(el)
      hydrationTargets.delete(el)
    })
  }

  const navigate = useNavigate()

  const navigateToNewSession = (directory?: string) => {
    const dir = directory || layout.projects.list()[0]?.worktree || ""
    navigate(`/${base64Encode(dir)}/session`)
  }

  // Homepage inline session search, reused via its controller (no fork). The
  // host adapter mirrors the HomeController surface for this pane's server
  // context; project selection stays unscoped so results span every project,
  // matching the pane's cross-project list.
  const globalCtx = useGlobal()
  const tabs = useTabs()
  const searchServerKey = createMemo(() => {
    try {
      const conn = serverSDK().server
      return conn ? ServerConnection.key(conn) : ("" as ServerConnection.Key)
    } catch {
      return "" as ServerConnection.Key
    }
  })
  const search = createHomeSessionSearchController(
    {
      project: {
        list: () => layout.projects.list(),
        selected: () => undefined,
      },
      server: {
        list: globalCtx.servers.list,
        focused: () => serverSDK().server,
        focusedContext: () => {
          try {
            const conn = serverSDK().server
            return conn ? globalCtx.ensureServerCtx(conn) : undefined
          } catch {
            return undefined
          }
        },
      },
    },
    {
      session: {
        open: (session: Session, options?: OpenSessionOptions) => {
          prefetchSession(session)
          if (!session.id || !session.directory) return
          if (options?.background) {
            const server = searchServerKey()
            if (!server) return
            tabs.addSessionTab({ server, sessionId: session.id })
            return
          }
          navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
        },
      },
    },
    // mod+f belongs to session.find on this surface.
    { registerFocusCommand: false },
  )
  const searchIsOpenTab = (record: HomeSessionRecord) =>
    sessionHasOpenTab(tabs.store, searchServerKey(), record.session)

  return (
    <div
      id="chat-sidebar-pane"
      class="relative my-2 ms-2 flex min-h-0 shrink-0 select-none flex-col self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      style={{ width: `${props.state.sidebarWidth()}px` }}
      data-chat-sidebar-pane
    >
      {/* ── Title bar ─────────────────────────────────────────── */}
      <div class="flex h-9 shrink-0 items-center gap-1.5 px-2.5">
        <span class="text-[11px] font-[560] leading-none tracking-[0.02em] text-v2-text-text-base">
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

      {/* ── Session search (homepage inline search, pane-adapted) ── */}
      <div class="shrink-0 px-2 pb-2">
        <div ref={search.element.setRoot} data-component="chats-session-search" class="relative z-30 w-full">
          <Show when={search.query.open()}>
            <div
              data-component="chats-session-search-panel"
              class="absolute flex flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
              style={{ top: "-4px", left: "-4px", width: "calc(100% + 8px)" }}
            >
              <div class="flex flex-col pt-8">
                <div id="chats-session-search-results" role="listbox" class="flex flex-col pt-1">
                  <Show when={!search.result.loading()} fallback={<ChatsSearchLoading language={language} />}>
                    <Show
                      when={!search.result.error()}
                      fallback={<ChatsSearchError language={language} detail={search.result.error()} />}
                    >
                      <Show
                        when={search.result.list().length > 0}
                        fallback={
                          <p class="my-1 px-3 pb-2 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                            {search.result.noResultsLabel()}
                          </p>
                        }
                      >
                        <ScrollView class="max-h-[min(420px,50vh)]" viewportRef={search.element.setList}>
                          <div class="flex flex-col pb-1">
                            <For each={search.result.list()}>
                              {(hit, index) => {
                                const previous = index() > 0 ? search.result.list()[index() - 1] : undefined
                                return (
                                  <>
                                    <Show when={hit.kind === "session" && (!previous || previous.kind !== "session")}>
                                      <ChatsSearchGroupHeader
                                        label={language.t("home.sessions.search.sessions")}
                                        count={search.result.sessions().length}
                                        countLabel={language.plural(
                                          "home.sessions.search.sessionsResult",
                                          search.result.sessions().length,
                                        )}
                                      />
                                    </Show>
                                    <Show when={hit.kind === "message" && (!previous || previous.kind !== "message")}>
                                      <ChatsSearchGroupHeader
                                        label={language.t("home.sessions.search.messages")}
                                        count={search.result.messages().length}
                                        countLabel={language.plural(
                                          "home.sessions.search.messagesResult",
                                          search.result.messages().length,
                                        )}
                                      />
                                    </Show>
                                    <Show
                                      when={hit.kind === "session"}
                                      fallback={
                                        hit.kind === "message" ? (
                                          <ChatsSearchMessageRow
                                            language={language}
                                            hit={hit}
                                            selected={search.result.active() === hit.key}
                                            server={searchServerKey}
                                            isOpenTab={searchIsOpenTab}
                                            onHighlight={search.result.highlight}
                                            onSelect={search.result.select}
                                          />
                                        ) : null
                                      }
                                    >
                                      <ChatsSearchRow
                                        hit={hit}
                                        selected={search.result.active() === hit.key}
                                        server={searchServerKey}
                                        isOpenTab={searchIsOpenTab}
                                        onHighlight={search.result.highlight}
                                        onSelect={search.result.select}
                                      />
                                    </Show>
                                  </>
                                )
                              }}
                            </For>
                          </div>
                        </ScrollView>
                        <ChatsSearchHints language={language} />
                      </Show>
                    </Show>
                  </Show>
                </div>
              </div>
            </div>
          </Show>
          <label class="relative z-20 flex h-7 w-full items-center gap-1.5 rounded-[6px] py-1 pl-2 pr-1 bg-v2-background-bg-layer-02/60 text-v2-icon-icon-muted transition-[background-color] duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-02 focus-within:bg-v2-background-bg-layer-02">
            <IconV2 name="magnifying-glass" size="small" class="shrink-0" />
            <input
              ref={search.element.setInput}
              class="relative z-20 min-w-0 flex-1 border-0 bg-transparent text-[12px] outline-0 text-v2-text-text-base [font-weight:440] placeholder:text-v2-text-text-faint"
              value={search.query.value()}
              placeholder={language.t("chats.search.placeholder")}
              aria-label={language.t("chats.search.placeholder")}
              aria-expanded={search.query.open()}
              aria-controls="chats-session-search-results"
              aria-autocomplete="list"
              aria-activedescendant={
                search.result.active() && search.query.open()
                  ? `chats-session-search-option-${search.result.active()}`
                  : undefined
              }
              onFocus={search.query.focus}
              onInput={(event) => search.query.input(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  search.query.close()
                  event.currentTarget.blur()
                  return
                }
                if (!search.query.open() || search.result.list().length === 0) return
                if (event.altKey || event.metaKey) return
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  search.result.move(1)
                  return
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault()
                  search.result.move(-1)
                  return
                }
                if (event.key === "Enter" && !event.isComposing) {
                  event.preventDefault()
                  search.result.selectActive()
                }
              }}
            />
            <Show when={search.query.value()}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="relative z-20 shrink-0"
                icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
                aria-label={language.t("chats.search.placeholder")}
                onClick={() => {
                  search.query.close()
                  search.query.focus()
                }}
              />
            </Show>
          </label>
        </div>
      </div>

      {/* ── Session tree ──────────────────────────────────────── */}
      <ScrollView class="min-h-0 flex-1">
        <Show
          when={groups().length > 0}
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
                  </button>

                  <Show when={isExpanded(group.key)}>
                    <nav id={`chats-group-${index()}`} class="flex flex-col px-1.5 pb-2">
                      <For each={group.sessions}>
                        {(session) => (
                          <ChatRow
                            session={session}
                            directory={group.directory}
                            now={now}
                            minuteNow={minuteNow}
                            providers={providerList}
                            pending={pendingSessionId() === session.id}
                            onPending={(id) => {
                              if (params.id !== id) setPendingSessionId(id)
                            }}
                            hydrate={() => hydrateMetrics(session)}
                            observeHydration={observeHydration}
                            archiveSession={() => archiveSession(session)}
                            prefetchSession={() => prefetchSession(session)}
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
        <section class="flex flex-col border-t border-v2-border-border-muted pb-2 pt-1.5" data-component="chats-archived-group">
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
            <div id="chats-group-archived" class="flex flex-col px-1.5 pt-0.5">
              <Show
                when={!archivedState.loading}
                fallback={<ChatsArchivedLoading label={language.t("chats.archived.loading")} />}
              >
                <Show when={!archivedState.error} fallback={<ChatsArchivedError onRetry={() => void fetchArchived()} />}>
                  <Show
                    when={archivedState.rows.length > 0}
                    fallback={
                      <p class="px-2 py-1.5 text-[11px] leading-none text-v2-text-text-faint">
                        {language.t("chats.archived.empty")}
                      </p>
                    }
                  >
                    <For each={archivedState.rows.slice(0, props.state.archivedLimit())}>
                      {(session) => (
                        <ArchivedRow
                          session={session}
                          minuteNow={minuteNow}
                          pending={pendingSessionId() === session.id}
                          onPending={(id) => {
                            if (params.id !== id) setPendingSessionId(id)
                          }}
                          unarchiveSession={() => unarchiveSession(session)}
                        />
                      )}
                    </For>
                    {/* The full archived list is held client-side, so both
                        controls below are exact — no estimates like the
                        server-paged groups. */}
                    <Show when={archivedState.rows.length > props.state.archivedLimit()}>
                      <button
                        type="button"
                        class="ms-[26px] flex h-6 items-center rounded-md pe-2 text-start text-[10px] leading-none text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-muted focus-visible:outline-none"
                        onClick={() => props.state.showMoreArchived()}
                      >
                        {language.t("chats.archived.showMore")}
                      </button>
                    </Show>
                    <Show when={props.state.archivedLimit() > CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN}>
                      <button
                        type="button"
                        class="ms-[26px] flex h-6 items-center rounded-md pe-2 text-start text-[10px] leading-none text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-muted focus-visible:outline-none"
                        onClick={() => props.state.showLessArchived()}
                      >
                        {language.t("chats.archived.showLess")}
                      </button>
                    </Show>
                  </Show>
                </Show>
              </Show>
            </div>
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

      <ResizeHandle
        direction="horizontal"
        edge="end"
        size={props.state.sidebarWidth()}
        min={200}
        max={420}
        onResize={props.state.resizeSidebar}
        pair={resizePair()}
        class="!absolute !inset-y-0 !right-0"
      />
    </div>
  )
}

function ChatsSearchGroupHeader(props: { label: string; count: number; countLabel: string }) {
  return (
    <div role="group" aria-label={props.countLabel} class="my-1 flex h-6 items-center justify-between pl-3 pr-2.5">
      <p class="text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">{props.label}</p>
      <span
        aria-hidden="true"
        class="rounded-[4px] bg-v2-background-bg-layer-02 px-1.5 py-px text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440] tabular-nums"
      >
        {props.count}
      </span>
    </div>
  )
}

function ChatsSearchHints(props: { language: ReturnType<typeof useLanguage> }) {
  return (
    <div class="flex items-center justify-end gap-2 border-t border-v2-border-border-muted px-2.5 py-1.5">
      <span class="flex items-center gap-1">
        <KeybindV2 keys={["↑", "↓"]} variant="ghost" />
        <span class="text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440]">
          {props.language.t("home.sessions.search.hint.navigate")}
        </span>
      </span>
      <span class="flex items-center gap-1">
        <KeybindV2 keys={["↵"]} variant="ghost" />
        <span class="text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440]">
          {props.language.t("home.sessions.search.hint.open")}
        </span>
      </span>
      <span class="flex items-center gap-1">
        <KeybindV2 keys={["esc"]} variant="ghost" />
        <span class="text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440]">
          {props.language.t("home.sessions.search.hint.close")}
        </span>
      </span>
    </div>
  )
}

function ChatsSearchLoading(props: { language: ReturnType<typeof useLanguage> }) {
  return (
    <div class="flex flex-col gap-px px-3 py-2" aria-busy="true" aria-label={props.language.t("common.loading")}>
      <For each={[0, 1, 2]}>{() => <div class="h-7 rounded-[6px] bg-v2-background-bg-layer-02 animate-pulse" />}</For>
    </div>
  )
}

function ChatsSearchError(props: { language: ReturnType<typeof useLanguage>; detail?: string }) {
  return (
    <div class="px-2.5 pb-2.5 pt-1" role="alert">
      <div class="flex flex-col gap-1 rounded-[8px] border border-v2-state-border-danger/40 bg-v2-state-bg-danger/10 px-3 py-2.5">
        <div class="flex items-center gap-2">
          <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-v2-state-border-danger" />
          <p class="text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-base [font-weight:530]">
            {props.language.t("home.sessions.search.error")}
          </p>
        </div>
        <p class="pl-5 text-[12px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
          {props.detail || props.language.t("home.sessions.search.error.description")}
        </p>
      </div>
    </div>
  )
}

type ChatsSearchRowProps = {
  server: Accessor<ServerConnection.Key>
  isOpenTab: (record: HomeSessionRecord) => boolean
  onHighlight: (hit: HomeSearchHit) => void
  onSelect: (hit: HomeSearchHit, options?: OpenSessionOptions) => void
}

function ChatsSearchRow(
  props: ChatsSearchRowProps & {
    hit: HomeSearchHit
    selected: boolean
  },
) {
  const title = createMemo(() => sessionTitle(props.hit.session.title) || props.hit.session.id)
  const projectName = () => props.hit.projectName
  const key = () => props.hit.key

  return (
    <button
      type="button"
      id={`chats-session-search-option-${key()}`}
      data-key={key()}
      data-component="chats-session-search-row"
      role="option"
      aria-selected={props.selected}
      class={`
        flex h-9 w-full shrink-0 cursor-default items-center gap-2 border-0 py-2 pl-3 pr-2.5 text-left
        transition-[background-color] duration-[120ms] ease-in-out
        hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
      `}
      classList={{ "bg-v2-overlay-simple-overlay-hover": props.selected, group: !!projectName() }}
      onMouseEnter={() => props.onHighlight(props.hit)}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onClick={(event) => props.onSelect(props.hit, { background: isBackgroundOpen(event) })}
      onAuxClick={(event) => {
        if (!isBackgroundOpen(event)) return
        event.preventDefault()
        props.onSelect(props.hit, { background: true })
      }}
    >
      <HomeSessionLeadingController
        server={props.server}
        isOpenTab={props.isOpenTab}
        record={{
          session: props.hit.session,
          project: props.hit.project,
          projectName: props.hit.projectName,
        }}
        revealProjectOnHover={!!projectName()}
      />
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <HomeSessionTitle title={title()} showProjectName={!!projectName()} search />
        <Show when={projectName()}>
          <HomeSessionProjectName name={props.hit.projectName} search />
        </Show>
        <Show when={props.hit.groupName}>
          <span class="shrink-0 rounded-[4px] bg-v2-background-bg-layer-02 px-1.5 py-px text-[11px] text-v2-text-text-faint transition-[background-color] duration-[120ms] ease-in-out">
            {props.hit.groupName}
          </span>
        </Show>
      </div>
    </button>
  )
}

function ChatsSearchMessageRow(
  props: ChatsSearchRowProps & {
    language: ReturnType<typeof useLanguage>
    hit: Extract<HomeSearchHit, { kind: "message" }>
    selected: boolean
  },
) {
  const title = createMemo(() => sessionTitle(props.hit.session.title) || props.hit.session.id)
  const projectName = () => props.hit.projectName
  const key = () => props.hit.key
  const time = createMemo(() =>
    getRelativeTime(new Date(props.hit.message.time.created).toISOString(), props.language.t),
  )

  return (
    <button
      type="button"
      id={`chats-session-search-option-${key()}`}
      data-key={key()}
      data-component="chats-session-search-message-row"
      role="option"
      aria-selected={props.selected}
      class={`
        flex min-h-9 w-full shrink-0 cursor-default items-center gap-2 border-0 py-1.5 pl-3 pr-2.5 text-left
        transition-[background-color] duration-[120ms] ease-in-out
        hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
      `}
      classList={{ "bg-v2-overlay-simple-overlay-hover": props.selected, group: !!projectName() }}
      onMouseEnter={() => props.onHighlight(props.hit)}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onClick={(event) => props.onSelect(props.hit, { background: isBackgroundOpen(event) })}
      onAuxClick={(event) => {
        if (!isBackgroundOpen(event)) return
        event.preventDefault()
        props.onSelect(props.hit, { background: true })
      }}
    >
      <HomeSessionLeadingController
        server={props.server}
        isOpenTab={props.isOpenTab}
        record={{
          session: props.hit.session,
          project: props.hit.project,
          projectName: props.hit.projectName,
        }}
        revealProjectOnHover={!!projectName()}
      />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex min-w-0 items-center gap-1.5">
          <HomeSessionTitle title={title()} showProjectName={!!projectName()} search />
          <Show when={projectName()}>
            <HomeSessionProjectName name={props.hit.projectName} search />
          </Show>
          <Show when={props.hit.groupName}>
            <span class="shrink-0 rounded-[4px] bg-v2-background-bg-layer-02 px-1.5 py-px text-[11px] text-v2-text-text-faint transition-[background-color] duration-[120ms] ease-in-out">
              {props.hit.groupName}
            </span>
          </Show>
          <span class="ml-auto shrink-0 pl-2 text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440] tabular-nums">
            {time()}
          </span>
        </div>
        <p class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
          <For each={props.hit.segments}>
            {(segment) =>
              segment.match ? (
                <mark class="rounded-[3px] bg-v2-state-bg-info/70 px-[1px] text-v2-text-text-base [font-weight:530]">
                  {segment.text}
                </mark>
              ) : (
                segment.text
              )
            }
          </For>
        </p>
      </div>
    </button>
  )
}

function ChatRow(props: {
  session: Session
  directory: string
  now: () => number
  minuteNow: () => number
  providers: () => ProviderList
  pending?: boolean
  onPending?: (id: string) => void
  hydrate: () => void
  observeHydration: (el: Element, hydrate: () => void) => void
  archiveSession: () => Promise<void>
  prefetchSession: () => void
}): JSX.Element {
  const language = useLanguage()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const notification = useNotification()
  const permission = usePermission()

  const title = () => sessionTitle(props.session.title)
  const currentDir = props.directory || props.session.directory || ""
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
  const totals = createMemo<{ generatedSeconds: number; toolSeconds: number; cost: number; cacheHitPercent: number | null } | undefined>(() => {
    try {
      const session = aggregateSessionContextByModel(messages(), sessionData().part, []).session
      return { generatedSeconds: session.generatedSeconds, toolSeconds: session.toolSeconds, cost: session.cost, cacheHitPercent: session.cacheHitPercent }
    } catch {
      return undefined
    }
  })

  const contextPercent = createMemo(() => getSessionContext(messages(), props.providers())?.usage ?? null)

  const modelInfo = createMemo(() => {
    const list = messages()
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i]
      if (msg.role !== "assistant") continue
      const assistant = msg as AssistantMessage
      return { modelID: assistant.modelID, variant: assistant.variant }
    }
    return undefined
  })

  const live = createMemo(() => {
    if (!isWorking()) return undefined
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
      const progress = liveGenerationProgress(active, activeParts, props.now())
      const turnSeconds = progress.generatedSeconds + progress.toolSeconds
      return {
        turnSeconds,
        accumulatedSeconds:
          (accumulated?.generatedSeconds ?? 0) + (accumulated?.toolSeconds ?? 0) + turnSeconds,
        rate: computeMeasuredRate(activeParts, props.now())?.rate ?? null,
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

  // Fire metrics hydration once, when the row first becomes visible — via the
  // pane's shared observer instead of a per-row IntersectionObserver instance.
  let rowEl: HTMLDivElement | undefined
  onMount(() => {
    if (!rowEl) return
    props.observeHydration(rowEl, props.hydrate)
  })

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
      const meta = (props.session as unknown as { branch?: string; vcsBranch?: string }).branch ?? (props.session as unknown as { vcsBranch?: string }).vcsBranch
      if (meta) return meta
    } catch {}
    return "main"
  }

  return (
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
            <span class="min-w-0 flex-1 truncate text-[12px] font-[600] leading-4 tracking-[-0.01em] text-v2-text-text-base">{title() || hoverProjectName()}</span>
            <span class="shrink-0 text-[11px] leading-none tabular-nums text-v2-text-text-faint">{relativeLabel(props.session, props.minuteNow())}</span>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col gap-1.5">
            <div class="flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
              <IconV2 name="folder" size="small" class="size-3 shrink-0 text-v2-icon-icon-muted" />
              <span class="min-w-0 flex-1 truncate text-v2-text-text-muted">{hoverProjectName()}</span>
              <span class="shrink-0 truncate text-[11px] text-v2-text-text-faint">{currentDir ? currentDir.replace(/\\/g, "/").split("/").slice(-2).join("/") : ""}</span>
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
          <Show when={totals() && ((totals()!.cost ?? 0) > 0 || contextPercent() !== null || totals()!.cacheHitPercent !== null)}>
            <div class="h-px bg-v2-border-border-muted" />
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-none tabular-nums">
              <Show when={(totals()?.cost ?? 0) > 0}>
                <span class="text-v2-text-text-base">{formatCost(totals()!.cost)}</span>
              </Show>
              <Show when={contextPercent() !== null}>
                <span class="flex items-center gap-1 text-v2-text-text-muted">
                  <span class="h-[3px] w-8 overflow-hidden rounded-full bg-v2-background-bg-layer-03">
                    <span class={`block h-full rounded-full ${contextTone(contextPercent()!).bar}`} style={{ width: `${Math.min(100, Math.max(2, contextPercent()!))}%` }} />
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
      <SessionContextMenu
        where="chats"
        session={props.session}
        server={serverKey()}
        onOpen={handleOpen}
        onArchive={() => void props.archiveSession()}
      >
        <div
          ref={rowEl}
          class="group/session relative min-w-0 rounded-md transition-colors hover:bg-v2-background-bg-layer-01 focus-within:bg-v2-background-bg-layer-01 has-[.active]:bg-v2-background-bg-layer-02 [[data-model-picker-open]_&]:bg-v2-background-bg-layer-01"
        >
      <A
        href={`/${slug()}/session/${props.session.id}`}
        class="relative flex min-w-0 flex-col gap-[3px] rounded-md py-[5px] pe-1.5 ps-2 text-v2-text-text-muted transition-colors focus-visible:outline-none group-hover/session:text-v2-text-text-base [&.active]:text-v2-text-text-base [&.active]:before:absolute [&.active]:before:inset-y-[5px] [&.active]:before:start-0 [&.active]:before:w-[2px] [&.active]:before:rounded-full [&.active]:before:bg-v2-background-bg-accent [&.active]:before:content-['']"
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
                  <Spinner class="size-3 text-v2-icon-icon-base" />
                </Show>
              }
            >
              <LoaderV2 class="size-3" aria-hidden="true" />
            </Show>
          </span>

          <span class="min-w-0 flex-1 truncate text-[12px] leading-[16px]">{title()}</span>

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
                     <span class="font-[560] text-v2-text-text-accent">{formatDuration(live()?.turnSeconds ?? 0)}</span>
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
      </SessionContextMenu>
    </TooltipV2>
  )
}

function ChatsArchivedLoading(props: { label: string }) {
  return (
    <div class="flex flex-col gap-px px-2 py-1" aria-busy="true" aria-label={props.label}>
      <For each={[0, 1]}>{() => <div class="h-[26px] rounded-md bg-v2-background-bg-layer-02 animate-pulse" />}</For>
    </div>
  )
}

function ChatsArchivedError(props: { onRetry: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex items-center justify-between gap-2 px-2 py-1.5" role="alert">
      <span class="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-v2-state-border-danger" />
        <span class="min-w-0 truncate text-[11px] leading-none text-v2-text-text-muted">
          {language.t("chats.archived.error")}
        </span>
      </span>
      <button
        type="button"
        class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] leading-none text-v2-text-text-faint transition-colors hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-02 focus-visible:text-v2-text-text-muted focus-visible:outline-none"
        onClick={() => props.onRetry()}
      >
        {language.t("chats.archived.retry")}
      </button>
    </div>
  )
}

/**
 * Archived rows reuse the ChatRow silhouette (same paddings, line heights and
 * hover treatment) but stay dimmed at rest like palette archived rows, show
 * WHEN the session was archived instead of live metrics, and surface Unarchive
 * as the primary action — revealed on hover/focus exactly where active rows
 * reveal Archive, so the two states mirror each other without reflow.
 */
function ArchivedRow(props: {
  session: Session
  minuteNow: () => number
  pending?: boolean
  onPending?: (id: string) => void
  unarchiveSession: () => Promise<void>
}): JSX.Element {
  const language = useLanguage()

  const title = () => sessionTitle(props.session.title)
  const slug = () => base64Encode(props.session.directory || "")
  // Server-known model ref — no message hydration needed for a dimmed row.
  const modelInfo = () => props.session.model

  const [busy, setBusy] = createSignal(false)
  const unarchive = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (busy()) return
    setBusy(true)
    try {
      await props.unarchiveSession()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="group/session relative min-w-0 rounded-md opacity-70 transition-[background-color,opacity] duration-[120ms] hover:bg-v2-background-bg-layer-01 hover:opacity-100 focus-within:bg-v2-background-bg-layer-01 focus-within:opacity-100">
      <A
        href={`/${slug()}/session/${props.session.id}`}
        class="relative flex min-w-0 flex-col gap-[3px] rounded-md py-[5px] pe-1.5 ps-2 text-v2-text-text-muted transition-colors focus-visible:outline-none group-hover/session:text-v2-text-text-base"
        onClick={(event: MouseEvent) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button === 1) return
          props.onPending?.(props.session.id)
        }}
      >
        {/* Line 1 — archive glyph, title, unarchive-on-hover (mirrors ChatRow's
            timestamp↔archive swap so nothing shifts between the two states) */}
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="flex size-3 shrink-0 items-center justify-center">
            <Show when={props.pending} fallback={<IconV2 name="archive" size="small" class="size-3 text-v2-icon-icon-muted" />}>
              <LoaderV2 class="size-3" aria-hidden="true" />
            </Show>
          </span>

          <span class="min-w-0 flex-1 truncate text-[12px] leading-[16px]">{title()}</span>

          <div class="flex shrink-0 items-center">
            <span class="text-[10px] leading-none tabular-nums text-v2-text-text-muted group-hover/session:hidden group-focus-within/session:hidden">
              {relativeStamp(props.session.time?.archived, props.minuteNow())}
            </span>
            <TooltipV2 value={language.t("chats.archived.unarchive")} placement="top">
              <button
                type="button"
                aria-label={language.t("chats.archived.unarchive")}
                disabled={busy()}
                class="hidden size-4 items-center justify-center rounded text-v2-icon-icon-muted transition-colors hover:bg-v2-background-bg-layer-03 hover:text-v2-icon-icon-base group-hover/session:flex group-focus-within/session:flex"
                onClick={unarchive}
              >
                <Show when={!busy()} fallback={<LoaderV2 class="size-3" aria-hidden="true" />}>
                  <IconV2 name="archive" size="small" class="size-3 rotate-180" />
                </Show>
              </button>
            </TooltipV2>
          </div>
        </div>

        {/* Line 2 — fixed-height so every archived row matches, whether or not
            the session carries a server-known model ref */}
        <div class="flex min-h-[10px] min-w-0 items-center gap-1.5 ps-[18px]">
          <Show when={modelInfo()}>
            {(model) => (
              <span class="min-w-0 truncate text-[10px] leading-none text-v2-text-text-faint opacity-70">
                {model().id}
                <Show when={model().variant}>{(variant) => ` · ${variant()}`}</Show>
              </span>
            )}
          </Show>
          <span class="min-w-0 flex-1" />
        </div>
      </A>
    </div>
  )
}
