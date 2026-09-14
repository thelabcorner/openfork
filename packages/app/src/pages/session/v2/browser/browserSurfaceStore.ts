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

function createEntry(tabId: string, patch: Partial<BrowserSurfaceEntry>) {
  setState("byTabId", tabId, { ...entry(), ...patch })
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

function sameViewport(a: ViewportSetting | null | undefined, b: ViewportSetting): boolean {
  return (
    !!a &&
    a.mode === b.mode &&
    a.width === b.width &&
    a.height === b.height &&
    a.presetId === b.presetId &&
    a.orientation === b.orientation
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
    const current = state.byTabId[tabId]
    if (sameContent(current?.content, content)) return
    if (!current) return createEntry(tabId, { content })
    setState("byTabId", tabId, "content", content)
  },
  presentRect(tabId: string, rect: PanelRect) {
    const current = state.byTabId[tabId]
    if (sameRect(current?.rect, rect)) return
    if (!current) return createEntry(tabId, { rect })
    setState("byTabId", tabId, "rect", rect)
  },
  setVisible(tabId: string, visible: boolean) {
    const current = state.byTabId[tabId]
    if (current?.visible === visible) return
    if (!current) return createEntry(tabId, { visible })
    setState("byTabId", tabId, "visible", visible)
  },
  setViewport(tabId: string, viewport: ViewportSetting) {
    const current = state.byTabId[tabId]
    if (sameViewport(current?.viewport, viewport)) return
    if (!current) return createEntry(tabId, { viewport })
    setState("byTabId", tabId, "viewport", viewport)
  },
  setDragging(tabId: string, dragging: boolean) {
    const current = state.byTabId[tabId]
    if (current?.dragging === dragging) return
    if (!current) return createEntry(tabId, { dragging })
    setState("byTabId", tabId, "dragging", dragging)
  },
  setCornerRadius(tabId: string, cornerRadius: number) {
    const current = state.byTabId[tabId]
    if (current?.cornerRadius === cornerRadius) return
    if (!current) return createEntry(tabId, { cornerRadius })
    setState("byTabId", tabId, "cornerRadius", cornerRadius)
  },
  clear(tabId: string) {
    if (!(tabId in state.byTabId)) return
    // Solid Store treats `undefined` at a keyed path as deletion. Mutate only
    // that property instead of cloning the whole map: teardown stays O(1) and
    // unrelated tab entries retain identity/reactive isolation.
    setState("byTabId", tabId, undefined!)
  },
}

export { browserViewportSettingKey }
