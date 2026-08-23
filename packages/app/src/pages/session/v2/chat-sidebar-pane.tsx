import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { A, useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
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
import type { ChatSidebarPaneState } from "./chat-sidebar-pane-state"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2/client"

type ProviderList = ReturnType<ReturnType<typeof useProviders>["all"]> extends Map<string, infer P>
  ? P[]
  : never

function relativeLabel(session: Session, now: number): string {
  const time = session.time?.updated ?? session.time?.created ?? 0
  const diffMs = now - time
  const diffM = Math.floor(diffMs / 60000)
  const diffH = Math.floor(diffMs / 3600000)
  const diffD = Math.floor(diffMs / 86400000)
  if (diffD > 0) return `${diffD}d`
  if (diffH > 0) return `${diffH}h`
  if (diffM > 0) return `${diffM}m`
  return "now"
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

  const isWorking = (session: Session) => {
    if (!session.id || !session.directory) return false
    try {
      return serverSync().ensureDirSyncContext(session.directory).data.session_working(session.id)
    } catch {
      return false
    }
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

  const groups = createMemo<ChatSessionGroup[]>(() => {
    const result: ChatSessionGroup[] = []

    const now = Date.now()
    const allSessions: Session[] = []
    const storeSessions = (dir: string) =>
      (serverSync().child(dir, { bootstrap: false })[0].session ?? []).map((session) =>
        withDirectory(session, dir),
      )
    for (const project of layout.projects.list()) {
      const dirs = [project.worktree, ...(project.sandboxes ?? [])]
      for (const dir of dirs) {
        for (const s of sortedRootSessions({ session: storeSessions(dir), path: { directory: dir } }, now)) {
          allSessions.push(s)
        }
      }
    }

    const recentOrdered = pinWorkingFirst([...allSessions].sort(compareSessionTime))
    if (recentOrdered.length > 0) {
      result.push({
        key: "recent",
        label: language.t("chats.group.recent"),
        directory: "",
        sessions: recentOrdered.slice(0, props.state.recentLimit()),
        total: recentOrdered.length,
      })
    }

    for (const project of layout.projects.list()) {
      const [store] = serverSync().child(project.worktree, { bootstrap: false })
      const rows = pinWorkingFirst(
        sortedRootSessions({ session: storeSessions(project.worktree), path: { directory: project.worktree } }, now),
      )
      if (rows.length === 0) continue
      const meta = projectForSession(rows[0], layout.projects.list()) ?? project
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
                    </nav>
                  </Show>
                </section>
              )}
            </For>
          </div>
        </Show>
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
  // Session message/permission/question stores are directory-scoped — read them
  // from the same per-directory context the session route itself uses, not the
  // pane's root context.
  const dirSync = createMemo(() => serverSync().ensureDirSyncContext(currentDir))
  const isWorking = createMemo(() => dirSync().data.session_working(props.session.id))
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))

  const permissionState = createMemo(() => permission.ensureServerState(ServerConnection.key(serverSDK().server)))
  const pendingPermissions = createMemo(() => {
    const pending = dirSync().data.permission[props.session.id] ?? []
    return pending.filter((item) => !permissionState().autoResponds(item, currentDir))
  })
  const pendingQuestions = createMemo(() => dirSync().data.question[props.session.id] ?? [])
  const hasPermissions = createMemo(() => pendingPermissions().length > 0)
  const hasQuestions = createMemo(() => pendingQuestions().length > 0)
  const needsAttention = createMemo(() => hasPermissions() || hasQuestions())

  const messages = createMemo(() => dirSync().data.message[props.session.id] ?? [])

  /**
   * Historical totals deliberately do NOT read `now()` — only the live turn
   * below does, so the per-second tick re-runs a cheap memo instead of
   * re-aggregating the whole session once a second for every visible row.
   * Guarded: one malformed session must never take down the whole pane.
   */
  const totals = createMemo<{ generatedSeconds: number; toolSeconds: number; cost: number } | undefined>(() => {
    try {
      const session = aggregateSessionContextByModel(messages(), dirSync().data.part, []).session
      return { generatedSeconds: session.generatedSeconds, toolSeconds: session.toolSeconds, cost: session.cost }
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
    const parts = dirSync().data.part
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
      // Mirror home controller background open: add tab without navigating
      // We can't import useTabs here directly without circular deps? Use global tabs store via window?
      // Fallback: just navigate — background open is best-effort via link; context menu will at least open.
      // For chats we use tabs API if available via dynamic import to avoid hard dep.
      void import("@/context/tabs").then(({ useTabs }) => {
        try {
          const tabs = useTabs()
          tabs.addSessionTab({ server, sessionId: props.session.id })
        } catch {}
      })
      return
    }
    navigate(`/${slug()}/session/${props.session.id}`)
  }

  // Fire metrics hydration once, when the row first becomes visible — via the
  // pane's shared observer instead of a per-row IntersectionObserver instance.
  let rowEl: HTMLDivElement | undefined
  onMount(() => {
    if (!rowEl) return
    props.observeHydration(rowEl, props.hydrate)
  })

  return (
    <SessionContextMenu
      where="chats"
      session={props.session}
      server={serverKey()}
      onOpen={handleOpen}
      onArchive={() => void props.archiveSession()}
    >
      <div
        ref={rowEl}
        class="group/session relative min-w-0 rounded-md transition-colors hover:bg-v2-background-bg-layer-01 focus-within:bg-v2-background-bg-layer-01 has-[.active]:bg-v2-background-bg-layer-02"
      >
      <A
        href={`/${slug()}/session/${props.session.id}`}
        class="relative flex min-w-0 flex-col gap-[3px] rounded-md py-[5px] pe-1.5 ps-2 text-v2-text-text-muted transition-colors focus-visible:outline-none group-hover/session:text-v2-text-text-base [&.active]:text-v2-text-text-base [&.active]:before:absolute [&.active]:before:inset-y-[5px] [&.active]:before:start-0 [&.active]:before:w-[2px] [&.active]:before:rounded-full [&.active]:before:bg-v2-background-bg-accent [&.active]:before:content-['']"
        onPointerDown={warm}
        onFocus={warm}
      >
        {/* Line 1 — status, title, attention, hover actions */}
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="flex size-3 shrink-0 items-center justify-center">
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

        {/* Line 2 — metrics, aligned under the title */}
        <div class="flex min-w-0 items-center gap-1.5 ps-[18px]">
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

          <Show when={modelInfo()}>
            {(info) => (
              <span class="min-w-0 truncate text-[10px] leading-none text-v2-text-text-faint opacity-70">
                {info().modelID}
                <Show when={info().variant}>{(variant) => ` · ${variant()}`}</Show>
              </span>
            )}
          </Show>

          <span class="min-w-0 flex-1" />

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
                text nodes update in place each tick. */}
            <TooltipV2
              value={
                <span>
                  {`${language.t("chats.timer.accumulated")} · ${formatDuration(live()?.accumulatedSeconds ?? 0)}`}
                </span>
              }
              placement="top"
            >
              <span class="flex shrink-0 items-center gap-1 text-[10px] leading-none tabular-nums">
                <Show when={(live()?.rate ?? null) !== null}>
                  <span class="text-v2-text-text-accent opacity-80">
                    {language.t("chats.metric.rate", { rate: live()?.rate?.toFixed(0) ?? "0" })}
                  </span>
                </Show>
                <span class="font-[560] text-v2-text-text-accent">{formatDuration(live()?.turnSeconds ?? 0)}</span>
              </span>
            </TooltipV2>
          </Show>
        </div>
      </A>
      </div>
    </SessionContextMenu>
  )
}
