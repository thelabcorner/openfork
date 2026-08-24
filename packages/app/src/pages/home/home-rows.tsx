import type { Session } from "@opencode-ai/sdk/v2/client"
import { type Accessor, createMemo, type JSX, Show, splitProps } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { type ProjectAvatarStatus, ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { useLanguage } from "@/context/language"
import { getProjectAvatarVariant, type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { SessionTabAvatarView } from "@/pages/layout/session-tab-avatar"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import { shouldOpenSessionInBackground } from "../home-session-open"
import {
  HomeSessionStatusController,
  type HomeSessionRecord,
  type OpenSessionOptions,
} from "./home-sessions-controller"
import { SessionContextMenu } from "@/components/session-menu/session-context-menu"

// Shared home row/list-item presentation, consumed by HomeProjectsView,
// HomeSessionsView (NewHome) and the future mobile sessions tab. Presentation
// only: controllers stay in their own modules.

export const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"

const SHOW_HOME_SESSION_ARCHIVE = false

// Middle-click or Cmd+click on macOS (Ctrl+click elsewhere) opens a session
// tab in the background without navigating, matching browser conventions.
export function isBackgroundOpen(event: MouseEvent) {
  return shouldOpenSessionInBackground({
    button: event.button,
    mac: typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  })
}

export function HomeSessionLeadingController(props: {
  server: Accessor<ServerConnection.Key>
  isOpenTab: (record: HomeSessionRecord) => boolean
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
          status={state.status()}
          loading={state.loading()}
        />
      )}
    />
  )
}

export function HomeSessionLeading(props: {
  record: HomeSessionRecord
  revealProjectOnHover: boolean
  open: boolean
  status: ProjectAvatarStatus | undefined
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
        status={props.status}
        loading={props.loading}
      />
    </div>
  )
}

export type HomeSessionRowProps = {
  language: ReturnType<typeof useLanguage>
  server: Accessor<ServerConnection.Key>
  isOpenTab: (record: HomeSessionRecord) => boolean
  showProjectName: Accessor<boolean>
  isSelected: (sessionId: string) => boolean
  onToggleSelection: (sessionId: string, event: MouseEvent) => void
  onOpenSession: (session: Session, options?: OpenSessionOptions) => void
  onArchiveSession: (session: Session) => Promise<void>
  userGroups: () => Array<{ id: string; name: string }>
  onCreateGroup: (name: string, sessionIds?: string[]) => Promise<string>
  onAddToGroup: (sessionId: string, groupId: string) => void
  onRemoveFromGroup: (sessionId: string) => void
  record: HomeSessionRecord
  inGroupId?: string
}

export function HomeSessionRow(props: HomeSessionRowProps) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.showProjectName() && props.record.projectName

  return (
    <SessionContextMenu
      where="home"
      session={props.record.session}
      server={props.server()}
      inGroupId={props.inGroupId}
      onOpen={(opts) => props.onOpenSession(props.record.session, { background: !!opts?.background })}
      onArchive={() => void props.onArchiveSession(props.record.session)}
      onAddToGroup={(groupId) => props.onAddToGroup(props.record.session.id, groupId)}
      onRemoveFromGroup={() => props.onRemoveFromGroup(props.record.session.id)}
      onCreateGroup={(name) => void props.onCreateGroup(name, [props.record.session.id])}
    >
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
            [[data-model-picker-open]_&]:bg-v2-overlay-simple-overlay-hover
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
    </SessionContextMenu>
  )
}

export function HomeSessionTitle(props: { title: string; showProjectName: boolean; search?: boolean }) {
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

// Dimmed archived variant of HomeSessionRow: same presentation, no context
// menu/selection, archived timestamp on the right and a hover Unarchive action.
export function HomeArchivedSessionRow(props: {
  language: ReturnType<typeof useLanguage>
  server: Accessor<ServerConnection.Key>
  isOpenTab: (record: HomeSessionRecord) => boolean
  showProjectName: Accessor<boolean>
  onOpenSession: (session: Session, options?: OpenSessionOptions) => void
  onUnarchiveSession: (session: Session) => Promise<void>
  record: HomeSessionRecord
}) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.showProjectName() && props.record.projectName
  const archivedLabel = createMemo(() => {
    const time = props.record.session.time.archived
    return typeof time === "number" ? getRelativeTime(new Date(time).toISOString(), props.language.t) : undefined
  })

  return (
    <div
      class="group/session relative flex h-10 min-w-0 items-center rounded-[6px]"
      classList={{ group: !!showProjectName() }}
    >
      <button
        type="button"
        data-component="home-session-row"
        data-archived=""
        class={`
          flex h-10 min-w-0 w-full flex-1 shrink-0 cursor-default items-center gap-2 rounded-[6px] border-0
          bg-transparent py-3 pl-3 pr-10 text-left opacity-70 text-v2-text-text-muted [font-weight:530]
          transition-[background-color,color,opacity,box-shadow] duration-[120ms] ease-in-out
          hover:bg-v2-overlay-simple-overlay-hover hover:opacity-100 focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:opacity-100 focus-visible:outline-none
        `}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onClick={(event) => {
          if (event.shiftKey || event.metaKey || event.ctrlKey) return
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
        <Show when={archivedLabel()}>
          {(label) => (
            <span class="ml-auto shrink-0 pl-2 text-[11px] leading-4 tracking-[-0.04px] text-v2-text-text-faint [font-weight:440]">
              {label()}
            </span>
          )}
        </Show>
      </button>
      <div
        class={`
          hover-reveal absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1
          group-hover/session:opacity-100 focus-within:opacity-100
        `}
      >
        <TooltipV2
          class="flex shrink-0 items-center"
          placement="bottom"
          value={props.language.t("home.sessions.archived.unarchive")}
        >
          <IconButtonV2
            data-action="home-session-unarchive"
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="reset" />}
            aria-label={props.language.t("home.sessions.archived.unarchive")}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void props.onUnarchiveSession(props.record.session)
            }}
          />
        </TooltipV2>
      </div>
    </div>
  )
}

export function HomeSessionProjectName(props: { name: string; search?: boolean }) {
  return (
    <span
      class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]"
      classList={{ "text-[13px] leading-4 tracking-[-0.04px]": !!props.search }}
    >
      {props.name}
    </span>
  )
}

export function HomeProjectNavButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <button
      {...rest}
      class={`
        flex h-7 min-w-0 w-full shrink-0 cursor-default items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left
        text-v2-text-text-muted [font-weight:440] transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out
        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
        data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base
        data-[selected]:hover:bg-v2-background-bg-layer-03
        focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:outline-none
        focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]
        ${local.class ?? ""}
      `}
      classList={local.classList}
    >
      {local.children}
    </button>
  )
}

export function HomeProjectAvatar(props: { project: LocalProject; outline?: boolean }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <ProjectAvatar
      fallback={name()}
      src={props.outline ? undefined : getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={props.outline ? "outline" : getProjectAvatarVariant(props.project.icon?.color)}
    />
  )
}
