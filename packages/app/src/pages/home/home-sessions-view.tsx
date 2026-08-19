import type { Session } from "@opencode-ai/sdk/v2/client"
import { type Accessor, createMemo, createSignal, For, Show, Suspense } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { SessionTabAvatarView } from "@/pages/layout/session-tab-avatar"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import { shouldOpenSessionInBackground } from "../home-session-open"
import {
  HomeSessionStatusController,
  type HomeSessionGroup,
  type HomeSessionRecord,
  type OpenSessionOptions,
} from "./home-sessions-controller"
import type { HomeSearchHit } from "./home-session-search-controller"
import type { SessionSearchMessageMatch } from "./home-session-search-response"
import { DialogSessionGroupName } from "@/components/dialog-session-group"

const SHOW_HOME_SESSION_ARCHIVE = false
const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"
const HOME_SESSION_SEARCH_RESULTS_ID = "home-session-search-results"

// Middle-click or Cmd+click on macOS (Ctrl+click elsewhere) opens a session
// tab in the background without navigating, matching browser conventions.
function isBackgroundOpen(event: MouseEvent) {
  return shouldOpenSessionInBackground({
    button: event.button,
    mac: typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  })
}

export type HomeSessionsViewProps = {
  language: ReturnType<typeof useLanguage>
  groups: Accessor<HomeSessionGroup[]>
  showProjectName: Accessor<boolean>
  server: Accessor<ServerConnection.Key>
  canCreateSession: Accessor<boolean>
  searchValue: Accessor<string>
  searchPlaceholder: Accessor<string>
  searchOpen: Accessor<boolean>
  searchLoading: Accessor<boolean>
  searchError: Accessor<string | undefined>
  searchSessions: Accessor<Session[]>
  searchMessages: Accessor<SessionSearchMessageMatch[]>
  searchResults: Accessor<HomeSearchHit[]>
  searchActive: Accessor<string>
  searchNoResultsLabel: Accessor<string>
  titleOpacity: (id: HomeSessionGroup["id"]) => number
  isOpenTab: (record: HomeSessionRecord) => boolean
  onCreateSession: () => void
  onOpenSession: (session: Session, options?: OpenSessionOptions) => void
  onArchiveSession: (session: Session) => Promise<void>
  onSetHoverTarget: (element: HTMLElement) => void
  onSetThumbTrack: (element: HTMLDivElement) => void
  onSetContent: (element: HTMLDivElement) => void
  onSetHeader: (id: HomeSessionGroup["id"], element: HTMLDivElement) => void
  onWheel: (event: WheelEvent) => void
  onSetSearchRoot: (element: HTMLDivElement) => void
  onSetSearchInput: (element: HTMLInputElement) => void
  onSetSearchList: (element: HTMLDivElement) => void
  onSearchFocus: () => void
  onSearchInput: (value: string) => void
  onSearchClose: () => void
  onSearchMove: (delta: number) => void
  onSearchSelectActive: () => void
  onSearchHighlight: (hit: HomeSearchHit) => void
  onSearchSelect: (hit: HomeSearchHit, options?: OpenSessionOptions) => void
  onCreateGroup: (name: string, sessionIds?: string[]) => Promise<string>
  onAddToGroup: (sessionId: string, groupId: string) => void
  onRemoveFromGroup: (sessionId: string) => void
  onRenameGroup: (groupId: string, name: string) => void
  onDeleteGroup: (groupId: string) => void
  onOpenGroupTab: (groupId: string) => void
  onGroupSelected: () => void
  selectedCount: Accessor<number>
  isSelected: (sessionId: string) => boolean
  onToggleSelection: (sessionId: string, event: MouseEvent) => void
  onClearSelection: () => void
  onToggleGroupCollapsed: (groupId: string) => void
  isGroupCollapsed: (groupId: string) => boolean
  groupForSession: (sessionId: string) => string | undefined
  userGroups: () => Array<{ id: string; name: string }>
}

