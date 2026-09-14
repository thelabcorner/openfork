import { HoverCard as Kobalte } from "@kobalte/core/hover-card"
import { createMemo, createSignal, For, Show, startTransition, type JSXElement } from "solid-js"
import type { ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { tabKey, useTabs } from "@/context/tabs"
import { displayName, projectForSession } from "@/pages/layout/helpers"
import { createRequestGate } from "@/utils/request-gate"
import { tabSessionState } from "./titlebar-tab-state"
import { TitlebarTabContextMenu } from "./titlebar-tab-context-menu"
import "./titlebar-tab-popover.css"

// Initial hover delay before the preview appears, per design.
const OPEN_DELAY = 450
// Interactive previews need enough grace to cross the small trigger/content
// gutter without feeling sticky after the pointer genuinely leaves.
const CLOSE_DELAY = 140
// After a preview closes, hovering a neighbouring tab within this window skips
// the open delay — mirrors the tooltip's skipDelayDuration so moving across
// tabs doesn't re-wait the full delay each time.
const SKIP_WINDOW = 500
export const GROUP_PREVIEW_PAGE = 80
export const TAB_PREVIEW_RESOLVE_CONCURRENCY = 4
let lastClosedAt = 0
// One global preview lane is deliberate: rapidly sweeping across several tabs
// must not multiply metadata hydration concurrency by 4 per popover instance.
const previewResolveGate = createRequestGate(TAB_PREVIEW_RESOLVE_CONCURRENCY)

export interface TabPreviewGroupSession {
  id: string
  title: string
  project?: string
  /** Optional owning-group label. Useful when one coordinator anchors several
   * plugin groups (for example multiple OpenSwarm swarms). */
  group?: string
}

export interface TabPreviewData {
  projectName?: string
  title?: string
  path?: string
  serverName?: string
  groupSessions?: TabPreviewGroupSession[]
}

/**
 * Browser-style tab preview with an interactive grouped-session navigator.
 *
 * Grouped rows are real navigation affordances, not decorative text:
 * - left click selects/opens the session tab;
 * - ctrl/cmd-click and middle-click open it in the background;
 * - right click delegates to the exact same TitlebarTabContextMenu used by the
 *   actual tab strip;
 * - session info is hydrated lazily on hover, bounded to four concurrent
 *   requests, so hidden/subagent sessions get the full menu without making the
 *   titlebar eager-load every historical group.
 */
export function TabPreviewPopover(props: {
  trigger: JSXElement
  open: boolean
  onOpenChange: (open: boolean) => void
  data: TabPreviewData
  server?: ServerConnection.Key
  serverCtx?: () => ServerCtx | undefined
  currentSessionID?: string
}) {
  const language = useLanguage()
  const tabs = useTabs()
  let triggerEl: HTMLDivElement | undefined
  let contentEl: HTMLDivElement | undefined

  // When opened during a rapid tab-hopping streak, this preview appears and
  // disappears instantly (no repeated enter/exit animation) — only the first,
  // "cold" preview animates. Mirrors how browsers reuse one tab tooltip.
  const [instant, setInstant] = createSignal(false)
  const [contextMenuOpen, setContextMenuOpen] = createSignal(false)

  const serverCtx = () => props.serverCtx?.()

  const interactive = createMemo(() => !!props.server && (props.data.groupSessions?.length ?? 0) > 0)
  const resolving = new Set<string>()
  const resolveFailedAt = new Map<string, number>()
  const [visibleLimit, setVisibleLimit] = createSignal(GROUP_PREVIEW_PAGE)
  const visibleGroupSessions = createMemo(() => (props.data.groupSessions ?? []).slice(0, visibleLimit()))
  const hiddenGroupSessions = createMemo(() => Math.max(0, (props.data.groupSessions?.length ?? 0) - visibleGroupSessions().length))
  const openSessionIDs = createMemo(() => {
    const server = props.server
    if (!server) return new Set<string>()
    const ids = new Set<string>()
    for (const tab of tabs.store) {
      if (tab.type === "session" && tab.server === server) ids.add(tab.sessionId)
    }
    return ids
  })
  const projects = createMemo(() => serverCtx()?.projects.list() ?? [])
  const projectsByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )

  const hydrateGroupSessions = (members = visibleGroupSessions()) => {
    const ctx = serverCtx()
    if (!ctx) return
    for (const member of members) {
      if (ctx.sync.session.peek(member.id) || resolving.has(member.id)) continue
      const failedAt = resolveFailedAt.get(member.id)
      if (failedAt !== undefined && Date.now() - failedAt < 30_000) continue
      resolving.add(member.id)
      void previewResolveGate(() => ctx.sync.session.resolve(member.id))
        .then(
          () => resolveFailedAt.delete(member.id),
          () => resolveFailedAt.set(member.id, Date.now()),
        )
        .finally(() => resolving.delete(member.id))
    }
  }

  const warm = () => Date.now() - lastClosedAt < SKIP_WINDOW
  // Kobalte reads openDelay lazily when the pointer enters the trigger, so this
  // resolves the skip window per-hover.
  const resolveOpenDelay = () => (warm() ? 0 : OPEN_DELAY)
  const handleOpenChange = (open: boolean) => {
    // A context menu is portalled outside the hover-card subtree. Keep this
    // owner mounted while that menu is open or moving the pointer into the menu
    // would dispose the row (and therefore the menu) underneath the user.
    if (!open && contextMenuOpen()) return
    if (open) {
      setInstant(warm())
      hydrateGroupSessions()
    } else {
      lastClosedAt = Date.now()
      setVisibleLimit(GROUP_PREVIEW_PAGE)
    }
    props.onOpenChange(open)
  }

  const handleContextMenuOpenChange = (open: boolean) => {
    setContextMenuOpen(open)
    if (open) {
      props.onOpenChange(true)
      return
    }
    // If the pointer returned to the preview while the menu was open, let the
    // normal hover lifecycle retain it. Otherwise close immediately after the
    // menu is dismissed instead of leaving an orphaned preview on screen.
    requestAnimationFrame(() => {
      if (triggerEl?.matches(":hover") || contentEl?.matches(":hover")) return
      lastClosedAt = Date.now()
      props.onOpenChange(false)
    })
  }

  const openSession = (sessionID: string, background = false) => {
    const server = props.server
    if (!server) return
    if (background) {
      tabs.addSessionTab({ server, sessionId: sessionID })
      return
    }
    // Keep insertion + route selection in one transition. This mirrors the
    // home/session opener and prevents the route from observing a tab that has
    // not reached the persisted tab store yet.
    void startTransition(() => {
      const tab = tabs.addSessionTab({ server, sessionId: sessionID })
      tabs.select(tab)
    })
    props.onOpenChange(false)
  }

  const fullSession = (sessionID: string) => serverCtx()?.sync.session.peek(sessionID)
  const memberProject = (sessionID: string, fallback?: string) => {
    const session = fullSession(sessionID)
    if (!session) return fallback
    const project = projectForSession(session, projects(), projectsByID())
    return project ? displayName(project) : displayName({ worktree: session.directory })
  }
  const memberTabID = (sessionID: string) => {
    const server = props.server
    if (!server) return ""
    return tabKey({ type: "session", server, sessionId: sessionID })
  }
  const memberTabOpen = (sessionID: string) => {
    return openSessionIDs().has(sessionID)
  }

  const showMoreGroupSessions = () => {
    const current = visibleLimit()
    const next = Math.min((props.data.groupSessions?.length ?? 0), current + GROUP_PREVIEW_PAGE)
    if (next <= current) return
    setVisibleLimit(next)
    hydrateGroupSessions((props.data.groupSessions ?? []).slice(current, next))
  }

  const moveGroupFocus = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }) => {
    if (!contentEl) return
    const rows = [...contentEl.querySelectorAll<HTMLButtonElement>('[data-slot="group-session"]')]
    if (rows.length === 0) return
    const current = rows.indexOf(event.currentTarget)
    let next = current
    if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % rows.length
    else if (event.key === "ArrowUp") next = current <= 0 ? rows.length - 1 : current - 1
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = rows.length - 1
    else return
    event.preventDefault()
    event.stopPropagation()
    rows[next]?.focus()
  }

  return (
    <Kobalte
      open={props.open}
      onOpenChange={handleOpenChange}
      openDelay={resolveOpenDelay()}
      closeDelay={CLOSE_DELAY}
      // Decorative previews can disappear as soon as the trigger is left.
      // Group previews are interactive, so preserve Kobalte's safe-area bridge
      // between the tab and the portalled card.
      ignoreSafeArea={!interactive()}
      placement="bottom-start"
      gutter={6}
    >
      <Kobalte.Trigger
        ref={triggerEl}
        as="div"
        data-component="session-tab-popover-trigger"
        tabIndex={-1}
        onPointerEnter={() => hydrateGroupSessions()}
      >
        {props.trigger}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          ref={(el) => {
            contentEl = el
            // Portalled content lives outside the themed subtree, so mirror the
            // active theme like the v2 tooltip does.
            const theme = triggerEl?.closest("[data-theme]")?.getAttribute("data-theme")
            if (theme) el.setAttribute("data-theme", theme)
          }}
          data-component="session-tab-popover"
          data-interactive={interactive() || undefined}
          data-instant={instant() || undefined}
        >
          <div data-slot="header">
            <Show when={props.data.projectName}>
              <span data-slot="project">{props.data.projectName}</span>
            </Show>
            <Show when={props.data.title}>
              <span data-slot="title">{props.data.title}</span>
            </Show>
          </div>

          <Show when={props.data.path}>
            <div data-slot="row">
              <span data-slot="detail">{props.data.path}</span>
            </div>
          </Show>

          <Show when={props.data.serverName}>
            <div data-slot="server">{props.data.serverName}</div>
          </Show>

           <Show when={props.data.groupSessions?.length}>
             <div data-slot="group-sessions" role="group" aria-label={language.t("groupTab.switchSessions")}>
               <For each={visibleGroupSessions()}>
                {(member) => {
                  const session = () => fullSession(member.id)
                  const state = () => tabSessionState(serverCtx(), member.id)
                  const current = () => props.currentSessionID === member.id
                  const project = () => memberProject(member.id, member.project)

                  const row = (
                    <button
                      type="button"
                      data-slot="group-session"
                      data-current={current() || undefined}
                      data-open-tab={memberTabOpen(member.id) || undefined}
                      data-session-state={state()}
                      aria-current={current() ? "page" : undefined}
                      title={member.title}
                      onPointerEnter={() => hydrateGroupSessions()}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        openSession(member.id, event.metaKey || event.ctrlKey)
                      }}
                      onAuxClick={(event) => {
                        if (event.button !== 1) return
                        event.preventDefault()
                        event.stopPropagation()
                        openSession(member.id, true)
                      }}
                      onKeyDown={moveGroupFocus}
                    >
                      <span data-slot="group-session-state" aria-hidden="true" />
                      <span data-slot="group-session-copy">
                        <span data-slot="group-session-title">{session()?.title ?? member.title}</span>
                        <Show when={member.group || project()}>
                          <span data-slot="group-session-meta">
                            <Show when={member.group}>
                              <span>{member.group}</span>
                            </Show>
                            <Show when={member.group && project()}>
                              <span aria-hidden="true">·</span>
                            </Show>
                            <Show when={project()}>{(label) => <span>{label()}</span>}</Show>
                          </span>
                        </Show>
                      </span>
                      <Show when={current() || memberTabOpen(member.id)}>
                        <span data-slot="group-session-presence" aria-hidden="true" />
                      </Show>
                    </button>
                  )

                  return (
                    <Show when={props.server} fallback={row}>
                      {(server) => (
                        <TitlebarTabContextMenu
                          id={memberTabID(member.id)}
                          session={session}
                          server={server()}
                          onOpenChange={handleContextMenuOpenChange}
                        >
                          {row}
                        </TitlebarTabContextMenu>
                      )}
                    </Show>
                  )
                 }}
               </For>
               <Show when={hiddenGroupSessions() > 0}>
                 <button type="button" data-slot="group-session-more" onClick={showMoreGroupSessions}>
                   {language.t("common.loadMore")} ({Math.min(GROUP_PREVIEW_PAGE, hiddenGroupSessions())})
                 </button>
               </Show>
             </div>
            <Show when={(props.data.groupSessions?.length ?? 0) > 1}>
              <div data-slot="group-session-hint">{language.t("groupTab.keyboardHint")}</div>
            </Show>
          </Show>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
