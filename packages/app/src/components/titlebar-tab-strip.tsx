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
import { ServerConnection } from "@/context/server"
import { DraftTabItem, GroupTabNavItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { TitlebarTabContextMenu } from "@/components/titlebar-tab-context-menu"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useTabs } from "@/context/tabs"
import { createTabPromptState } from "@/context/prompt"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { showToast } from "@/utils/toast"
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
  onVisibleChange: (visible: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sdk = createMemo(() => props.serverCtx()?.sdk ?? null)
  const cachedSession = createMemo(() => props.serverCtx()?.sync.session.peek(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])
  const [loadedSession] = createResource(
    () => {
      if (!props.active()) return null
      const ctx = props.serverCtx()
      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id).catch(() => undefined),
  )
  const session = createMemo(() => cachedSession() ?? loadedSession())
  const missingSession = createMemo(() => !!props.serverCtx() && !loadedSession.loading && !session())
  const visible = createMemo(() => !!session() || missingSession() || !!persisted()?.title)
  let prefetched = false
  let hoverPrefetchStarted = false

  const prefetch = () => {
    if (props.active() || hoverPrefetchStarted) return
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value) return
    hoverPrefetchStarted = true
    void ctx.sync.ensureDirSyncContext(value.directory).session.prefetch(value.id, 20).catch(() => {})
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
    if (!props.active()) return
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value || prefetched) return
    prefetched = true
    // Runs in this component's own owner (disposed with the tab) instead of a
    // throw-away createRoot: sync() can register cleanups after an async gap,
    // which a root disposed eagerly on settle can't attach — that mismatch was
    // logged as "cleanups created outside a createRoot or render will never be
    // run" and leaked reactive state for every tab visited in a session.
    void ctx.sync.ensureDirSyncContext(value.directory).session.sync(value.id).catch(() => {})
  })

  createEffect(() => {
    const value = session()
    if (!value) return
    tabs.rememberSessionInfo(props.tab, value)
    const current = sdk()
    if (!current) return
    createTabPromptState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.directory),
      id: value.id,
    })
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
  sessionCount: number
  sessions?: { title: string; project?: string }[]
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

  const title = createMemo(() => {
    const key = tabKey(props.tab)
    return tabs.info[key]?.title ?? language.t("sessionGroup.name.placeholder")
  })

  const sessionCount = createMemo(() => 0)
  const sessions = createMemo(() => undefined as { title: string; project?: string }[] | undefined)

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

  createResizeObserver(
    () => [scrollRef, listRef],
    () => {
      if (resizeFrame !== undefined) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        refreshOverflow()
      })
    },
  )

  onMount(() => {
    refreshOverflow()
  })

  onCleanup(() => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
  })

  createEffect(() => {
    props.tabs.length
    visibleTabIds()
    refreshOverflow()
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
                  if (tab.type !== "session") return
                  const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
                  if (conn) return global.ensureServerCtx(conn)
                })

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
