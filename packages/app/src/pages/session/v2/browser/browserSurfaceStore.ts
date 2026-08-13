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

export const browserSurfaceStore = {
  get byTabId() {
    return state.byTabId
  },
  get(tabId: string): BrowserSurfaceEntry | null {
    return state.byTabId[tabId] ?? null
  },
  presentContent(tabId: string, content: PresentedContent) {
    upsert(tabId, { content })
  },
  presentRect(tabId: string, rect: PanelRect) {
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
