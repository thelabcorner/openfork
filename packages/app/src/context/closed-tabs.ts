import type { AppTab, SessionTab, Tab } from "./tabs"
import { appTabKey } from "./app-tabs"

export type ClosedTab = {
  tab: SessionTab | AppTab
  index: number
}

const CLOSED_TAB_LIMIT = 25

// Session and OXP activity readers have durable identities and can reopen.
// Drafts lose their persisted state on close; singleton app pages are not history.
export function pushClosedTab(stack: ClosedTab[], tab: Tab, index: number): ClosedTab[] {
  if (tab.type !== "session" && !(tab.type === "app" && tab.page === "oxp" && appTabKey(tab.page, tab.href) !== "app:oxp")) return stack
  return [...stack, { tab: { ...tab }, index }].slice(-CLOSED_TAB_LIMIT)
}

// Pops the most recently closed tab that is not open again,
// discarding stale entries along the way.
export function takeClosedTab(stack: ClosedTab[], tabs: Tab[]): { entry?: ClosedTab; stack: ClosedTab[] } {
  const remaining = [...stack]
  while (remaining.length) {
    const entry = remaining.pop()
    if (entry && !isOpen(tabs, entry.tab)) return { entry, stack: remaining }
  }
  return { stack: remaining }
}

export function removeClosedTabs(stack: ClosedTab[], server: SessionTab["server"], sessionIDs: string[]) {
  const removed = new Set(sessionIDs)
  return stack.filter((entry) =>
    entry.tab.type !== "session" || entry.tab.server !== server || !removed.has(entry.tab.sessionId),
  )
}

export function nextTabAfterClose(tabs: Tab[], index: number, active: boolean) {
  if (!active) return undefined
  return tabs[index + 1] ?? tabs[index - 1] ?? null
}

function isOpen(tabs: Tab[], tab: SessionTab | AppTab) {
  if (tab.type === "app") {
    const key = appTabKey(tab.page, tab.href)
    return tabs.some((item) => item.type === "app" && appTabKey(item.page, item.href) === key)
  }
  return tabs.some((item) => item.type === "session" && item.server === tab.server && item.sessionId === tab.sessionId)
}
