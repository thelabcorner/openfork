// Keeps the opencode favicon marker on the selected tab of each Chrome window.
// This module deliberately has no chrome.* globals so the event/race semantics
// can be unit-tested without loading the MV3 service worker.

export const ACTIVE_TAB_ICON_MESSAGE = "opencode:active-tab-icon"

export type ActiveTabInfo = {
  id?: number
  windowId?: number
}

type Listener<T extends (...args: any[]) => void> = {
  addListener(listener: T): void
  removeListener(listener: T): void
}

export interface ActiveTabIconTabsApi {
  query(query: { active: true }): Promise<ActiveTabInfo[]>
  sendMessage(tabId: number, message: { type: typeof ACTIVE_TAB_ICON_MESSAGE; active: boolean }): Promise<unknown>
  onActivated: Listener<(info: { tabId: number; windowId: number }) => void>
  onUpdated: Listener<(tabId: number, changeInfo: { status?: string; url?: string }) => void>
  onRemoved: Listener<(tabId: number, removeInfo: { windowId: number }) => void>
}

export class ActiveTabIconController {
  private readonly activeByWindow = new Map<number, number>()
  private started = false
  private epoch = 0

  constructor(
    private readonly tabs: ActiveTabIconTabsApi,
    private readonly log?: (message: string, meta?: Record<string, unknown>) => void,
  ) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.tabs.onActivated.addListener(this.onActivated)
    this.tabs.onUpdated.addListener(this.onUpdated)
    this.tabs.onRemoved.addListener(this.onRemoved)

    // Register listeners before the async query, then discard the snapshot if
    // an activation raced it. This avoids repainting an already-stale favicon.
    const epoch = this.epoch
    const active = await this.tabs.query({ active: true }).catch(() => [])
    if (!this.started || this.epoch !== epoch) return
    for (const tab of active) {
      if (tab.id === undefined || tab.windowId === undefined) continue
      this.setWindowActive(tab.windowId, tab.id)
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.epoch++
    this.tabs.onActivated.removeListener(this.onActivated)
    this.tabs.onUpdated.removeListener(this.onUpdated)
    this.tabs.onRemoved.removeListener(this.onRemoved)
    for (const tabId of this.activeByWindow.values()) this.send(tabId, false)
    this.activeByWindow.clear()
  }

  private readonly onActivated = ({ tabId, windowId }: { tabId: number; windowId: number }) => {
    this.epoch++
    this.setWindowActive(windowId, tabId)
  }

  private readonly onUpdated = (tabId: number, changeInfo: { status?: string; url?: string }) => {
    // Navigation replaces the content-script document, so re-assert after the
    // new document is complete. URL-only updates include SPA/history changes;
    // they do not destroy the injected link and need no extra message.
    if (changeInfo.status !== "complete") return
    for (const activeId of this.activeByWindow.values()) {
      if (activeId !== tabId) continue
      this.send(tabId, true)
      return
    }
  }

  private readonly onRemoved = (tabId: number, { windowId }: { windowId: number }) => {
    if (this.activeByWindow.get(windowId) !== tabId) return
    this.epoch++
    this.activeByWindow.delete(windowId)
  }

  private setWindowActive(windowId: number, tabId: number): void {
    const previous = this.activeByWindow.get(windowId)
    if (previous === tabId) {
      this.send(tabId, true)
      return
    }
    if (previous !== undefined) this.send(previous, false)
    this.activeByWindow.set(windowId, tabId)
    this.send(tabId, true)
  }

  private send(tabId: number, active: boolean): void {
    void this.tabs
      .sendMessage(tabId, { type: ACTIVE_TAB_ICON_MESSAGE, active })
      .catch((error) => this.log?.("active-tab icon message skipped", { tabId, active, error: String(error) }))
  }
}
