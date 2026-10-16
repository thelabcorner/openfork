import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  Show,
  startTransition,
  Switch,
  type JSX,
} from "solid-js"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import type { Session } from "@opencode-ai/sdk/v2"
import type { Info as SessionTelemetryInfo } from "@opencode-ai/schema/session-telemetry"
import type { ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { getProjectAvatarVariant, type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { tabKey, useTabs } from "@/context/tabs"
import { displayName, getProjectAvatarSource, projectForSessionIndexed } from "@/pages/layout/helpers"
import { formatDuration, formatUSD } from "@/components/usage/usage-format"
import { getRelativeTime } from "@/utils/time"
import { sessionTelemetryClientNow, sessionTelemetryElapsedMs } from "@/utils/session-telemetry-time"
import { tabSessionState } from "@/components/titlebar-tab-state"
import { TitlebarTabContextMenu } from "@/components/titlebar-tab-context-menu"
import { measureVirtualRow } from "@/components/virtual-scroll-element"
import {
  KNOWN_SPECIAL_AGENT_KINDS,
  type SessionPreviewRelationships,
  type SessionPreviewRow,
  type SessionPreviewSectionKind,
} from "./session-preview-model"
import {
  forEachPreviewSession,
  previewRelationshipCount,
  previewSessionWeights,
  previewUnopenedCount,
  previewVisibleRows,
  type PreviewListItem,
} from "./session-preview-rows"
import { previewSparseSummary, samePreviewSummary } from "./session-preview-summary"
import { previewTelemetryIDs, samePreviewTelemetryIDs } from "./session-preview-telemetry"
import "./session-preview-card.css"

export const GROUP_PREVIEW_PAGE = 80

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

export interface SessionPreviewData {
  /** Present for session tabs/rows; group tabs describe the group itself. */
  project?: LocalProject
  directory?: string
  projectName?: string
  title?: string
  path?: string
  serverName?: string
  /** VCS branch, only when already materialized on the Session row — never
   * fetched here. */
  branch?: string
}

type MemberStatus = "working" | "paused" | "waiting" | "idle" | "interrupted"


const SPECIAL_AGENT_LABEL_KEYS: Record<string, string> = {
  goal_auditor: "sessionPreview.specialAgent.goalAuditor",
  goal_revisor: "sessionPreview.specialAgent.goalRevisor",
  prompt_revisor: "sessionPreview.specialAgent.promptRevisor",
  session_title: "sessionPreview.specialAgent.sessionTitle",
  spad_auditor: "sessionPreview.specialAgent.spadAuditor",
}

function sectionIcon(kind: SessionPreviewSectionKind | "special") {
  switch (kind) {
    case "subagent":
    case "delegation":
      return "branch" as const
    case "plugin":
      return "layers" as const
    case "swarm":
      return "workspace" as const
    case "special":
      return "star" as const
    default:
      return "folder" as const
  }
}

/** Context-window pressure from the settled telemetry turn; O(1). */
function contextPercent(value: SessionTelemetryInfo | undefined) {
  const context = value?.context
  const limit = context?.model.contextLimit
  if (!context || !limit || limit <= 0) return undefined
  const tokens = context.tokens
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  if (total <= 0) return undefined
  return Math.min(100, Math.round((total / limit) * 100))
}

function contextTone(percent: number) {
  if (percent >= 85) return "danger"
  if (percent >= 65) return "warning"
  return "neutral"
}

/**
 * Canonical rich Session preview: the same card rendered by both the
 * titlebar tab hover popover and the Chat Sidebar's pooled hover controller.
 *
 * Every value rendered here is an O(1) read of state the app already owns:
 * the group-detail member projection (title, parent, activity time, ephemeral
 * session, special-agent kind), live `session_working`/`session_paused`
 * status, pending permission/question maps, and the shared session-telemetry
 * projection. The only transport it can trigger is one coalesced telemetry
 * batch for the visible rows; it never resolves or hydrates sessions per row.
 * A right click on a row whose structural session is unknown resolves that
 * one session on demand.
 *
 * This component owns no positioning, animation, or open/close lifecycle —
 * that is surface-specific and lives in the adapter (Kobalte HoverCard for
 * the titlebar, the pane-level pooled controller for the sidebar). It only
 * needs to know whether it is currently visible (`active`) to gate its shared
 * clock and telemetry batch.
 */
export function SessionPreviewCard(props: {
  data: SessionPreviewData
  relationships: () => SessionPreviewRelationships | undefined
  currentSessionID?: string
  /** Optional identity for adapters that reuse one physical card across tabs. */
  previewKey?: string
  server?: ServerConnection.Key
  serverCtx?: () => ServerCtx | undefined
  active: () => boolean
  /** Called after a row navigates the app to a session in the foreground. */
  onOpenSession?: () => void
  /** Bubbled so the adapter can keep itself mounted while a row's context menu is open. */
  onRowContextMenuOpenChange?: (open: boolean) => void
  rootRef?: (el: HTMLDivElement) => void
  /** Hard cap on the card's total rendered height, in px — the relationships
   * section shrinks to fit instead of pushing the header/footer or the card
   * itself past this bound. Used by pane-scoped adapters (the Chat Sidebar)
   * that must never extend beyond their own container. */
  maxHeight?: () => number | undefined
}) {
  const language = useLanguage()
  const tabs = useTabs()
  let rootEl: HTMLDivElement | undefined
  let disposed = false
  let selectedScrollEpoch = 0
  let focusFrame = 0
  onCleanup(() => {
    disposed = true
    selectedScrollEpoch++
    if (focusFrame) cancelAnimationFrame(focusFrame)
  })
  const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement>()
  const [focusedIndex, setFocusedIndex] = createSignal(-1)

  const [visibleLimit, setVisibleLimit] = createSignal(GROUP_PREVIEW_PAGE)
  const [now, setNow] = createSignal(Date.now())
  // A reused tab-strip card must not carry a previous group's expanded page,
  // focused virtual row or scroll offset into the next session preview.
  createEffect(on(
    () => props.previewKey,
    (key, previous) => {
      if (!key || key === previous) return
      setVisibleLimit(GROUP_PREVIEW_PAGE)
      setFocusedIndex(-1)
      const scroller = scrollRoot()
      if (scroller) scroller.scrollTop = 0
    },
    { defer: true },
  ))

  const serverCtx = () => props.serverCtx?.()
  const relationships = createMemo(() => props.relationships())
  const isGroupTab = () => !props.currentSessionID

  const totalCount = createMemo(() => previewRelationshipCount(relationships()))
  const sessionWeights = createMemo(() => previewSessionWeights(relationships()))
  const visibleRows = createMemo<PreviewListItem[]>(() =>
    previewVisibleRows(relationships(), visibleLimit(), language.t("sessionPreview.section.specialAgents")),
  )
  const hiddenCount = createMemo(() => Math.max(0, totalCount() - visibleRows().length))
  const interactive = createMemo(() => !!props.server && totalCount() > 0)
  const currentVisibleIndex = createMemo(() => {
    const id = props.currentSessionID
    if (!id) return -1
    return visibleRows().findIndex((item) => item.row.row.id === id)
  })
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return visibleRows().length
    },
    getScrollElement: () => scrollRoot() ?? null,
    initialRect: { width: 340, height: 360 },
    get estimateSize() {
      const snapshot = visibleRows()
      return (index: number) => {
        const item = snapshot[index]
        if (!item) return 25
        // 24px member + 1px row rhythm. Section-leading rows also include the
        // 20px divider and its margin; special-agent dividers are slightly taller.
        return item.first ? (item.sectionKind === "special" ? 57 : 48) : 25
      }
    },
    overscan: 6,
    get getItemKey() {
      const snapshot = visibleRows()
      return (index: number) => {
        const item = snapshot[index]
        return item ? `${item.sectionKey}:${item.row.row.id}` : index
      }
    },
    get rangeExtractor() {
      return (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indexes = defaultRangeExtractor(range)
        const pinned = [focusedIndex(), currentVisibleIndex()]
        for (const index of pinned) {
          if (index < 0 || index >= range.count || indexes.includes(index)) continue
          indexes.push(index)
        }
        return indexes.sort((a, b) => a - b)
      }
    },
  })
  const virtualRows = createMemo<
    Array<{
      virtualRow: ReturnType<typeof virtualizer.getVirtualItems>[number]
      item: PreviewListItem | undefined
      key: string | number
    }>
  >((previous = []) => {
    const prior = new Map(previous.map((entry) => [entry.key, entry] as const))
    return virtualizer.getVirtualItems().map((virtualRow) => {
      const item = visibleRows()[virtualRow.index]
      const key = item ? `${item.sectionKey}:${item.row.row.id}` : virtualRow.index
      const existing = prior.get(key)
      if (
        existing &&
        existing.item === item &&
        existing.virtualRow.index === virtualRow.index &&
        existing.virtualRow.start === virtualRow.start &&
        existing.virtualRow.size === virtualRow.size
      ) {
        return existing
      }
      return { virtualRow, item, key }
    })
  })

  const openSessionIDs = createMemo(() => {
    const server = props.server
    if (!server) return new Set<string>()
    const ids = new Set<string>()
    for (const tab of tabs.store) {
      if (tab.type === "session" && tab.server === server) ids.add(tab.sessionId)
    }
    return ids
  })
  // Updating an unrelated tab must not revisit every relationship row.
  // Duplicated cross-group memberships retain their former row counts.
  const openableCount = createMemo(() => previewUnopenedCount(sessionWeights(), openSessionIDs(), totalCount()))

  // Reuse the server-owned index already populated for titlebar avatars and
  // navigation. A preview with multiple foreign-project members must not
  // rescan/normalize all project directories for each mounted row or update.
  const projectIndex = createMemo(() => serverCtx()?.projects.index())

  // ---- O(1) per-session reads ------------------------------------------
  const peek = (id: string) => serverCtx()?.sync.session.peek(id)
  const telemetry = (id: string) => serverCtx()?.sync.telemetry.get(id)
  const telemetryReceivedAt = (id: string | undefined) =>
    id ? serverCtx()?.sync.telemetry.receivedAt(id) : undefined
  const attention = (id: string) => {
    const data = serverCtx()?.sync.session.data
    if (!data) return { permissions: 0, questions: 0 }
    return { permissions: data.permission[id]?.length ?? 0, questions: data.question[id]?.length ?? 0 }
  }
  const status = (id: string): MemberStatus => {
    const pending = attention(id)
    if (pending.permissions + pending.questions > 0) return "waiting"
    return tabSessionState(serverCtx(), id)
  }
  const projectLabel = (session: Session | undefined) => {
    if (!session) return undefined
    const project = projectForSessionIndexed(session, projectIndex())
    return displayName(project ?? { worktree: session.directory })
  }

  // The card can outlive its own visibility (kept-mounted by the adapter). Do
  // not keep tracking every row's status while nothing is on screen.
  const summary = createMemo(() => {
    let running = 0
    let waiting = 0
    if (!props.active()) return { running, waiting }
    const weights = sessionWeights()
    const data = serverCtx()?.sync.session.data
    if (!data) return { running, waiting }
    // Status maps are sparse: 16K idle group members should not create 16K
    // fine-grained subscriptions in an otherwise lightweight hover tooltip.
    // Tiny groups retain narrow per-ID reactive dependencies.
    // Paired crossover measurements show that enumerating server-global
    // status maps loses to narrow reads for small groups when hundreds of
    // unrelated sessions are working. Reserve the sparse path for genuinely
    // large groups; never make a 25/50/100-worker preview pay global scans.
    if (weights.size >= 1_024) {
      return previewSparseSummary({
        weights,
        statuses: data.session_status,
        paused: data.paused,
        permissions: data.permission,
        questions: data.question,
      })
    }
    for (const [id, multiplicity] of weights) {
      const value = status(id)
      if (value === "working") running += multiplicity
      else if (value === "waiting") waiting += multiplicity
    }
    return { running, waiting }
  }, undefined, { equals: samePreviewSummary })

  // One shared clock while the card is visible: seconds only when something is
  // live (turn timers), minutes otherwise (relative activity stamps).
  // Depend on the *clock resolution* rather than the full summary count.
  // Bursts of unrelated workers starting/stopping should not repeatedly
  // tear down/rearm the exact same 1-second interval or cause timer jitter.
  const secondClock = createMemo(() =>
    props.active() && (summary().running > 0 || status(props.currentSessionID ?? "") === "working"),
  )
  createEffect(() => {
    if (!props.active()) return
    const live = secondClock()
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), live ? 1000 : 30_000)
    onCleanup(() => clearInterval(timer))
  })

  // One coalesced telemetry batch for rows the virtual window actually mounts.
  // Known ids are skipped by the owner, so re-opening the card costs nothing.
  const visibleTelemetryIDs = createMemo(
    () => previewTelemetryIDs(virtualRows(), props.currentSessionID),
    undefined,
    { equals: samePreviewTelemetryIDs },
  )
  createEffect(() => {
    if (!props.active()) return
    const ctx = serverCtx()
    if (!ctx) return
    ctx.sync.telemetry.ensure(visibleTelemetryIDs())
  })

  const relative = (ms: number | undefined) =>
    ms ? getRelativeTime(new Date(Math.min(ms, now())).toISOString(), language.t) : undefined

  const phaseLabel = (value: SessionTelemetryInfo | undefined) => {
    switch (value?.phase) {
      case "requesting":
        return language.t("groupTab.phase.requesting")
      case "reasoning":
        return language.t("groupTab.phase.reasoning")
      case "generating":
        return language.t("groupTab.phase.generating")
      case "tool":
        return language.t("groupTab.phase.tool")
      case "retrying":
        return language.t("groupTab.phase.retrying")
    }
    return language.t("tab.state.working")
  }
  const turnElapsed = (id: string | undefined, value: SessionTelemetryInfo | undefined) => {
    // Subscribe to the card's existing shared interval; elapsed arithmetic uses
    // the client monotonic clock rather than this wall-clock value.
    now()
    const since = value?.turnStartedAt ?? value?.phaseStartedAt
    if (!since) return undefined
    const elapsed = sessionTelemetryElapsedMs({
      startedAt: since,
      sampledAt: value?.sampledAt,
      updatedAt: value?.updatedAt,
      receivedAt: telemetryReceivedAt(id),
      now: sessionTelemetryClientNow(),
    })
    return elapsed >= 1000 ? formatDuration(elapsed, language.locale()) : undefined
  }
  const specialAgentLabel = (kind: string | undefined) => {
    if (!kind) return language.t("sessionPreview.specialAgent.generic")
    const key = SPECIAL_AGENT_LABEL_KEYS[kind]
    return key ? language.t(key) : kind
  }

  // Keep the current session visible when the list is taller than the card.
  createEffect(() => {
    if (!props.active() || !props.currentSessionID) return
    const index = currentVisibleIndex()
    if (index < 0 || !scrollRoot()) return
    const epoch = ++selectedScrollEpoch
    queueMicrotask(() => {
      if (disposed || epoch !== selectedScrollEpoch || !props.active() || !scrollRoot()?.isConnected) return
      virtualizer.scrollToIndex(index, { align: "center" })
    })
  })
  createEffect(() => {
    if (props.active()) return
    setFocusedIndex(-1)
  })

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
    props.onOpenSession?.()
  }

  // Bulk action for the section head: open every member in the background in
  // one pass. Already-open rows are no-ops (addSessionTab returns the existing
  // tab), so this never re-activates or duplicates a tab, and it never moves
  // the active route for a hover-preview surface.
  const openAllSessions = () => {
    const server = props.server
    if (!server) return
    const ids: string[] = []
    forEachPreviewSession(relationships(), (id) => ids.push(id))
    tabs.addSessionTabs({ server, sessionIds: ids })
  }

  const memberTabID = (sessionID: string) => {
    const server = props.server
    if (!server) return ""
    return tabKey({ type: "session", server, sessionId: sessionID })
  }

  // Structural fallback for context-menu actions. Older servers omit the
  // projection fields; only then resolve, and only for the row the user
  // actually right-clicked.
  const resolving = new Set<string>()
  const ensureMenuSession = (sessionID: string, fallback: Session | undefined) => {
    const ctx = serverCtx()
    if (!ctx || fallback || ctx.sync.session.peek(sessionID) || resolving.has(sessionID)) return
    resolving.add(sessionID)
    void ctx.sync.session
      .resolve(sessionID, { priority: "background" })
      .catch(() => undefined)
      .finally(() => resolving.delete(sessionID))
  }

  const showMore = () => setVisibleLimit((current) => current + GROUP_PREVIEW_PAGE)

  const moveFocus = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }) => {
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.dispatchEvent(
        new MouseEvent("click", { bubbles: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey }),
      )
      return
    }
    const count = visibleRows().length
    if (count === 0) return
    const parsed = Number(event.currentTarget.dataset.previewIndex)
    const current = Number.isFinite(parsed) ? parsed : -1
    let next = current
    if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % count
    else if (event.key === "ArrowUp") next = current <= 0 ? count - 1 : current - 1
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = count - 1
    else return
    event.preventDefault()
    event.stopPropagation()
    setFocusedIndex(next)
    virtualizer.scrollToIndex(next, { align: "auto" })
    if (focusFrame) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = 0
      if (disposed || !props.active()) return
      const root = scrollRoot()
      if (!root?.isConnected) return
      root.querySelector<HTMLButtonElement>(`[data-preview-index="${next}"]`)?.focus({ preventScroll: true })
    })
  }

  // ---- Presentation -----------------------------------------------------
  const headerSessionID = () => props.currentSessionID
  const headerSession = () => {
    const id = headerSessionID()
    return id ? peek(id) : undefined
  }
  const headerStatus = () => {
    const id = headerSessionID()
    return id ? status(id) : "idle"
  }
  const headerTelemetry = () => {
    const id = headerSessionID()
    return id ? telemetry(id) : undefined
  }
  const headerModel = createMemo(() => {
    const value = headerTelemetry()
    const model = value?.context?.model ?? value?.model
    if (model) return { label: model.name ?? model.modelID, variant: model.variant }
    const fallback = headerSession()?.model
    return fallback ? { label: fallback.id, variant: fallback.variant } : undefined
  })
  const headerContext = createMemo(() => contextPercent(headerTelemetry()))
  const headerCost = () => {
    const cost = headerSession()?.cost ?? 0
    return cost > 0 ? formatUSD(cost, language.locale()) : undefined
  }
  // "opencode  ~/WebstormProjects" reads better than repeating the project
  // folder at the end of its own path.
  const pathParent = () => {
    const path = props.data.path
    if (!path) return undefined
    const name = props.data.projectName
    const trimmed = path.replace(/[\\/]+$/, "")
    const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
    const base = cut >= 0 ? trimmed.slice(cut + 1) : trimmed
    if (name && base === name && cut > 0) return trimmed.slice(0, cut)
    return trimmed
  }
  const headerProjectName = () => props.data.projectName
  const hasHeaderStats = () =>
    headerStatus() !== "idle" ||
    !!headerSession()?.time?.updated ||
    !!headerModel() ||
    headerContext() !== undefined ||
    !!headerCost()

  return (
    <div
      ref={(el) => {
        rootEl = el
        props.rootRef?.(el)
      }}
      data-component="session-preview-card"
      data-interactive={interactive() || undefined}
      data-preview-total={visibleRows().length}
      data-preview-mounted={virtualRows().length}
      style={props.maxHeight?.() !== undefined ? { "max-height": `${props.maxHeight!()}px` } : undefined}
    >
      {/* ---- Header: what this session/group is ---- */}
      <div data-slot="head">
        <div data-slot="head-row">
          <span data-slot="head-icon">
            <Show
              when={!isGroupTab()}
              fallback={<IconV2 name="layers" size="small" class="size-3.5 text-v2-icon-icon-muted" />}
            >
              <ProjectAvatar
                fallback={headerProjectName() ?? displayName({ worktree: props.data.directory ?? "" })}
                src={getProjectAvatarSource(props.data.project?.id, props.data.project?.icon)}
                variant={getProjectAvatarVariant(props.data.project?.icon?.color)}
              />
            </Show>
          </span>
          <span data-slot="head-title" dir="auto">
            {props.data.title}
          </span>
          <Show when={isGroupTab() && totalCount() > 0}>
            <span data-slot="count">{totalCount()}</span>
          </Show>
        </div>

        <Show when={!isGroupTab() && (headerProjectName() || pathParent() || props.data.serverName)}>
          <div data-slot="head-meta" title={props.data.path}>
            <Show when={headerProjectName()}>
              <span data-slot="head-project">{headerProjectName()}</span>
            </Show>
            <Show when={pathParent()}>
              <span data-slot="head-path" dir="rtl">
                <bdi dir="ltr">{pathParent()}</bdi>
              </span>
            </Show>
            <Show when={props.data.branch}>
              <span data-slot="chip">
                <IconV2 name="branch" size="small" class="size-2.5 shrink-0" />
                <span class="truncate">{props.data.branch}</span>
              </span>
            </Show>
            <Show when={props.data.serverName}>
              <span data-slot="chip">
                <IconV2 name="monitor" size="small" class="size-2.5 shrink-0" />
                <span class="truncate">{props.data.serverName}</span>
              </span>
            </Show>
          </div>
        </Show>

        <Show when={!isGroupTab() && hasHeaderStats()}>
          <div data-slot="head-stats">
            <Switch
              fallback={
                <Show when={relative(headerSession()?.time?.updated)}>
                  {(label) => (
                    <span data-slot="stat" data-tone="faint">
                      <IconV2 name="clock" size="small" class="size-2.5 shrink-0" />
                      {label()}
                    </span>
                  )}
                </Show>
              }
            >
              <Match when={headerStatus() === "waiting"}>
                <span data-slot="status-pill" data-status="waiting">
                  <IconV2 name="hourglass" size="small" class="size-2.5" />
                  {language.t("groupTab.state.waiting")}
                </span>
              </Match>
              <Match when={headerStatus() === "working"}>
                <span data-slot="status-pill" data-status="working">
                  <Spinner class="size-2.5" />
                  {phaseLabel(headerTelemetry())}
                  <Show when={turnElapsed(headerSessionID(), headerTelemetry())}>
                    {(elapsed) => <span data-slot="status-time">{elapsed()}</span>}
                  </Show>
                </span>
              </Match>
              <Match when={headerStatus() === "paused"}>
                <span data-slot="status-pill" data-status="paused">
                  <IconV2 name="pause" size="small" class="size-2.5" />
                  {language.t("tab.state.paused")}
                </span>
              </Match>
            </Switch>
            <Show when={headerModel()}>
              {(model) => (
                <span data-slot="stat" data-grow title={model().label}>
                  <span class="truncate">{model().label}</span>
                  <Show when={model().variant}>{(variant) => <span data-slot="stat-dim">{variant()}</span>}</Show>
                </span>
              )}
            </Show>
            <Show when={headerContext()}>
              {(percent) => (
                <span data-slot="stat" data-tone={contextTone(percent())} title={language.t("chats.metric.context")}>
                  <span data-slot="meter">
                    <span style={{ width: `${Math.max(4, percent())}%` }} />
                  </span>
                  {percent()}%
                </span>
              )}
            </Show>
            <Show when={headerCost()}>{(cost) => <span data-slot="stat">{cost()}</span>}</Show>
          </div>
        </Show>
      </div>

      {/* ---- Relationships: sessions structurally tied to this one ---- */}
      <Show when={totalCount() > 0}>
        <div data-slot="section" role="group" aria-label={language.t("groupTab.switchSessions")}>
          <div data-slot="section-head">
            <IconV2 name="layers" size="small" class="size-3 shrink-0" />
            <span data-slot="section-label">{language.t("groupTab.switchSessions")}</span>
            <span data-slot="count">{totalCount()}</span>
            <Show when={openableCount() > 0}>
              <button
                type="button"
                data-slot="open-all"
                title={language.t("groupTab.openAllInBackground", { count: openableCount() })}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  openAllSessions()
                }}
              >
                <IconV2 name="outline-square-arrow" size="small" class="size-3 shrink-0" />
                {language.t("groupTab.openAll")}
                <span data-slot="count">{openableCount()}</span>
              </button>
            </Show>
            <span data-slot="section-summary">
              <Show when={summary().waiting > 0}>
                <span data-tone="warning">
                  <i aria-hidden="true" />
                  {language.plural("groupTab.summary.waiting", summary().waiting)}
                </span>
              </Show>
              <Show when={summary().running > 0}>
                <span data-tone="accent">
                  <i aria-hidden="true" />
                  {language.plural("groupTab.summary.running", summary().running)}
                </span>
              </Show>
            </span>
          </div>

          <ScrollView
            data-slot="section-scroll"
            class="[&_.scroll-view__viewport]:overscroll-contain"
            viewportRef={setScrollRoot}
          >
            <div data-slot="members-shell">
              <div data-slot="members" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                <For each={virtualRows()}>
                  {(entry) => {
                    const item = entry.item
                    if (!item) return null
                    const virtualRow = entry.virtualRow
                  const row = item.row
                  const member = row.row
                  const session = () => peek(member.id) ?? member.session
                  const title = () => peek(member.id)?.title ?? member.title
                  const current = () => props.currentSessionID === member.id
                  const state = () => status(member.id)
                  const pending = () => attention(member.id)
                  const live = () => telemetry(member.id)
                  // Only call out a row's project when it differs from the
                  // header's own; otherwise it is the same word repeated.
                  const foreignProject = () => {
                    const label = projectLabel(session())
                    return label && label !== headerProjectName() ? label : undefined
                  }
                  const isSpecial = () => item.sectionKind === "special"

                  const button = (
                    <button
                      type="button"
                      data-slot="member"
                      data-preview-index={virtualRow.index}
                      data-special={isSpecial() || undefined}
                      data-current={current() || undefined}
                      data-open-tab={openSessionIDs().has(member.id) || undefined}
                      data-status={state()}
                      aria-current={current() ? "page" : undefined}
                      title={title()}
                      style={{ "--depth": String(row.depth) }}
                      onFocus={() => setFocusedIndex(virtualRow.index)}
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
                      onContextMenu={() => ensureMenuSession(member.id, member.session)}
                      onKeyDown={moveFocus}
                    >
                      <Show when={!isSpecial()}>
                        <Index each={Array.from({ length: row.depth })}>
                          {(_, level) => (
                            <span
                              data-slot="guide"
                              data-elbow={level === row.depth - 1 || undefined}
                              data-last={(level === row.depth - 1 && row.last) || undefined}
                              style={{ "--level": String(level) }}
                              aria-hidden="true"
                            />
                          )}
                        </Index>
                      </Show>
                      <span data-slot="member-state" aria-hidden="true">
                        <Switch fallback={<i data-slot="dot" />}>
                          <Match when={state() === "working"}>
                            <Spinner class="size-3" />
                          </Match>
                          <Match when={state() === "paused"}>
                            <IconV2 name="pause" size="small" class="size-3" />
                          </Match>
                        </Switch>
                      </span>
                      <span data-slot="member-title" dir="auto">
                        {title()}
                      </span>
                      <Show when={isSpecial()}>
                        <span data-slot="chip" data-tone="special" data-slim>
                          {specialAgentLabel(member.specialAgent)}
                        </span>
                      </Show>
                      <Show when={item.parentTitle}>
                        {(title) => (
                          <span data-slot="chip" data-slim>
                            {language.t("sessionPreview.specialAgent.via", { title: title() })}
                          </span>
                        )}
                      </Show>
                      <Show when={member.group}>
                        {(label) => (
                          <span data-slot="chip" data-slim>
                            {label()}
                          </span>
                        )}
                      </Show>
                      <Show when={foreignProject()}>
                        {(label) => (
                          <span data-slot="chip" data-slim>
                            {label()}
                          </span>
                        )}
                      </Show>
                      <Show when={pending().permissions > 0}>
                        <span data-slot="badge" data-tone="warning" aria-label={language.t("chats.badge.permission")}>
                          <IconV2 name="shield" size="small" class="size-2.5" />
                          {pending().permissions}
                        </span>
                      </Show>
                      <Show when={pending().questions > 0}>
                        <span data-slot="badge" data-tone="info" aria-label={language.t("chats.badge.question")}>
                          <IconV2 name="help" size="small" class="size-2.5" />
                          {pending().questions}
                        </span>
                      </Show>
                      <span data-slot="member-trail">
                        <Switch fallback={<span>{relative(peek(member.id)?.time?.updated ?? member.updated)}</span>}>
                          <Match when={state() === "working"}>
                            <span data-tone="accent">
                              {phaseLabel(live())}
                              <Show when={turnElapsed(member.id, live())}>{(elapsed) => <b>{elapsed()}</b>}</Show>
                            </span>
                          </Match>
                          <Match when={state() === "waiting"}>
                            <span data-tone="warning">{language.t("groupTab.state.waiting")}</span>
                          </Match>
                          <Match when={state() === "paused"}>
                            <span>{language.t("tab.state.paused")}</span>
                          </Match>
                        </Switch>
                      </span>
                    </button>
                  )

                  const wrapped = (
                    <Show when={props.server} fallback={button}>
                      {(server) => (
                        <TitlebarTabContextMenu
                          id={memberTabID(member.id)}
                          session={session}
                          server={server()}
                          onOpenChange={props.onRowContextMenuOpenChange}
                        >
                          {button}
                        </TitlebarTabContextMenu>
                      )}
                    </Show>
                  )

                    return (
                      <div
                        ref={measureVirtualRow(virtualizer, virtualRow.index)}
                        data-slot="virtual-member"
                        data-index={virtualRow.index}
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      >
                      <Show when={item.first}>
                        <div data-slot="section-divider" data-tone={isSpecial() ? "special" : undefined}>
                          <IconV2 name={sectionIcon(item.sectionKind)} size="small" class="size-3 shrink-0" />
                          <span data-slot="section-divider-label">{item.sectionName}</span>
                          <span data-slot="count">{item.sectionCount}</span>
                        </div>
                      </Show>
                      {wrapped}
                      </div>
                    )
                  }}
                </For>
              </div>
              <Show when={hiddenCount() > 0}>
                <button type="button" data-slot="more" onClick={showMore}>
                  <IconV2 name="chevron-down" size="small" class="size-3" />
                  {language.t("common.loadMore")}
                  <span data-slot="count">{Math.min(GROUP_PREVIEW_PAGE, hiddenCount())}</span>
                </button>
              </Show>
            </div>
          </ScrollView>
        </div>

        <div data-slot="foot">
          <span data-slot="foot-pointer">
            {language.t("groupTab.hint.pointer", { mod: IS_MAC ? "⌘" : language.t("common.key.ctrl") })}
          </span>
          <span data-slot="foot-keys">
            <KeybindV2 keys={["↑", "↓"]} />
            <span>{language.t("groupTab.hint.navigate")}</span>
            <KeybindV2 keys={["↵"]} />
            <span>{language.t("groupTab.hint.open")}</span>
            <KeybindV2 keys={[IS_MAC ? "⌘" : language.t("common.key.ctrl"), "↵"]} />
            <span>{language.t("groupTab.hint.background")}</span>
          </span>
        </div>
      </Show>
    </div>
  )
}

export { KNOWN_SPECIAL_AGENT_KINDS }
export type { SessionPreviewRow }
