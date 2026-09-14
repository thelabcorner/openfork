import { describe, expect, test } from "bun:test"
import { waitForTabComplete, waitForUrl, type TabWaitApi } from "./tab-waits"

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
    count: () => listeners.size,
  }
}

function harness(initial: { status?: string; url?: string; title?: string }) {
  const updated = event<(tabId: number, changeInfo: { status?: string; url?: string }, tab: typeof initial) => void>()
  const removed = event<(tabId: number) => void>()
  let gets = 0
  const api: TabWaitApi = {
    get: async () => {
      gets++
      return initial
    },
    onUpdated: updated.api,
    onRemoved: removed.api,
  }
  return { api, updated, removed, gets: () => gets }
}

describe("event-driven tab waits", () => {
  test("navigation completion uses one initial get then one event, not polling", async () => {
    const h = harness({ status: "loading", url: "https://example.com" })
    const waiting = waitForTabComplete(h.api, 7, 1000)
    await Promise.resolve()
    expect(h.gets()).toBe(1)
    expect(h.updated.count()).toBe(1)
    h.updated.emit(7, { status: "complete" }, { status: "complete", url: "https://example.com" })
    await waiting
    expect(h.gets()).toBe(1)
    expect(h.updated.count()).toBe(0)
  })

  test("URL wait resolves from an update without repeated tabs.get calls", async () => {
    const h = harness({ status: "loading", url: "https://example.com/start" })
    const waiting = waitForUrl(h.api, 9, "/done", 1000)
    await Promise.resolve()
    h.updated.emit(9, { url: "https://example.com/done" }, { url: "https://example.com/done", title: "Done" })
    const tab = await waiting
    expect(tab?.url).toEndWith("/done")
    expect(h.gets()).toBe(1)
  })
})