export function HomeSessionsView(props: HomeSessionsViewProps) {
  return (
    <section
      ref={props.onSetHoverTarget}
      class="min-h-0 min-w-0 flex-1 flex flex-col"
      aria-label={props.language.t("sidebar.project.recentSessions")}
    >
      <div class="sticky top-0 z-30 shrink-0 bg-v2-background-bg-base pb-3 pt-6 lg:pt-12" onWheel={props.onWheel}>
        <HomeSessionSearch {...props} />
        <Show when={props.selectedCount() > 0}>
          <div class="mt-2 flex items-center gap-2 rounded-[8px] bg-v2-background-bg-layer-02 px-2 py-1.5">
            <span class="px-1 text-12-medium text-v2-text-text-base">
              {props.selectedCount()}
            </span>
            <ButtonV2
              variant="neutral"
              size="small"
              icon="layers"
              onClick={props.onGroupSelected}
            >
              {props.language.t("sessionGroup.addTo")}
            </ButtonV2>
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              icon={<IconV2 name="close" />}
              aria-label={props.language.t("common.cancel")}
              onClick={props.onClearSelection}
            />
          </div>
        </Show>
        <Suspense>
          <Show when={props.groups().length > 0 && props.canCreateSession()}>
            <div class="pointer-events-none absolute right-0 top-[84px] z-20 flex lg:top-[108px]">
              <ButtonV2
                data-action="home-new-session"
                variant="ghost-muted"
                size="normal"
                icon="edit"
                class="pointer-events-auto h-7 px-2 [font-weight:530]"
                onClick={props.onCreateSession}
              >
                {props.language.t("command.session.new")}
              </ButtonV2>
            </div>
          </Show>
        </Suspense>
      </div>
      <div class="pointer-events-none sticky top-[84px] z-40 h-0 -mr-3 lg:top-[108px]">
        <div
          ref={props.onSetThumbTrack}
          data-component="home-session-scroll-track"
          class="relative ml-auto h-[calc(100cqh-84px)] w-3 lg:h-[calc(100cqh-108px)]"
        />
      </div>
      <div class="-mr-3 min-h-[calc(100cqh-72px)] lg:min-h-[calc(100cqh-96px)]">
        <Suspense
          fallback={
            <div class="pt-3">
              <HomeSessionSkeleton label={props.language.t("common.loading")} />
            </div>
          }
        >
          <Show
            when={props.groups().length > 0}
            fallback={
              <HomeSessionsEmpty
                onNewSession={props.canCreateSession() ? props.onCreateSession : undefined}
                language={props.language}
              />
            }
          >
            <div ref={props.onSetContent} class="flex flex-col pt-3 pr-3 pb-16">
              <For each={props.groups()}>
                {(group, index) => (
                  <>
                    <Show
                      when={group.isUserGroup}
                      fallback={
                        <HomeSessionGroupHeader
                          title={group.title}
                          titleOpacity={props.titleOpacity(group.id)}
                          onSetRef={(element) => props.onSetHeader(group.id, element)}
                          elevated={index() === 0}
                        />
                      }
                    >
                      <HomeSessionGroupHeaderRow
                        group={group}
                        titleOpacity={props.titleOpacity(group.id)}
                        onSetRef={(element) => props.onSetHeader(group.id, element)}
                        elevated={index() === 0}
                        language={props.language}
                        isCollapsed={props.isGroupCollapsed(group.id)}
                        onToggleCollapse={() => props.onToggleGroupCollapsed(group.id)}
                        onOpenTab={() => props.onOpenGroupTab(group.id)}
                        onRename={(name) => props.onRenameGroup(group.id, name)}
                        onDelete={() => props.onDeleteGroup(group.id)}
                      />
                    </Show>
                    <div
                      class={`flex min-w-0 flex-col gap-px pt-4 ${index() === props.groups().length - 1 ? "" : "mb-6"}`}
                    >
                      <Show
                        when={!group.isUserGroup || !props.isGroupCollapsed(group.id)}
                      >
                        <For each={group.sessions}>
                          {(record) => (
                            <HomeSessionRow
                              {...props}
                              record={record}
                              inGroupId={group.isUserGroup ? group.id : undefined}
                            />
                          )}
                        </For>
                      </Show>
                    </div>
                  </>
                )}
              </For>
            </div>
          </Show>
        </Suspense>
      </div>
    </section>
  )
}

