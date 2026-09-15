import { useLanguage } from "@/context/language"
import { sessionTitle } from "@/utils/session-title"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { A } from "@solidjs/router"
import { createSignal, For, Show, type JSX } from "solid-js"
import { CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN } from "./chat-sidebar-pane-state"

export function ChatSidebarArchivedBody(props: {
  rows: Session[]
  loading: boolean
  error: boolean
  limit: number
  minuteNow: () => number
  activeSessionId?: string
  pendingSessionId?: string
  onPending: (id: string) => void
  onRetry: () => void
  onUnarchive: (session: Session) => Promise<void>
  onShowMore: () => void
  onShowLess: () => void
}) {
  const language = useLanguage()
  return (
    <div id="chats-group-archived" class="flex flex-col px-1.5 pt-0.5">
      <Show
        when={!props.loading}
        fallback={<ChatsArchivedLoading label={language.t("chats.archived.loading")} />}
      >
        <Show when={!props.error} fallback={<ChatsArchivedError onRetry={props.onRetry} />}>
          <Show
            when={props.rows.length > 0}
            fallback={
              <p class="px-2 py-1.5 text-[11px] leading-none text-v2-text-text-faint">
                {language.t("chats.archived.empty")}
              </p>
            }
          >
            <For each={props.rows.slice(0, props.limit)}>
              {(session) => (
                <ArchivedRow
                  session={session}
                  minuteNow={props.minuteNow}
                  selected={props.activeSessionId === session.id}
                  pending={props.pendingSessionId === session.id}
                  onPending={props.onPending}
                  unarchiveSession={() => props.onUnarchive(session)}
                />
              )}
            </For>
            <Show when={props.rows.length > props.limit}>
              <button
                type="button"
                class="ms-[26px] flex h-6 items-center rounded-md pe-2 text-start text-[10px] leading-none text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-muted focus-visible:outline-none"
                onClick={props.onShowMore}
              >
                {language.t("chats.archived.showMore")}
              </button>
            </Show>
            <Show when={props.limit > CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN}>
              <button
                type="button"
                class="ms-[26px] flex h-6 items-center rounded-md pe-2 text-start text-[10px] leading-none text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-muted focus-visible:outline-none"
                onClick={props.onShowLess}
              >
                {language.t("chats.archived.showLess")}
              </button>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
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
        onClick={props.onRetry}
      >
        {language.t("chats.archived.retry")}
      </button>
    </div>
  )
}

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

function ArchivedRow(props: {
  session: Session
  minuteNow: () => number
  selected?: boolean
  pending?: boolean
  onPending?: (id: string) => void
  unarchiveSession: () => Promise<void>
}): JSX.Element {
  const language = useLanguage()
  const title = () => sessionTitle(props.session.title)
  const slug = () => base64Encode(props.session.directory || "")
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
    <div class="group/session relative min-w-0 rounded-md opacity-70 transition-[background-color,opacity] duration-[120ms] hover:bg-v2-background-bg-layer-01 hover:opacity-100 focus-within:bg-v2-background-bg-layer-01 focus-within:opacity-100 has-[data-selected]:bg-v2-background-bg-layer-02 has-[data-selected]:opacity-100">
      <A
        href={`/${slug()}/session/${props.session.id}`}
        class="relative flex min-w-0 flex-col gap-[3px] rounded-md py-[5px] pe-1.5 ps-2 text-v2-text-text-muted transition-colors focus-visible:outline-none group-hover/session:text-v2-text-text-base [&.active]:text-v2-text-text-base [&.active]:before:absolute [&.active]:before:inset-y-[5px] [&.active]:before:start-0 [&.active]:before:w-[2px] [&.active]:before:rounded-full [&.active]:before:bg-v2-background-bg-accent [&.active]:before:content-[''] data-[selected]:text-v2-text-text-base data-[selected]:before:absolute data-[selected]:before:inset-y-[5px] data-[selected]:before:start-0 data-[selected]:before:w-[2px] data-[selected]:before:rounded-full data-[selected]:before:bg-v2-background-bg-accent data-[selected]:before:content-['']"
        data-selected={props.selected ? "" : undefined}
        aria-current={props.selected ? "page" : undefined}
        onClick={(event: MouseEvent) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button === 1) return
          props.onPending?.(props.session.id)
        }}
      >
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="flex size-3 shrink-0 items-center justify-center">
            <Show
              when={props.pending}
              fallback={<IconV2 name="archive" size="small" class="size-3 text-v2-icon-icon-muted" />}
            >
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
