// Agent action timeline feed: bounded per-tab history of tool actions with
// status + elapsed, rendered by AgentActionTimeline. Bounded to 200 entries
// (drops oldest), matching the engine's action timeline cap.

import { createStore } from "solid-js/store"
import type { BrowserActionEvent } from "./types"

export const BROWSER_ACTION_TIMELINE_CAP = 200

interface BrowserActionStoreState {
  byTabId: Record<string, BrowserActionEvent[]>
}

const [state, setState] = createStore<BrowserActionStoreState>({ byTabId: {} })

const latest = (tabId: string) => state.byTabId[tabId] ?? []

export const browserActionStore = {
  get(tabId: string): readonly BrowserActionEvent[] {
    return latest(tabId)
  },
  push(event: BrowserActionEvent) {
    const next = [...latest(event.tabId), event]
    if (next.length > BROWSER_ACTION_TIMELINE_CAP) {
      next.splice(0, next.length - BROWSER_ACTION_TIMELINE_CAP)
    }
    setState("byTabId", event.tabId, next)
  },
  clear(tabId: string) {
    if (!(tabId in state.byTabId)) return
    setState("byTabId", tabId, [])
  },
}

/** True when the feed is full — used for a "showing latest N" affordance. */
export function isBrowserActionTimelineBounded(tabId: string): boolean {
  return latest(tabId).length >= BROWSER_ACTION_TIMELINE_CAP
}
