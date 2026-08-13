// Snapshot badge store: the latest snapshot per tab, frozen per
// snapshotVersion. Positions are snapshot-time truth — a stale ref (version
// mismatch) is never silently re-bound; the agent re-snapshots instead.

import { createStore } from "solid-js/store"
import type { SnapshotData } from "./types"

interface BrowserSnapshotStoreState {
  byTabId: Record<string, SnapshotData>
}

const [state, setState] = createStore<BrowserSnapshotStoreState>({ byTabId: {} })

export const browserSnapshotStore = {
  get(tabId: string): SnapshotData | null {
    return state.byTabId[tabId] ?? null
  },
  apply(snapshot: SnapshotData) {
    setState("byTabId", snapshot.tabId, snapshot)
  },
  clear(tabId: string) {
    if (!(tabId in state.byTabId)) return
    const { [tabId]: _removed, ...rest } = state.byTabId
    setState("byTabId", rest)
  },
}