function HomeSessionLeadingController(props: {
  server: HomeSessionsViewProps["server"]
  isOpenTab: HomeSessionsViewProps["isOpenTab"]
  record: HomeSessionRecord
  revealProjectOnHover: boolean
}) {
  return (
    <HomeSessionStatusController
      server={props.server}
      record={props.record}
      isOpenTab={props.isOpenTab}
      render={(state) => (
        <HomeSessionLeading
          record={props.record}
          revealProjectOnHover={props.revealProjectOnHover}
          open={state.open()}
          unread={state.unread()}
          loading={state.loading()}
        />
      )}
    />
  )
}

function HomeSessionLeading(props: {
  record: HomeSessionRecord
  revealProjectOnHover: boolean
  open: boolean
  unread: boolean
  loading: boolean
}) {
  return (
    <div class="relative shrink-0">
      <Show when={props.open}>
        <span
          aria-hidden="true"
          class={`
            pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2
            rounded-[2px] bg-v2-background-bg-layer-04
          `}
          style={{ right: "calc(100% + 4px)" }}
        />
      </Show>
      <SessionTabAvatarView
        project={props.record.project}
        directory={props.record.session.directory}
        revealProjectOnHover={props.revealProjectOnHover}
        unread={props.unread}
        loading={props.loading}
      />
    </div>
  )
}

