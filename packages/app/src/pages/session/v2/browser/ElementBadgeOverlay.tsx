// Element badge overlay: renders the frozen snapshot badges (BrowserElementBadge)
// for the active tab, mapped from guest CSS-viewport coordinates into the panel
// DOM space via elementRectInPanel (the same coordinate formula as the cursor).
//
// Badges are snapshot-time truth: they render exactly the elements the agent's
// snapshot described (version-keyed), so the refs stay meaningful. A stale
// badge set (newer snapshotVersion) never re-binds positions.

import { For, Show, createMemo } from "solid-js"
import { browserSnapshotStore } from "./browserSnapshotStore"
import { browserSurfaceStore } from "./browserSurfaceStore"
import { elementRectInPanel } from "./cursorMath"
import type { BrowserElementBadge, PresentedContent } from "./types"

export function ElementBadgeOverlay(props: {
  /** Runtime tab id — keys the snapshot + surface stores. */
  tabId: string
  zoomFactor: number
  visible: boolean
}) {
  const snapshot = createMemo(() => browserSnapshotStore.get(props.tabId))
  const content = createMemo(() => browserSurfaceStore.get(props.tabId)?.content ?? null)
  // Elements are stable per snapshotVersion (see file header); keying <For>
  // off them directly (instead of a {element, rect} wrapper rebuilt on every
  // scroll/rAF content update) keeps badge DOM nodes stable across scroll —
  // only each badge's own position recomputes, not the whole overlay.
  const elements = createMemo(() => snapshot()?.elements ?? [])

  return (
    <Show when={props.visible && snapshot()}>
      <div class="pointer-events-none absolute left-0 top-0 z-30" aria-hidden="true" data-browser-element-badges>
        <For each={elements()}>
          {(element) => (
            <ElementBadge element={element} zoomFactor={props.zoomFactor} content={content()} />
          )}
        </For>
      </div>
    </Show>
  )
}

function ElementBadge(props: {
  element: BrowserElementBadge
  zoomFactor: number
  content: PresentedContent | null
}) {
  const rect = createMemo(() => {
    const zoom = Number.isFinite(props.zoomFactor) && props.zoomFactor > 0 ? props.zoomFactor : 1
    return elementRectInPanel(props.element, zoom, props.content)
  })

  return (
    <div
      class="absolute flex items-center justify-center rounded-[3px] border border-v2-text-text-accent/60 bg-v2-background-bg-base/80 text-[10px] leading-none text-v2-text-text-accent"
      style={{
        left: `${rect().x}px`,
        top: `${rect().y}px`,
        width: `${Math.max(rect().width, 14)}px`,
        height: `${Math.max(rect().height, 14)}px`,
        "min-width": "14px",
        "min-height": "14px",
      }}
      data-browser-element-badge
      data-ref={props.element.ref}
    >
      <span class="px-0.5">{props.element.ref}</span>
    </div>
  )
}
