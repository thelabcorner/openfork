// Agent pointer events, one slot per tab. Mirrors the T3 browserPointerStore:
// a new event overwrites the previous one for the tab; clearing removes the tab.

import { createStore } from "solid-js/store"
import type { BrowserPointerEvent } from "./types"

interface BrowserPointerStoreState {
  byTabId: Record<string, BrowserPointerEvent>
}

const [state, setState] = createStore<BrowserPointerStoreState>({ byTabId: {} })

export const browserPointerStore = {
  get byTabId() {
    return state.byTabId
  },
  get(tabId: string) {
    return state.byTabId[tabId] ?? null
  },
  apply(event: BrowserPointerEvent) {
    setState("byTabId", { ...state.byTabId, [event.tabId]: event })
  },
  clear(tabId: string) {
    if (!(tabId in state.byTabId)) return
    const { [tabId]: _removed, ...rest } = state.byTabId
    setState("byTabId", rest)
  },
}