function HomeSessionSearch(props: HomeSessionsViewProps) {
  const sessionCountLabel = () =>
    props.language.plural("home.sessions.search.sessionsResult", props.searchSessions().length)
  const messageCountLabel = () =>
    props.language.plural("home.sessions.search.messagesResult", props.searchMessages().length)

  return (
    <div class="w-full">
      <div ref={props.onSetSearchRoot} data-component="home-session-search" class="relative z-30 w-full">
        <Show when={props.searchOpen()}>
          <div
            data-component="home-session-search-panel"
            class={`
              absolute flex flex-col overflow-hidden rounded-[12px]
              bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]
            `}
            style={{ top: "-6px", left: "-6px", width: "calc(100% + 12px)" }}
          >
            <div class="flex flex-col pt-9">
              <div id={HOME_SESSION_SEARCH_RESULTS_ID} role="listbox" class="flex flex-col pt-2">
                <Show
                  when={!props.searchLoading()}
                  fallback={<HomeSessionSearchLoading language={props.language} />}
                >
                  <Show
                    when={!props.searchError()}
                    fallback={<HomeSessionSearchError language={props.language} detail={props.searchError()} />}
                  >
                    <Show
                      when={props.searchResults().length > 0}
                      fallback={
                        <p
                          class={`
                            my-1.5 px-4 pb-2 text-[13px] leading-4 tracking-[-0.04px]
                            text-v2-text-text-muted [font-weight:440]
                          `}
                        >
                          {props.searchNoResultsLabel()}
                        </p>
                      }
                    >
                      <ScrollView class="max-h-[min(480px,50vh)]" viewportRef={props.onSetSearchList}>
                        <div class="flex flex-col pb-2">
                          <For each={props.searchResults()}>
                            {(hit, index) => {
                              const previous = index() > 0 ? props.searchResults()[index() - 1] : undefined
                              return (
                                <>
                                  <Show when={hit.kind === "session" && (!previous || previous.kind !== "session")}>
                                    <HomeSessionSearchGroupHeader
                                      label={props.language.t("home.sessions.search.sessions")}
                                      count={props.searchSessions().length}
                                      countLabel={sessionCountLabel()}
                                    />
                                  </Show>
                                  <Show when={hit.kind === "message" && (!previous || previous.kind !== "message")}>
                                    <HomeSessionSearchGroupHeader
                                      label={props.language.t("home.sessions.search.messages")}
                                      count={props.searchMessages().length}
                                      countLabel={messageCountLabel()}
                                    />
                                  </Show>
                                  <Show
                                    when={hit.kind === "session"}
                                    fallback={
                                      hit.kind === "message" ? (
                                        <HomeSessionSearchMessageRow
                                          {...props}
                                          hit={hit}
                                          selected={props.searchActive() === hit.key}
                                        />
                                      ) : null
                                    }
                                  >
                                    <HomeSessionSearchRow
                                      {...props}
                                      hit={hit}
                                      selected={props.searchActive() === hit.key}
                                    />
                                  </Show>
                                </>
                              )
                            }}
                          </For>
                        </div>
                      </ScrollView>
                      <HomeSessionSearchHints language={props.language} />
                    </Show>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Show>
        <label
          class={`
            relative z-20 flex h-9 w-full items-center gap-2 rounded-[6px] py-1 pl-3 pr-2
            bg-v2-background-bg-layer-02/60 text-v2-icon-icon-muted transition-[background-color,box-shadow]
            duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-02 focus-within:bg-v2-background-bg-layer-02
          `}
        >
          <IconV2 name="magnifying-glass" />
          <input
            ref={props.onSetSearchInput}
            class={`
              relative z-20 min-w-0 flex-1 border-0 bg-transparent outline-0
              text-v2-text-text-base [font-weight:440] placeholder:text-v2-text-text-faint
            `}
            value={props.searchValue()}
            placeholder={props.searchPlaceholder()}
            aria-label={props.searchPlaceholder()}
            aria-expanded={props.searchOpen()}
            aria-controls={HOME_SESSION_SEARCH_RESULTS_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              props.searchActive() && props.searchOpen()
                ? `home-session-search-option-${props.searchActive()}`
                : undefined
            }
            onFocus={props.onSearchFocus}
            onInput={(event) => props.onSearchInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                props.onSearchClose()
                event.currentTarget.blur()
                return
              }
              if (!props.searchOpen() || props.searchResults().length === 0) return
              if (event.altKey || event.metaKey) return
              if (event.key === "ArrowDown") {
                event.preventDefault()
                props.onSearchMove(1)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                props.onSearchMove(-1)
                return
              }
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                props.onSearchSelectActive()
              }
            }}
          />
          <Show when={props.searchValue()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="relative z-20 shrink-0"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              aria-label={props.searchPlaceholder()}
              onClick={() => {
                props.onSearchClose()
                props.onSearchFocus()
              }}
            />
          </Show>
        </label>
      </div>
    </div>
  )
}

function HomeSessionSearchGroupHeader(props: { label: string; count: number; countLabel: string }) {
  return (
    <div
      role="group"
      aria-label={props.countLabel}
      class="my-1.5 flex h-6 items-center justify-between pl-[18px] pr-6"
    >
      <p
        class={`
          text-[13px] leading-4 tracking-[-0.04px]
          text-v2-text-text-muted [font-weight:440]
        `}
      >
        {props.label}
      </p>
      <span
        aria-hidden="true"
        class="rounded-[4px] px-1.5 py-px text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440] bg-v2-background-bg-layer-02"
      >
        {props.count}
      </span>
    </div>
  )
}

