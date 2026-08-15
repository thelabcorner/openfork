// Browser surface presentation store: how each hosted webview is laid out in
// the panel (rect, fit scale, wrapper scroll) plus per-tab viewport settings.
// The cursor and element badges read `presentContent` to map guest CSS
// coordinates into panel DOM space — see cursorMath.ts for the formula.

import { createStore } from "solid-js/store"
import type { PanelRect, PresentedContent, ViewportSetting } from "./types"
import { browserViewportSettingKey } from "./types"

export interface BrowserSurfaceEntry {
  content: PresentedContent | null
  rect: PanelRect | null
  visible: boolean
  cornerRadius: number
  viewport: ViewportSetting
  /** True while the user drags a resize handle. */
  dragging: boolean
}

interface BrowserSurfaceStoreState {
  byTabId: Record<string, BrowserSurfaceEntry>
}

const DEFAULT_VIEWPORT: ViewportSetting = {
  mode: "fill",
  width: null,
  height: null,
  presetId: null,
  orientation: "portrait",
}

function entry(): BrowserSurfaceEntry {
  return {
    content: null,
    rect: null,
    visible: false,
    cornerRadius: 0,
    viewport: { ...DEFAULT_VIEWPORT },
    dragging: false,
  }
}

const [state, setState] = createStore<BrowserSurfaceStoreState>({ byTabId: {} })

function upsert(tabId: string, patch: Partial<BrowserSurfaceEntry>) {
  const current = state.byTabId[tabId]
  setState("byTabId", tabId, { ...entry(), ...current, ...patch })
}

function sameRect(a: PanelRect | null | undefined, b: PanelRect): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function sameContent(a: PresentedContent | null | undefined, b: PresentedContent): boolean {
  return (
    !!a &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.scale === b.scale &&
    a.scrollLeft === b.scrollLeft &&
    a.scrollTop === b.scrollTop
  )
}

export const browserSurfaceStore = {
  get byTabId() {
    return state.byTabId
  },
  get(tabId: string): BrowserSurfaceEntry | null {
    return state.byTabId[tabId] ?? null
  },
  // presentContent/presentRect always build a fresh object from a DOM
  // measurement, and store writes replace the field's reference even when
  // the numbers are unchanged (Solid's store diffing compares nested-object
  // fields by reference, not by value) — an effect that both reads this
  // field (via layout()/panelRect()) and writes it (via this call) would
  // otherwise retrigger itself every time it runs, forever. Skip the write
  // when nothing actually changed.
  presentContent(tabId: string, content: PresentedContent) {
    if (sameContent(state.byTabId[tabId]?.content, content)) return
    upsert(tabId, { content })
  },
  presentRect(tabId: string, rect: PanelRect) {
    if (sameRect(state.byTabId[tabId]?.rect, rect)) return
    upsert(tabId, { rect })
  },
  setVisible(tabId: string, visible: boolean) {
    upsert(tabId, { visible })
  },
  setViewport(tabId: string, viewport: ViewportSetting) {
    upsert(tabId, { viewport })
  },
  setDragging(tabId: string, dragging: boolean) {
    upsert(tabId, { dragging })
  },
  setCornerRadius(tabId: string, cornerRadius: number) {
    upsert(tabId, { cornerRadius })
  },
  clear(tabId: string) {
    if (!(tabId in state.byTabId)) return
    const { [tabId]: _removed, ...rest } = state.byTabId
    setState("byTabId", rest)
  },
}

export { browserViewportSettingKey }
