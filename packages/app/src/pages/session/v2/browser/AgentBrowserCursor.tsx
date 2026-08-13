// Agent browser cursor — EXACT T3 spec (AgentBrowserCursor.tsx + logic).
//
// - container: pointer-events-none absolute left-0 top-0 z-40 with a
//   transform+opacity transition (150ms ease-out, disabled under reduced
//   motion)
// - icon: MousePointer2, 20px, -translate 2px so the tip sits on the target,
//   fill-background + text-accent stroke + drop-shadow-sm
// - active linger: 700ms window restarted per pointer event (keyed remount)
// - idle opacity: 0.18 (human) / 0.35 (other)
// - click ping: size-4 rounded-full bg-accent/25 animate-status-ping keyed by
//   event.sequence so the ping replays once per click
//
// The transform uses cursorPosition() — the single shared coordinate formula
// (guest CSS px * guest zoom * fit scale + panel origin - wrapper scroll).

import { Show, createEffect, createMemo, createSignal } from "solid-js"
import "./browser.css"
import { CURSOR_ACTIVE_MS, agentBrowserCursorOpacity, cursorTranslate3d } from "./cursorMath"
import { browserPointerStore } from "./browserPointerStore"
import { browserSurfaceStore } from "./browserSurfaceStore"
import type { BrowserController } from "./types"
import { MousePointer2Icon } from "./mouse-pointer-icon"

export function AgentBrowserCursor(props: {
  /** Server tab id — keys the pointer store. */
  tabId: string
  /** Runtime tab id — keys the surface store. */
  runtimeTabId: string
  zoomFactor: number
  controller: BrowserController
}) {
  const event = createMemo(() => browserPointerStore.get(props.tabId))
  const content = createMemo(() => browserSurfaceStore.get(props.runtimeTabId)?.content ?? null)

  return (
    <Show when={event()} keyed>
      {(current) => (
        <AgentBrowserCursorEvent
          key={current.sequence}
          event={current}
          content={content()}
          zoomFactor={props.zoomFactor}
          controller={props.controller}
        />
      )}
    </Show>
  )
}

function AgentBrowserCursorEvent(props: {
  key?: number
  event: NonNullable<ReturnType<typeof browserPointerStore.get>>
  content: NonNullable<ReturnType<typeof browserSurfaceStore.get>>["content"]
  zoomFactor: number
  controller: BrowserController
}) {
  const [active, setActive] = createSignal(true)

  createEffect(() => {
    const timeout = window.setTimeout(() => setActive(false), CURSOR_ACTIVE_MS)
    return () => window.clearTimeout(timeout)
  })

  return (
    <div
      class="pointer-events-none absolute left-0 top-0 z-40 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
      style={{
        opacity: agentBrowserCursorOpacity(active(), props.controller),
        transform: cursorTranslate3d(props.event, props.zoomFactor, props.content),
      }}
      aria-hidden="true"
      data-agent-browser-cursor
    >
      <Show when={props.event.phase === "click"}>
        <span
          class="absolute left-0.5 top-0.5 size-4 rounded-full bg-v2-text-text-accent/25 animate-status-ping motion-reduce:animate-none"
          aria-hidden="true"
          data-agent-browser-click-ping
        />
      </Show>
      <MousePointer2Icon class="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-v2-background-bg-base text-v2-text-text-accent drop-shadow-sm" />
    </div>
  )
}
