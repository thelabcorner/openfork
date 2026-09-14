import { describe, expect, test } from "bun:test"
import { ACTIVE_TAB_ICON_MESSAGE, ActiveTabIconController, type ActiveTabIconTabsApi } from "./active-tab-icon"

function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>()
  return {
    api: {
      addListener: (listener: T) => void listeners.add(listener),
      removeListener: (listener: T) => void listeners.delete(listener),
    },
    emit: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args)
    },
  }
}

function harness(active = [{ id: 10, windowId: 1 }, { id: 20, windowId: 2 }]) {
  const activated = event<(info: { tabId: number; windowId: number }) => void>()
  const updated = event<(tabId: number, changeInfo: { status?: string; url?: string }) => void>()
  const removed = event<(tabId: number, removeInfo: { windowId: number }) => void>()
  const messages: Array<{ tabId: number; active: boolean }> = []
  const tabs: ActiveTabIconTabsApi = {
    query: async () => active,
    sendMessage: async (tabId, message) => {
      expect(message.type).toBe(ACTIVE_TAB_ICON_MESSAGE)
      messages.push({ tabId, active: message.active })
    },
    onActivated: activated.api,
    onUpdated: updated.api,
    onRemoved: removed.api,
  }
  return { controller: new ActiveTabIconController(tabs), activated, updated, removed, messages }
}

describe("ActiveTabIconController", () => {
  test("marks every window's selected tab and clears only the replaced tab", async () => {
    const h = harness()
    await h.controller.start()
    expect(h.messages).toEqual([
      { tabId: 10, active: true },
      { tabId: 20, active: true },
    ])
    h.messages.length = 0
    h.activated.emit({ tabId: 11, windowId: 1 })
    await Promise.resolve()
    expect(h.messages).toEqual([
      { tabId: 10, active: false },
      { tabId: 11, active: true },
    ])
  })

  test("re-applies the icon after an active tab finishes navigation", async () => {
    const h = harness([{ id: 10, windowId: 1 }])
    await h.controller.start()
    h.messages.length = 0
    h.updated.emit(10, { status: "loading" })
    h.updated.emit(10, { status: "complete" })
    await Promise.resolve()
    expect(h.messages).toEqual([{ tabId: 10, active: true }])
  })

  test("stop removes listeners and clears active markers", async () => {
    const h = harness([{ id: 10, windowId: 1 }])
    await h.controller.start()
    h.messages.length = 0
    h.controller.stop()
    await Promise.resolve()
    expect(h.messages).toEqual([{ tabId: 10, active: false }])
    h.messages.length = 0
    h.activated.emit({ tabId: 12, windowId: 1 })
    await Promise.resolve()
    expect(h.messages).toEqual([])
  })
})