function HomeSessionSearchHints(props: { language: ReturnType<typeof useLanguage> }) {
  return (
    <div class="flex items-center justify-end gap-3 border-t border-v2-border-border-muted px-4 py-2">
      <span class="flex items-center gap-1.5">
        <KeybindV2 keys={["↑", "↓"]} variant="ghost" />
        <span class="text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440]">
          {props.language.t("home.sessions.search.hint.navigate")}
        </span>
      </span>
      <span class="flex items-center gap-1.5">
        <KeybindV2 keys={["↵"]} variant="ghost" />
        <span class="text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440]">
          {props.language.t("home.sessions.search.hint.open")}
        </span>
      </span>
      <span class="flex items-center gap-1.5">
        <KeybindV2 keys={["esc"]} variant="ghost" />
        <span class="text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440]">
          {props.language.t("home.sessions.search.hint.close")}
        </span>
      </span>
    </div>
  )
}

function HomeSessionSearchLoading(props: { language: ReturnType<typeof useLanguage> }) {
  return (
    <div class="flex flex-col gap-px px-4 py-2" aria-busy="true" aria-label={props.language.t("common.loading")}>
      <For each={[0, 1, 2]}>
        {() => <div class="h-8 rounded-[6px] bg-v2-background-bg-layer-02 animate-pulse" />}
      </For>
    </div>
  )
}

