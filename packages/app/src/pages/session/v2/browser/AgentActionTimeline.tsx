// Agent action timeline: bounded per-tab feed of browser tool actions with
// status + elapsed, rendered as a collapsible bottom dock on the canvas.
// Running actions pulse; failures tint warning. Auto-scrolls to the latest
// event; collapses to a status-only strip when the user closes it.

import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { browserActionStore, isBrowserActionTimelineBounded } from "./browserActionStore"
import type { ActionStatus, BrowserActionEvent } from "./types"

const STATUS_KEY: Record<ActionStatus, "browser.action.running" | "browser.action.succeeded" | "browser.action.failed" | "browser.action.interrupted"> = {
  running: "browser.action.running",
  succeeded: "browser.action.succeeded",
  failed: "browser.action.failed",
  interrupted: "browser.action.interrupted",
}

const STATUS_CLASS: Record<ActionStatus, string> = {
  running: "text-v2-text-text-accent",
  succeeded: "text-v2-text-text-muted",
  failed: "text-v2-text-text-warning",
  interrupted: "text-v2-text-text-muted",
}

export function AgentActionTimeline(props: { tabId: string }) {
  const language = useLanguage()
  const [collapsed, setCollapsed] = createSignal(false)
  let listRef: HTMLDivElement | undefined

  const events = createMemo(() => browserActionStore.get(props.tabId))
  const bounded = createMemo(() => isBrowserActionTimelineBounded(props.tabId))

  createEffect(() => {
    const count = events().length
    if (count === 0) return
    if (collapsed()) return
    listRef?.scrollTo({ top: listRef.scrollHeight })
  })

  const latest = createMemo(() => events().at(-1))

  return (
    <Show when={events().length > 0}>
      <div
        class="absolute inset-x-0 bottom-0 z-30 border-t border-v2-border-border-base bg-v2-background-bg-base/90 backdrop-blur-sm"
        data-browser-action-timeline
      >
        <button
          type="button"
          class="flex h-6 w-full items-center gap-1.5 px-2 text-[10px] leading-none text-v2-text-text-muted transition-colors duration-100 hover:text-v2-text-text-base"
          onClick={() => setCollapsed(!collapsed())}
          aria-expanded={!collapsed()}
        >
          <ChevronIcon collapsed={collapsed()} />
          <Show when={latest()} fallback={language.t("browser.action.running")}>
            {(current) => (
              <span class={`flex min-w-0 items-center gap-1.5 ${STATUS_CLASS[current().status]}`}>
                <StatusDot status={current().status} />
                <span class="truncate">
                  {current().op}
                  <Show when={current().target}>{(target) => <>: {target()}</>}</Show>
                </span>
                <Show when={current().elapsedMs !== undefined}>
                  <span class="tabular-nums text-v2-text-text-muted">{(current().elapsedMs! / 1000).toFixed(1)}s</span>
                </Show>
              </span>
            )}
          </Show>
          <Show when={bounded()}>
            <span class="ml-auto shrink-0 text-v2-text-text-weaker">200+</span>
          </Show>
        </button>
        <Show when={!collapsed()}>
          <div ref={listRef} class="max-h-32 overflow-y-auto px-1 pb-1" data-browser-action-timeline-list>
            <For each={events()}>
              {(event) => (
                <div class="flex items-center gap-1.5 px-1 py-0.5 text-[10px] leading-none text-v2-text-text-muted">
                  <StatusDot status={event.status} />
                  <span class={`shrink-0 ${STATUS_CLASS[event.status]}`}>{language.t(STATUS_KEY[event.status])}</span>
                  <span class="truncate">
                    {event.op}
                    <Show when={event.target}>{(target) => <>: {target()}</>}</Show>
                  </span>
                  <Show when={event.error}>
                    <span class="truncate text-v2-text-text-warning" title={event.error}>
                      {event.error}
                    </span>
                  </Show>
                  <Show when={event.elapsedMs !== undefined}>
                    <span class="ml-auto shrink-0 tabular-nums text-v2-text-text-weaker">
                      {(event.elapsedMs! / 1000).toFixed(1)}s
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function StatusDot(props: { status: ActionStatus }) {
  return (
    <span
      class={`size-1.5 shrink-0 rounded-full ${
        props.status === "running"
          ? "animate-status-ping bg-v2-text-text-accent"
          : props.status === "failed"
            ? "bg-v2-text-text-warning"
            : "bg-v2-border-border-strong"
      }`}
      aria-hidden="true"
    />
  )
}

function ChevronIcon(props: { collapsed: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      class={`transition-transform duration-100 ${props.collapsed ? "-rotate-90" : ""}`}
    >
      <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
    </svg>
  )
}
