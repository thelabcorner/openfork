import type { ServerConnection } from "@/context/server"
import type { useLanguage } from "@/context/language"
import type { HomeSearchHit, HomeSessionSearchController } from "@/pages/home/home-session-search-controller"
import type { HomeSessionRecord, OpenSessionOptions } from "@/pages/home/home-session-types"
import {
  HomeSessionLeadingController,
  HomeSessionProjectName,
  HomeSessionTitle,
  isBackgroundOpen,
} from "@/pages/home/home-rows"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import { measureVirtualRow } from "@/components/virtual-scroll-element"
import { indexChatSidebarSearchHits } from "./chat-sidebar-search-index"

type Language = ReturnType<typeof useLanguage>

export function ChatSidebarSearchResults(props: {
  language: Language
  search: HomeSessionSearchController
  server: Accessor<ServerConnection.Key>
  isOpenTab: (record: HomeSessionRecord) => boolean
}) {
  const [scrollRoot, setScrollRoot] = createSignal<HTMLDivElement>()
  const hitPositions = createMemo(() => indexChatSidebarSearchHits(props.search.result.list()))
  const activeIndex = createMemo(() => {
    const key = props.search.result.active()
    if (!key) return -1
    return hitPositions().get(key) ?? -1
  })
  const searchItemKey = (index: number) => props.search.result.list()[index]?.key ?? index
  const searchRangeExtractor = (range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range)
    const active = activeIndex()
    if (active >= 0 && active < range.count && !indexes.includes(active)) indexes.push(active)
    return indexes.sort((a, b) => a - b)
  }
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.search.result.list().length
    },
    getScrollElement: () => scrollRoot() ?? null,
    initialRect: { width: 320, height: 420 },
    get estimateSize() {
      const rows = props.search.result.list()
      return (index: number) => {
        const hit = rows[index]
        const previous = index > 0 ? rows[index - 1] : undefined
        const startsGroup = !!hit && (!previous || previous.kind !== hit.kind)
        return 36 + (startsGroup ? 32 : 0)
      }
    },
    overscan: 6,
    getItemKey: searchItemKey,
    rangeExtractor: searchRangeExtractor,
  })
  const virtualRows = createMemo<
    Array<{
      virtualRow: ReturnType<typeof virtualizer.getVirtualItems>[number]
      hit: HomeSearchHit | undefined
      key: string | number
    }>
  >((previous = []) => {
    const prior = new Map(previous.map((entry) => [entry.key, entry] as const))
    const rows = props.search.result.list()
    return virtualizer.getVirtualItems().map((virtualRow) => {
      const hit = rows[virtualRow.index]
      const key = hit?.key ?? virtualRow.index
      const existing = prior.get(key)
      if (
        existing &&
        existing.hit === hit &&
        existing.virtualRow.index === virtualRow.index &&
        existing.virtualRow.start === virtualRow.start &&
        existing.virtualRow.size === virtualRow.size
      ) {
        return existing
      }
      return { virtualRow, hit, key }
    })
  })
  // Rapid selection changes (keyboard repeat, filter replacement) should
  // scroll once per microtask, to the LATEST active hit. Otherwise every
  // intermediate selection triggers a virtualizer measurement/scroll pass.
  let scrollQueued = false
  let pendingScrollIndex = -1
  let disposed = false
  onCleanup(() => {
    disposed = true
    pendingScrollIndex = -1
  })
  createEffect(() => {
    const index = activeIndex()
    pendingScrollIndex = index >= 0 && scrollRoot() ? index : -1
    if (pendingScrollIndex < 0 || scrollQueued) return
    scrollQueued = true
    queueMicrotask(() => {
      scrollQueued = false
      if (disposed || pendingScrollIndex < 0) return
      virtualizer.scrollToIndex(pendingScrollIndex, { align: "auto" })
    })
  })

  return (
    <div id="chats-session-search-results" role="listbox" class="flex flex-col pt-1">
      <Show when={!props.search.result.loading()} fallback={<ChatsSearchLoading language={props.language} />}>
        <Show
          when={!props.search.result.error()}
          fallback={<ChatsSearchError language={props.language} detail={props.search.result.error()} />}
        >
          <Show
            when={props.search.result.list().length > 0}
            fallback={
              <p class="my-1 px-3 pb-2 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                {props.search.result.noResultsLabel()}
              </p>
            }
          >
            <ScrollView
              class="max-h-[min(420px,50vh)]"
              viewportRef={(element) => {
                setScrollRoot(element)
                props.search.element.setList(element)
              }}
            >
              <div class="relative pb-1" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                <For each={virtualRows()}>
                  {(entry) => {
                    const hit = entry.hit
                    if (!hit) return null
                    const index = entry.virtualRow.index
                    const previous = index > 0 ? props.search.result.list()[index - 1] : undefined
                    return (
                      <div
                        ref={measureVirtualRow(virtualizer, index)}
                        data-index={index}
                        class="absolute inset-x-0 top-0"
                        style={{ transform: `translateY(${entry.virtualRow.start}px)` }}
                      >
                        <Show when={hit.kind === "session" && (!previous || previous.kind !== "session")}>
                          <ChatsSearchGroupHeader
                            label={props.language.t("home.sessions.search.sessions")}
                            count={props.search.result.sessions().length}
                            countLabel={props.language.plural(
                              "home.sessions.search.sessionsResult",
                              props.search.result.sessions().length,
                            )}
                          />
                        </Show>
                        <Show when={hit.kind === "message" && (!previous || previous.kind !== "message")}>
                          <ChatsSearchGroupHeader
                            label={props.language.t("home.sessions.search.messages")}
                            count={props.search.result.messages().length}
                            countLabel={props.language.plural(
                              "home.sessions.search.messagesResult",
                              props.search.result.messages().length,
                            )}
                          />
                        </Show>
                        <Show
                          when={hit.kind === "session"}
                          fallback={
                            hit.kind === "message" ? (
                              <ChatsSearchMessageRow
                                language={props.language}
                                hit={hit}
                                selected={props.search.result.active() === hit.key}
                                server={props.server}
                                isOpenTab={props.isOpenTab}
                                onHighlight={props.search.result.highlight}
                                onSelect={props.search.result.select}
                              />
                            ) : null
                          }
                        >
                          <ChatsSearchRow
                            hit={hit}
                            selected={props.search.result.active() === hit.key}
                            server={props.server}
                            isOpenTab={props.isOpenTab}
                            onHighlight={props.search.result.highlight}
                            onSelect={props.search.result.select}
                          />
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </ScrollView>
            <ChatsSearchHints language={props.language} />
          </Show>
        </Show>
      </Show>
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

function ChatsSearchHints(props: { language: Language }) {
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

function ChatsSearchLoading(props: { language: Language }) {
  return (
    <div class="flex flex-col gap-px px-3 py-2" aria-busy="true" aria-label={props.language.t("common.loading")}>
      <For each={[0, 1, 2]}>{() => <div class="h-7 rounded-[6px] bg-v2-background-bg-layer-02 animate-pulse" />}</For>
    </div>
  )
}

function ChatsSearchError(props: { language: Language; detail?: string }) {
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
    language: Language
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