function HomeSessionSearchError(props: { language: ReturnType<typeof useLanguage>; detail?: string }) {
  return (
    <div class="px-3 pb-3 pt-2" role="alert">
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

function HomeSessionSearchRow(
  props: HomeSessionsViewProps & {
    hit: HomeSearchHit
    selected: boolean
  },
) {
  const title = createMemo(() => sessionTitle(props.hit.session.title) || props.hit.session.id)
  const showProjectName = () => props.showProjectName() && props.hit.projectName
  const key = () => props.hit.key

  return (
    <button
      type="button"
      id={`home-session-search-option-${key()}`}
      data-key={key()}
      data-component="home-session-search-row"
      role="option"
      aria-selected={props.selected}
      class={`
        flex h-10 w-full shrink-0 cursor-default items-center gap-2 border-0 py-3 pl-[18px] pr-6 text-left
        transition-[background-color] duration-[120ms] ease-in-out
        hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
      `}
      classList={{
        "bg-v2-overlay-simple-overlay-hover": props.selected,
        group: !!showProjectName(),
      }}
      onMouseEnter={() => props.onSearchHighlight(props.hit)}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onClick={(event) => props.onSearchSelect(props.hit, { background: isBackgroundOpen(event) })}
      onAuxClick={(event) => {
        if (!isBackgroundOpen(event)) return
        event.preventDefault()
        props.onSearchSelect(props.hit, { background: true })
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
        revealProjectOnHover={!!showProjectName()}
      />
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <HomeSessionTitle title={title()} showProjectName={!!showProjectName()} search />
        <Show when={showProjectName()}>
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

function HomeSessionSearchMessageRow(
  props: HomeSessionsViewProps & {
    hit: Extract<HomeSearchHit, { kind: "message" }>
    selected: boolean
  },
) {
  const title = createMemo(() => sessionTitle(props.hit.session.title) || props.hit.session.id)
  const showProjectName = () => props.showProjectName() && props.hit.projectName
  const key = () => props.hit.key
  const time = createMemo(() =>
    getRelativeTime(
      new Date(props.hit.message.time.created).toISOString(),
      props.language.t,
    ),
  )

  return (
    <button
      type="button"
      id={`home-session-search-option-${key()}`}
      data-key={key()}
      data-component="home-session-search-message-row"
      role="option"
      aria-selected={props.selected}
      class={`
        flex min-h-10 w-full shrink-0 cursor-default items-center gap-2 border-0 py-1.5 pl-[18px] pr-6 text-left
        transition-[background-color] duration-[120ms] ease-in-out
        hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
      `}
      classList={{
        "bg-v2-overlay-simple-overlay-hover": props.selected,
        group: !!showProjectName(),
      }}
      onMouseEnter={() => props.onSearchHighlight(props.hit)}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onClick={(event) => props.onSearchSelect(props.hit, { background: isBackgroundOpen(event) })}
      onAuxClick={(event) => {
        if (!isBackgroundOpen(event)) return
        event.preventDefault()
        props.onSearchSelect(props.hit, { background: true })
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
        revealProjectOnHover={!!showProjectName()}
      />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex min-w-0 items-center gap-1.5">
          <HomeSessionTitle title={title()} showProjectName={!!showProjectName()} search />
          <Show when={showProjectName()}>
            <HomeSessionProjectName name={props.hit.projectName} search />
          </Show>
          <Show when={props.hit.groupName}>
            <span class="shrink-0 rounded-[4px] bg-v2-background-bg-layer-02 px-1.5 py-px text-[11px] text-v2-text-text-faint transition-[background-color] duration-[120ms] ease-in-out">
              {props.hit.groupName}
            </span>
          </Show>
          <span class="ml-auto shrink-0 pl-2 text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440]">
            {time()}
          </span>
        </div>
        <p class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
          <For each={props.hit.segments}>
            {(segment) =>
              segment.match ? (
                <mark
                  class="rounded-[3px] bg-v2-state-bg-info/70 px-[1px] text-v2-text-text-base [font-weight:530]"
                >
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

function HomeSessionGroupHeader(props: {
  title: string
  titleOpacity: number
  onSetRef: (element: HTMLDivElement) => void
  elevated?: boolean
}) {
  return (
    <div
      ref={props.onSetRef}
      class={`
        pointer-events-none sticky top-[84px] flex h-7 min-w-0 items-center justify-between
        bg-v2-background-bg-base pl-3 lg:top-[108px]
      `}
      classList={{ "home-session-group-header z-[5]": !!props.elevated, "z-10": !props.elevated }}
    >
      <div class={HOME_SECTION_LABEL} style={{ opacity: props.titleOpacity }}>
        {props.title}
      </div>
    </div>
  )
}

function HomeSessionGroupHeaderRow(props: {
  group: HomeSessionGroup
  titleOpacity: number
  onSetRef: (element: HTMLDivElement) => void
  elevated?: boolean
  language: ReturnType<typeof useLanguage>
  isCollapsed: boolean
  onToggleCollapse: () => void
  onOpenTab: () => void
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const dialog = useDialog()
  const [editing, setEditing] = createSignal(false)
  const sessionCountLabel = () =>
    props.language.plural("sessionGroup.sessions", props.group.sessions.length)

  return (
    <div
      ref={props.onSetRef}
      class={`
        group/session-group sticky top-[84px] flex h-10 min-w-0 items-center gap-2
        rounded-[6px] px-3 bg-v2-background-bg-base
        transition-[background-color] duration-[120ms] ease-in-out
        hover:bg-v2-overlay-simple-overlay-hover
        lg:top-[108px]
      `}
      classList={{ "home-session-group-header z-[5]": !!props.elevated, "z-10": !props.elevated }}
    >
      <IconButtonV2
        data-action="home-session-group-collapse"
        variant="ghost-muted"
        size="small"
        icon={
          <IconV2
            name="chevron-down"
            size="small"
            class="transition-transform duration-150 ease-in-out"
            style={{ transform: `rotate(${props.isCollapsed ? -90 : 0}deg)` }}
          />
        }
        aria-label={props.isCollapsed ? props.language.t("home.server.expand") : props.language.t("home.server.collapse")}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          props.onToggleCollapse()
        }}
      />
      <span
        class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-v2-text-text-base [font-weight:530]"
        style={{ opacity: props.titleOpacity }}
      >
        {props.group.title}
      </span>
      <span
        aria-hidden="true"
        class="shrink-0 rounded-[4px] px-1.5 py-px text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440] bg-v2-background-bg-layer-02"
      >
        {sessionCountLabel()}
      </span>
      <div
        class={`
          shrink-0 group-hover/session-group:opacity-100
          focus-within:opacity-100 data-[menu=true]:opacity-100
        `}
      >
        <MenuV2 gutter={6} modal={false} placement="bottom-end">
          <MenuV2.Trigger
            as={IconButtonV2}
            data-action="home-session-group-menu"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="outline-dots" />}
            aria-label={props.language.t("common.moreOptions")}
          />
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item onSelect={props.onOpenTab}>
                {props.language.t("sessionGroup.openGroup")}
              </MenuV2.Item>
              <MenuV2.Separator />
               <MenuV2.Item
                 onSelect={() => {
                   void dialog.show(() => (
                     <DialogSessionGroupName initial={props.group.title} onSubmit={props.onRename} />
                   ))
                 }}
              >
                {props.language.t("common.rename")}
              </MenuV2.Item>
               <MenuV2.Item
                 onSelect={props.onDelete}
              >
                <span class="text-v2-state-text-danger">{props.language.t("common.delete")}</span>
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>
    </div>
  )
}

function HomeSessionRow(
  props: HomeSessionsViewProps & { record: HomeSessionRecord; inGroupId?: string },
) {
  const dialog = useDialog()
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.showProjectName() && props.record.projectName
  const inGroup = () => !!props.inGroupId

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger class="block h-full w-full">
        <div
          class="group/session relative flex h-10 min-w-0 items-center rounded-[6px]"
          classList={{ group: !!showProjectName() }}
        >
          <button
            type="button"
             data-component="home-session-row"
             data-selected={props.isSelected(props.record.session.id) ? "" : undefined}
             aria-pressed={props.isSelected(props.record.session.id)}
            class={`
              flex h-10 min-w-0 w-full flex-1 shrink-0 cursor-default items-center gap-2 rounded-[6px] border-0
              bg-transparent py-3 pl-3 pr-10 text-left text-v2-text-text-muted [font-weight:530]
              transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out
              hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
            `}
            classList={{ "bg-v2-background-bg-layer-03": props.isSelected(props.record.session.id) }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault()
            }}
            onClick={(event) => {
              if (event.shiftKey || event.metaKey || event.ctrlKey) {
                event.preventDefault()
                props.onToggleSelection(props.record.session.id, event)
                return
              }
              props.onOpenSession(props.record.session, { background: isBackgroundOpen(event) })
            }}
            onAuxClick={(event) => {
              if (!isBackgroundOpen(event)) return
              event.preventDefault()
              props.onOpenSession(props.record.session, { background: true })
            }}
          >
            <HomeSessionLeadingController
              server={props.server}
              isOpenTab={props.isOpenTab}
              record={props.record}
              revealProjectOnHover={!!showProjectName()}
            />
            <HomeSessionTitle title={title()} showProjectName={!!showProjectName()} />
            <Show when={showProjectName()}>
              <HomeSessionProjectName name={props.record.projectName} />
            </Show>
          </button>
          <Show when={SHOW_HOME_SESSION_ARCHIVE}>
            <div
              class={`
                hover-reveal absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1
                group-hover/session:opacity-100 focus-within:opacity-100
              `}
            >
              <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={props.language.t("common.archive")}>
                <IconButtonV2
                  data-action="home-session-archive"
                  variant="ghost-muted"
                  size="large"
                  icon={<IconV2 name="archive" />}
                  aria-label={props.language.t("common.archive")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void props.onArchiveSession(props.record.session)
                  }}
                />
              </TooltipV2>
            </div>
          </Show>
        </div>
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content>
          <MenuV2.Item
            onSelect={() =>
              props.onOpenSession(props.record.session, { background: false })
            }
          >
            {props.language.t("common.open")}
          </MenuV2.Item>
          <MenuV2.Item
            onSelect={() =>
              props.onOpenSession(props.record.session, { background: true })
            }
          >
            {props.language.t("home.sessions.contextMenu.addToGroup")}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Sub gutter={0} overlap overflowPadding={8}>
            <MenuV2.SubTrigger>
              {props.language.t("home.sessions.contextMenu.addToGroup")}
            </MenuV2.SubTrigger>
            <MenuV2.Portal>
              <MenuV2.SubContent class="max-w-[200px]">
                <For each={props.userGroups()}>
                  {(group) => (
                    <MenuV2.Item onSelect={() => props.onAddToGroup(props.record.session.id, group.id)}>
                      {group.name}
                    </MenuV2.Item>
                  )}
                </For>
                <MenuV2.Separator />
                 <MenuV2.Item
                   onSelect={() => {
                     void dialog.show(() => (
                       <DialogSessionGroupName
                         onSubmit={(name) => void props.onCreateGroup(name, [props.record.session.id])}
                       />
                     ))
                   }}
                >
                  {props.language.t("home.sessions.contextMenu.newGroup")}
                </MenuV2.Item>
              </MenuV2.SubContent>
            </MenuV2.Portal>
          </MenuV2.Sub>
          <Show when={inGroup()}>
            <MenuV2.Item onSelect={() => props.onRemoveFromGroup(props.record.session.id)}>
              {props.language.t("home.sessions.contextMenu.removeFromGroup")}
            </MenuV2.Item>
          </Show>
          <MenuV2.Separator />
          <MenuV2.Item onSelect={() => void props.onArchiveSession(props.record.session)}>
            {props.language.t("common.archive")}
          </MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}

function HomeSessionTitle(props: { title: string; showProjectName: boolean; search?: boolean }) {
  return (
    <span
      class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530]"
      classList={{
        "text-[13px] leading-4 tracking-[-0.04px]": !!props.search,
        "max-w-[min(70%,480px)] flex-[0_1_auto]": props.showProjectName,
        "flex-[1_1_auto]": !props.showProjectName,
      }}
    >
      {props.title}
    </span>
  )
}

function HomeSessionProjectName(props: { name: string; search?: boolean }) {
  return (
    <span
      class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]"
      classList={{ "text-[13px] leading-4 tracking-[-0.04px]": !!props.search }}
    >
      {props.name}
    </span>
  )
}

function HomeGroupEmptyState(props: {
  language: ReturnType<typeof useLanguage>
  onAddSessions?: () => void
}) {
  return (
    <div class="flex flex-col items-center gap-2 py-6">
      <IconV2 name="layers" size="large" class="text-v2-icon-icon-muted" />
      <span class="text-[13px] text-v2-text-text-muted [font-weight:440]">
        {props.language.t("sessionGroup.empty")}
      </span>
      <span class="text-[12px] text-v2-text-text-faint [font-weight:440]">
        {props.language.t("sessionGroup.empty.description")}
      </span>
      <Show when={props.onAddSessions}>
        {(addSessions) => (
          <ButtonV2 variant="ghost-muted" size="small" onClick={addSessions()}>
            {props.language.t("sessionGroup.addSessions")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionsEmpty(props: { onNewSession?: () => void; language: ReturnType<typeof useLanguage> }) {
  return (
    <div class="flex min-h-full flex-col items-center gap-4 px-6 pt-[52px] text-center">
      <div
        class={`
          shrink-0 text-[13px] leading-[13px] tracking-[-0.04px]
          text-v2-text-text-base [font-weight:530]
        `}
      >
        {props.language.t("home.sessions.empty")}
      </div>
      <p
        class={`
          mb-1 text-center text-[13px] leading-5 tracking-[-0.04px]
          text-v2-text-text-muted [font-weight:440]
        `}
      >
        {props.language.t("home.sessions.empty.description")}
      </p>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2 data-action="home-new-session" variant="neutral" size="normal" icon="edit" onClick={onNewSession()}>
            {props.language.t("command.session.new")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between px-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}</For>
      </div>
    </div>
  )
}
