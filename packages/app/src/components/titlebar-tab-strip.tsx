import { createEffect, createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabHref, tabKey, type GroupTab, type SessionTab, type Tab } from "@/context/tabs"
import { ServerConnection, serverName } from "@/context/server"
import { DraftTabItem, GroupTabNavItem, TabNavItem } from "@/components/titlebar-tab-nav"
import type { TabPreviewGroupSession } from "@/components/titlebar-tab-popover"
import { TitlebarTabContextMenu } from "@/components/titlebar-tab-context-menu"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { useSessionGroups } from "@/context/session-groups"
import { groupedSessionsForTabPreview, indexTabPreviewMemberships } from "./titlebar-tab-group-preview"
import { canStartTabDrag, isTabActionTarget } from "./titlebar-tab-gesture"
import { adjacentTabKey, mergeVisibleTabOrder } from "./titlebar-tab-order"
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
  groupSessions: () => TabPreviewGroupSession[] | undefined
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
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
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
          groupSessions={props.groupSessions}
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
  groupSessions: () => TabPreviewGroupSession[] | undefined
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
      return ctx ? { id: props.tab.sessionId, ctx } : null
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
        groupSessions={props.groupSessions}
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
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
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

function GroupTabSlot(props: {
  tab: GroupTab
  id: string
  index: () => number
  active: () => boolean
  pending: boolean
  title: string
  sessionCount?: number
  sessions?: TabPreviewGroupSession[]
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
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
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
          sessions={props.sessions}
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

  const sessions = createMemo<TabPreviewGroupSession[] | undefined>(() =>
    group()?.sessions.map((session) => ({ id: session.id, title: session.title })),
  )
  // Membership-empty groups are invalid at the data layer. An unresolved group
  // tab is therefore loading, not a real "0 sessions" group; keep the count
  // absent until detail hydration completes instead of flashing misleading 0.
  const sessionCount = createMemo(() => sessions()?.length)

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
      sessions={sessions()}
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
  const command = useCommand()
  const sessionGroups = useSessionGroups()
  let scrollRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  let resizeFrame: number | undefined
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  const visibleTabs = createMemo(() => props.tabs.filter((tab) => tab.type === "draft" || visibility[tabKey(tab)]))
  const visibleTabIds = () => visibleTabs().map(tabKey)
  const visibleIndexMap = createMemo(() => {
    const map = new Map<string, number>()
    visibleTabs().forEach((tab, i) => map.set(tabKey(tab), i))
    return map
  })
  const serverConnections = createMemo(() => {
    const map = new Map<ServerConnection.Key, ReturnType<typeof global.servers.list>[number]>()
    for (const connection of global.servers.list()) map.set(ServerConnection.key(connection), connection)
    return map
  })
  const multipleServers = createMemo(() => serverConnections().size > 1)
  const previewMemberships = createMemo(() => indexTabPreviewMemberships(sessionGroups.list()))

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
    const next = props.tabs.find((tab) => tabKey(tab) === key)
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
    <div data-slot="titlebar-tabs" class="relative min-w-0">
      <div
        data-slot="titlebar-tabs-scroll"
        class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
        ref={scrollRef}
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
            const source = event.operation.source
            if (!source) return
            const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())
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
                  props.tabs.map(tabKey),
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
                const serverCtx = createMemo(() => {
                  const conn = serverConnections().get(tab.server)
                  if (conn) return global.ensureServerCtx(conn)
                })
                const serverLabel = () => {
                  if (!multipleServers()) return
                  const conn = serverConnections().get(tab.server)
                  return conn ? serverName(conn) : undefined
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
                      groupSessions={() =>
                        groupedSessionsForTabPreview(sessionGroups.list(), tab.sessionId, previewMemberships())
                      }
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
