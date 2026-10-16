import { createEffect, createMemo, createResource, createSignal, For, lazy, on, onCleanup, onMount, Show, Suspense } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabHref, tabKey, type AppTab, type GroupTab, type SessionTab, type Tab } from "@/context/tabs"
import { ServerConnection, serverName } from "@/context/server"
import { AppTabItem, DraftTabItem, GroupTabNavItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { TitlebarTabContextMenu } from "@/components/titlebar-tab-context-menu"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { useSessionGroups } from "@/context/session-groups"
import { useOxpActivity } from "@/context/oxp-activity"
import { oxpActivityIDFromHref } from "@/context/app-tabs"
import { canStartTabDrag, isTabActionTarget } from "./titlebar-tab-gesture"
import { adjacentTabKey, mergeVisibleTabOrder, projectTabOrder, staleTabVisibilityKeys } from "./titlebar-tab-order"
import { trackTabStripVisibility } from "./titlebar-tab-visibility"
import { indexTabServerContexts } from "./titlebar-tab-servers"
import { createTabPreviewController } from "./titlebar-tab-preview-controller"

const SharedTabPreview = lazy(() =>
  import("./titlebar-tab-popover").then((module) => ({ default: module.TabPreviewPopover })),
)
import type { Session } from "@opencode-ai/sdk/v2"

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  pending: boolean
  session: () => Session | undefined
  serverCtx: () => ServerCtx | undefined
  serverLabel: () => string | undefined
  fallbackTitle?: string
  onRename: (title: string) => Promise<void>
  onPrefetch: () => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex min-w-0 max-w-56 flex-1 flex-shrink"
      onPointerEnter={props.onPrefetch}
    >
      <TitlebarTabContextMenu id={props.id} session={props.session} server={props.tab.server}>
        <TabNavItem
          ref={(el) => {
            ref = el
          }}
          href={tabHref(props.tab)}
          server={props.tab.server}
          serverCtx={props.serverCtx}
          serverLabel={props.serverLabel}
          session={props.session}
          fallbackTitle={props.fallbackTitle}
          onRename={props.onRename}
          onNavigate={() => props.onNavigate(ref)}
          onClose={props.onClose}
          active={props.active()}
          forceTruncate={props.forceTruncate}
          pending={props.pending}
          dragging={sortable.isDragSource()}
        />
      </TitlebarTabContextMenu>
    </div>
  )
}

