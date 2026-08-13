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
import type { BrowserElementBadge } from "./types"

export function ElementBadgeOverlay(props: {
  /** Runtime tab id — keys the snapshot + surface stores. */
  tabId: string
  zoomFactor: number
  visible: boolean
}) {
  const snapshot = createMemo(() => browserSnapshotStore.get(props.tabId))
  const content = createMemo(() => browserSurfaceStore.get(props.tabId)?.content ?? null)

  const badges = createMemo(() => {
    const data = snapshot()
    if (!data) return [] as BadgePlacement[]
    const zoom = Number.isFinite(props.zoomFactor) && props.zoomFactor > 0 ? props.zoomFactor : 1
    return data.elements.map((element) => ({
      element,
      rect: elementRectInPanel(element, zoom, content()),
    }))
  })

  return (
    <Show when={props.visible && snapshot()}>
      <div class="pointer-events-none absolute left-0 top-0 z-30" aria-hidden="true" data-browser-element-badges>
        <For each={badges()}>
          {({ element, rect }) => (
            <div
              class="absolute flex items-center justify-center rounded-[3px] border border-v2-text-text-accent/60 bg-v2-background-bg-base/80 text-[10px] leading-none text-v2-text-text-accent"
              style={{
                left: `${rect.x}px`,
                top: `${rect.y}px`,
                width: `${Math.max(rect.width, 14)}px`,
                height: `${Math.max(rect.height, 14)}px`,
                "min-width": "14px",
                "min-height": "14px",
              }}
              data-browser-element-badge
              data-ref={element.ref}
            >
              <span class="px-0.5">{element.ref}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

type BadgePlacement = {
  element: BrowserElementBadge
  rect: { x: number; y: number; width: number; height: number }
}
