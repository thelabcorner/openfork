// Event-driven Chrome tab wait primitives. Kept chrome-global-free so their
// race semantics can be tested independently of the MV3 service worker.

type TabState = { status?: string; url?: string; title?: string }

type Event<T extends (...args: any[]) => void> = {
  addListener(listener: T): void
  removeListener(listener: T): void
}

export interface TabWaitApi {
  get(tabId: number): Promise<TabState>
  onUpdated: Event<(tabId: number, changeInfo: { status?: string; url?: string }, tab: TabState) => void>
  onRemoved: Event<(tabId: number) => void>
}

function createTabWait(
  tabs: TabWaitApi,
  tabId: number,
  timeoutMs: number,
  matches: (changeInfo: { status?: string; url?: string }, tab: TabState) => boolean,
) {
  let finish: (tab: TabState | null) => void = () => {}
  const done = new Promise<TabState | null>((resolve) => {
    let settled = false
    const onUpdated = (updatedTabId: number, changeInfo: { status?: string; url?: string }, tab: TabState) => {
      if (updatedTabId === tabId && matches(changeInfo, tab)) finish(tab)
    }
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(null)
    }
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs))
    finish = (tab) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      tabs.onUpdated.removeListener(onUpdated)
      tabs.onRemoved.removeListener(onRemoved)
      resolve(tab)
    }
    tabs.onUpdated.addListener(onUpdated)
    tabs.onRemoved.addListener(onRemoved)
  })
  return { done, finish }
}

export async function waitForTabComplete(tabs: TabWaitApi, tabId: number, timeoutMs: number): Promise<void> {
  const wait = createTabWait(tabs, tabId, timeoutMs, (changeInfo, tab) =>
    changeInfo.status === "complete" || tab.status === "complete",
  )
  // Listener-first + immediate state check closes the completion race.
  const current = await tabs.get(tabId).catch(() => null)
  if (!current || current.status === "complete") wait.finish(current)
  await wait.done
}

export async function waitForUrl(
  tabs: TabWaitApi,
  tabId: number,
  pattern: string,
  timeoutMs: number,
): Promise<TabState | null> {
  const wait = createTabWait(tabs, tabId, timeoutMs, (changeInfo, tab) =>
    (changeInfo.url ?? tab.url ?? "").includes(pattern),
  )
  const current = await tabs.get(tabId).catch(() => null)
  if (!current || current.url?.includes(pattern)) wait.finish(current)
  return wait.done
}