function SessionTabEntry(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  pending: boolean
  serverCtx: () => ServerCtx | undefined
  serverLabel: () => string | undefined
  onVisibleChange: (visible: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const cachedSession = createMemo(() => props.serverCtx()?.sync.session.peek(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])
  const [loadedSession] = createResource(
    () => {
      if (!props.active()) return null
      const ctx = props.serverCtx()
      // The shared session store is authoritative. A warm tab revisit should
      // not schedule a resource/promise lifecycle just to resolve an already
      // available session. On cache eviction, the missing active tab still
      // resolves at critical priority exactly as before.
      return ctx && !cachedSession() ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id, { priority: "critical" }).catch(() => undefined),
  )
  const session = createMemo(() => cachedSession() ?? loadedSession())
  const missingSession = createMemo(() => !!props.serverCtx() && !loadedSession.loading && !session())
  const visible = createMemo(() => !!session() || missingSession() || !!persisted()?.title)
  let hoverPrefetchStarted = false

  const prefetch = () => {
    if (props.active() || hoverPrefetchStarted) return
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value) return
    hoverPrefetchStarted = true
    // Session message hydration is server-scoped and keyed by session ID. The
    // directory sync facade's prefetch method is only a pass-through to this
    // store, so constructing/refcounting a directory context on every tab hover
    // was pure allocation/client churn.
    void ctx.sync.session.prefetch(value.id, 20).catch(() => {})
  }

  const rename = async (title: string) => {
    const value = session()
    const ctx = props.serverCtx()
    if (!value || !ctx) return

    ctx.sync.session.remember({ ...value, title })
    try {
      await ctx.sdk.api.session.rename({ sessionID: value.id, title })
    } catch (err) {
      const current = session()
      const currentCtx = props.serverCtx()
      if (current && currentCtx) currentCtx.sync.session.remember({ ...current, title: value.title })
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  createEffect(() => props.onVisibleChange(visible()))

  createEffect(() => {
    const value = session()
    if (!value) return
    tabs.rememberSessionInfo(props.tab, value)
  })

  return (
    <Show when={visible()}>
      <SessionTabSlot
        tab={props.tab}
        id={props.id}
        index={props.index}
        active={props.active}
        forceTruncate={props.forceTruncate}
        pending={props.pending}
        session={session}
        serverCtx={props.serverCtx}
        serverLabel={props.serverLabel}
        fallbackTitle={persisted()?.title ?? (missingSession() ? language.t("session.tab.unknown") : undefined)}
        onRename={rename}
        onPrefetch={prefetch}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
      />
    </Show>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: () => number
  active: () => boolean
  pending: boolean
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex min-w-0 max-w-56 flex-1 flex-shrink"
    >
      <TitlebarTabContextMenu id={props.id}>
        <DraftTabItem
          ref={(el) => {
            ref = el
          }}
          href={tabHref(props.tab)}
          title={props.title}
          onNavigate={() => props.onNavigate(ref)}
          onClose={props.onClose}
          active={props.active()}
          pending={props.pending}
          dragging={sortable.isDragSource()}
        />
      </TitlebarTabContextMenu>
    </div>
  )
}

function AppTabSlot(props: {
  tab: AppTab
  id: string
  index: () => number
  active: () => boolean
  pending: boolean
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex min-w-0 max-w-56 flex-1 flex-shrink"
    >
      <TitlebarTabContextMenu id={props.id}>
        <AppTabItem
          ref={(el) => {
            ref = el
          }}
          href={tabHref(props.tab)}
          page={props.tab.page}
          title={props.title}
          onNavigate={() => props.onNavigate(ref)}
          onClose={props.onClose}
          active={props.active()}
          pending={props.pending}
          dragging={sortable.isDragSource()}
        />
      </TitlebarTabContextMenu>
    </div>
  )
}

function GroupTabSlot(props: {
  tab: GroupTab
  id: string
  index: () => number
  active: () => boolean
  pending: boolean
  title: string
  sessionCount?: number
  serverCtx: () => ServerCtx | undefined
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex min-w-0 max-w-56 flex-1 flex-shrink"
    >
      <TitlebarTabContextMenu id={props.id} isGroup groupId={props.tab.groupId} server={props.tab.server}>
        <GroupTabNavItem
          ref={(el) => {
            ref = el
          }}
          href={tabHref(props.tab)}
          tab={props.tab}
          title={props.title}
          sessionCount={props.sessionCount}
          serverCtx={props.serverCtx}
          onNavigate={() => props.onNavigate(ref)}
          onClose={props.onClose}
          active={props.active()}
          pending={props.pending}
          dragging={sortable.isDragSource()}
        />
      </TitlebarTabContextMenu>
    </div>
  )
}

function GroupTabEntry(props: {
  tab: GroupTab
  id: string
  index: () => number
  active: () => boolean
  pending: boolean
  serverCtx: () => ServerCtx | undefined
  onVisibleChange: (visible: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sessionGroups = useSessionGroups()

  const group = createMemo(() => sessionGroups.byID(props.tab.groupId))

  const title = createMemo(() => {
    const key = tabKey(props.tab)
    return group()?.name ?? tabs.info[key]?.title ?? language.t("sessionGroup.name.placeholder")
  })

  // Membership-empty groups are invalid at the data layer. An unresolved group
  // tab is therefore loading, not a real "0 sessions" group; keep the count
  // absent until detail hydration completes instead of flashing misleading 0.
  // The cheap sessionIds array (already populated by the batched detail
  // fetch) is enough for this visible badge — no row projection needed.
  const sessionCount = createMemo(() => group()?.sessionIds.length)

  createEffect(() => props.onVisibleChange(true))

  return (
    <GroupTabSlot
      tab={props.tab}
      id={props.id}
      index={props.index}
      active={props.active}
      pending={props.pending}
      title={title()}
      sessionCount={sessionCount()}
      serverCtx={props.serverCtx}
      onNavigate={props.onNavigate}
      onClose={props.onClose}
    />
  )
}

export function TitlebarTabStrip(props: {
  tabs: Tab[]
  currentTab: () => Tab | undefined
  forceTruncate: boolean
  pendingTabKey?: () => string | null
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
  onOverflowChange: (overflowing: boolean) => void
}) {
  const global = useGlobal()
  const language = useLanguage()
  const oxpActivity = useOxpActivity()
  const tabs = useTabs()
  const command = useCommand()
  let scrollRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  // Exactly one intent controller for the entire tab strip, not one per tab.
  const preview = createTabPreviewController()
  const [previewRequested, setPreviewRequested] = createSignal(false)
  createEffect(() => {
    if (preview.current()) setPreviewRequested(true)
  })
  let resizeFrame: number | undefined
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  // A window can open/close thousands of tabs without remounting this strip.
  // Prune only when the tab collection changes, not on session/status updates.
  createEffect(on(
    () => props.tabs.map(tabKey),
    (keys) => {
      const stale = staleTabVisibilityKeys(visibility, keys)
      if (!stale.length) return
      setVisibility(produce((state) => {
        for (const key of stale) delete state[key]
      }))
    },
  ))
  const tabOrder = createMemo(() =>
    projectTabOrder(props.tabs, tabKey, (tab, key) => tab.type === "draft" || tab.type === "app" || !!visibility[key]),
  )
  const visibleTabs = () => tabOrder().visible
  const visibleTabIds = () => tabOrder().ids
  const visibleIndexMap = () => tabOrder().index
  const serverConnections = createMemo(() => {
    const map = new Map<ServerConnection.Key, ReturnType<typeof global.servers.list>[number]>()
    for (const connection of global.servers.list()) map.set(ServerConnection.key(connection), connection)
    return map
  })
  const serverContexts = createMemo(() =>
    indexTabServerContexts(props.tabs, serverConnections(), (connection) => global.ensureServerCtx(connection)),
  )
  const multipleServers = createMemo(() => serverConnections().size > 1)

  // Delegation avoids reactive owners, timers, portals and pointer wrappers on
  // every tab. The inspector resolves data only after a completed hover dwell.
  const tabAnchor = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>("[data-titlebar-tab]") : null
  const hoverTab = (event: PointerEvent) => {
    if (event.pointerType === "touch") return
    const anchor = tabAnchor(event.target)
    if (!anchor || !listRef.contains(anchor)) return
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return
    if (isTabActionTarget(event.target)) return
    if (anchor.dataset.dragging === "true" || anchor.dataset.editing === "true") return
    const key = anchor.closest<HTMLElement>("[data-titlebar-tab-slot]")?.dataset.tabKey
    const tab = key ? tabOrder().byKey.get(key) : undefined
    if (!tab || (tab.type !== "session" && tab.type !== "group")) return
    const ctx = () => serverContexts().get(tab.server)
    preview.hover({
      anchor,
      tab,
      serverCtx: ctx,
      serverLabel: () => {
        if (!multipleServers()) return
        const conn = serverConnections().get(tab.server)
        return conn ? serverName(conn) : undefined
      },
    })
  }
  const leaveTab = (event: PointerEvent) => {
    const anchor = tabAnchor(event.target)
    if (!anchor || (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) return
    preview.leave(anchor)
  }
  const previewVisible = createMemo(() => !!preview.current())
  createEffect(() => {
    if (!previewVisible()) return
    // Electron/Windows may omit pointerleave as the mouse leaves the OS window.
    // Install global dismissal only during a visible preview: no idle listeners.
    const onBlur = () => preview.close(true)
    const onVisibility = () => {
      if (document.hidden) preview.close(true)
    }
    window.addEventListener("blur", onBlur)
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => {
      window.removeEventListener("blur", onBlur)
      document.removeEventListener("visibilitychange", onVisibility)
    })
  })
  createEffect(() => {
    const active = preview.current()
    if (!active) return
    const key = tabKey(active.tab)
    if (!tabOrder().byKey.has(key) || !visibleIndexMap().has(key) || !active.anchor.isConnected)
      preview.close(true)
  })

  command.register("titlebar-tab-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
  ])

  // Consolidated single registration for mod+1..9 (was per-tab useTabShortcut + repeated findIndex).
  // Reduces Solid subscriptions, command churn, and work on strip re-renders/inactive tabs.
  command.register("titlebar-tab-numbers", () => {
    const vtabs = visibleTabs()
    return vtabs.slice(0, 9).map((tab, i) => {
      const number = i + 1
      return {
        id: `tab.${number}`,
        category: "tab",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect: () => props.onNavigate(tab),
      }
    })
  })

  function selectAdjacentTab(offset: -1 | 1) {
    const current = props.currentTab()
    const key = adjacentTabKey(visibleTabIds(), current ? tabKey(current) : undefined, offset)
    const next = key ? tabOrder().byKey.get(key) : undefined
    if (next) props.onNavigate(next)
  }

  function refreshOverflow() {
    if (!scrollRef) return
    props.onOverflowChange(scrollRef.scrollWidth > scrollRef.clientWidth)
  }
  const scheduleOverflow = () => {
    if (resizeFrame !== undefined) return
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = undefined
      refreshOverflow()
    })
  }

  createResizeObserver(
    () => [scrollRef, listRef],
    scheduleOverflow,
  )

  onMount(() => {
    scheduleOverflow()
    const stopVisibilityTracking = trackTabStripVisibility(scrollRef, listRef)
    // Capture without preventDefault: close/activate gestures must never be
    // swallowed by a hover component or nested stopPropagation handler.
    const dismiss = () => preview.close(true)
    scrollRef.addEventListener("pointerdown", dismiss, true)
    onCleanup(() => {
      scrollRef.removeEventListener("pointerdown", dismiss, true)
      stopVisibilityTracking()
    })
  })

  onCleanup(() => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
  })

  createEffect(() => {
    props.tabs.length
    visibleTabIds()
    scheduleOverflow()
  })

  return (
    <div data-slot="titlebar-tabs" class="relative min-w-0 flex-1 overflow-hidden">
      <div
        data-slot="titlebar-tabs-scroll"
        class="flex min-w-0 h-full flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
        ref={scrollRef}
        onScroll={() => preview.close(true)}
        onPointerOver={hoverTab}
        onPointerOut={leaveTab}
        onPointerCancel={() => preview.close(true)}
      >
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                !canStartTabDrag(event.pointerType) ||
                isTabActionTarget(event.target) ||
                (event.target instanceof Element && !!event.target.closest('[contenteditable="true"]')),
            }),
          ]}
          modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => listRef })]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragStart={(event) => {
            preview.close(true)
            const source = event.operation.source
            if (!source) return
            const tab = tabOrder().byKey.get(source.id.toString())
            if (!tab) return
            const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
            props.onNavigate(tab, tabEl ?? undefined)
          }}
          onDragEnd={(event) => {
            const current = visibleTabIds()
            const source = event.operation.source
            if (event.canceled || !isSortable(source)) return

            const { initialIndex, index } = source
            if (initialIndex !== index) {
              props.onReorder(
                mergeVisibleTabOrder(
                  tabOrder().allKeys,
                  current,
                  arrayMove(current, source.initialIndex, source.index),
                ),
              )
            }
          }}
        >
          <div data-titlebar-tab-list class="flex w-full min-w-0 flex-row items-center" ref={listRef}>
            <For each={props.tabs}>
              {(tab) => {
                const id = tabKey(tab)
                let ref!: HTMLDivElement
                const visibleIndex = () => visibleIndexMap().get(id) ?? -1
                const pending = () => props.pendingTabKey?.() === id
                // Keep each tab's equality-checked memo: a reorder rebuilds
                // the shared index but must not invalidate every downstream
                // session/status/avatar owner when its ServerCtx is unchanged.
                const serverCtx = createMemo(() =>
                  tab.type === "app" ? undefined : serverContexts().get(tab.server),
                )
                const serverLabel = () => {
                  if (tab.type === "app") return
                  if (!multipleServers()) return
                  const conn = serverConnections().get(tab.server)
                  return conn ? serverName(conn) : undefined
                }

                if (tab.type === "app") {
                  const activityID = tab.page === "oxp"
                    ? oxpActivityIDFromHref(tab.href)
                    : undefined
                  const oxpTitle = () => {
                    const summary = activityID ? oxpActivity.activity(activityID) : undefined
                    return summary?.title ?? summary?.lastRootAlias
                  }
                  // Persist the compact title projection, so inactive OXP tabs
                  // retain useful labels across restarts without forcing a
                  // transcript fetch (or one HTTP request per restored tab).
                  if (activityID) {
                    createEffect(() => {
                      const value = oxpTitle()
                      if (value) tabs.rememberAppTabTitle(tab, value)
                    })
                  }
                  const title = () => {
                    if (tab.page === "settings") return language.t("sidebar.settings")
                    if (tab.page === "usage") return language.t("usage.panel.title")
                    if (tab.page === "oxp") {
                      if (!activityID) return language.t("oxpActivity.tab.title")
                      return oxpTitle() ?? tabs.info[id]?.title ?? language.t("oxpActivity.untitled")
                    }
                    if (tab.page === "agents") return language.t("agents.title")
                    return language.t("scheduledTasks.title")
                  }
                  return (
                    <AppTabSlot
                      tab={tab}
                      id={id}
                      index={visibleIndex}
                      active={() => props.currentTab() === tab}
                      pending={pending()}
                      title={title()}
                      onNavigate={(element) => {
                        ref = element
                        props.onNavigate(tab, element)
                      }}
                      onClose={() => props.onClose(tab)}
                    />
                  )
                }

                if (tab.type === "session") {
                  return (
                    <SessionTabEntry
                      tab={tab}
                      id={id}
                      index={visibleIndex}
                      active={() => props.currentTab() === tab}
                      forceTruncate={props.forceTruncate}
                      pending={pending()}
                      serverCtx={serverCtx}
                      serverLabel={serverLabel}
                      onVisibleChange={(visible) => setVisibility(id, visible)}
                      onNavigate={(element) => {
                        ref = element
                        props.onNavigate(tab, element)
                      }}
                      onClose={() => props.onClose(tab)}
                    />
                  )
                }


                if (tab.type === "group") {
                  return (
                    <GroupTabEntry
                      tab={tab}
                      id={id}
                      index={visibleIndex}
                      active={() => props.currentTab() === tab}
                      pending={pending()}
                      serverCtx={serverCtx}
                      onVisibleChange={(visible) => setVisibility(id, visible)}
                      onNavigate={(element) => {
                        ref = element
                        props.onNavigate(tab, element)
                      }}
                      onClose={() => props.onClose(tab)}
                    />
                  )
                }

                return (
                  <DraftTabSlot
                    tab={tab}
                    id={id}
                    index={visibleIndex}
                    active={() => props.currentTab() === tab}
                    pending={pending()}
                    title={language.t("command.session.new")}
                    onNavigate={(element) => {
                      ref = element
                      props.onNavigate(tab, element)
                    }}
                    onClose={() => props.onClose(tab)}
                  />
                )
              }}
            </For>
          </div>
        </DragDropProvider>
      </div>
      <Show when={previewRequested()}>
        <Suspense>
          <SharedTabPreview
            intent={preview.current}
            onContentEnter={preview.contentEnter}
            onContentLeave={preview.contentLeave}
            onContextMenuOpenChange={preview.contextMenuOpenChange}
            onClose={() => preview.close(true)}
          />
        </Suspense>
      </Show>
      <div
        data-slot="titlebar-tabs-fade-left"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
      />
      <div
        data-slot="titlebar-tabs-fade-right"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
      />
    </div>
  )
}
