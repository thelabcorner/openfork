import { describe, expect, test } from "bun:test"
import { browserHostClient, type GuestTabState } from "./browserHostClient"

// Regression coverage for the "tabs reload in a loop" bug: Solid's <For> in
// browser-panel-v2.tsx reconciles guests by object reference, so any state
// push that produces a "new" object for an unchanged tab tears down and
// remounts that tab's <webview> (a visible reload). applyGuestTab/applyHostState
// must reuse the previous object reference whenever nothing actually changed.

function tab(overrides: Partial<GuestTabState> & { tabId: string }): GuestTabState {
  return {
    url: "https://example.com",
    title: "Example",
    readyState: "Success",
    controller: "none",
    zoomFactor: 1,
    attached: true,
    ...overrides,
  }
}

describe("browserHostClient state identity", () => {
  test("onState pushes preserve object identity across the guests list", async () => {
    let onStateCb: ((tab: GuestTabState) => void) | undefined

    ;(window as unknown as { api: unknown }).api = {
      browser: {
        getState: async () => ({
          host: { connected: true, hostEpoch: 1 },
          guest: { attached: true, activeTabId: "a", url: null },
          tabs: [tab({ tabId: "a" }), tab({ tabId: "b" })],
        }),
        openTab: async () => ({ tabId: "" }),
        activateTab: async () => ({
          host: { connected: true, hostEpoch: 1 },
          guest: { attached: true, activeTabId: "a", url: null },
          tabs: [],
        }),
        closeTab: async () => ({ closed: false }),
        registerWebview: async () => ({ ok: true as const, tabId: "" }),
        unregisterWebview: async () => ({ ok: true as const }),
        getGuestPreloadPath: async () => "",
        setSessionContext: async () => {},
        onState: (cb: (tab: GuestTabState) => void) => {
          onStateCb = cb
          return () => {}
        },
        onTabRequest: () => () => {},
        onTabClose: () => () => {},
        onPointerEvent: () => () => {},
        onHostState: () => () => {},
      },
    }

    await browserHostClient.init()
    // init() kicks off getState() as a microtask chain; let it settle.
    await Promise.resolve()
    await Promise.resolve()

    const before = browserHostClient.state()
    const guestA = before.guests.find((g) => g.tabId === "a")!
    const guestB = before.guests.find((g) => g.tabId === "b")!
    expect(guestA).toBeDefined()
    expect(guestB).toBeDefined()

    // A duplicate broadcast with identical fields must be a true no-op: the
    // whole host state object (not just the guests array) keeps its identity.
    onStateCb!(tab({ tabId: "a" }))
    expect(browserHostClient.state()).toBe(before)

    // A real change to tab "a" must produce a new guests array and a new
    // object for "a", but "b" must keep its exact previous reference and
    // its array position.
    onStateCb!(tab({ tabId: "a", title: "Updated" }))
    const after = browserHostClient.state()
    expect(after).not.toBe(before)
    expect(after.guests).not.toBe(before.guests)
    expect(after.guests.findIndex((g) => g.tabId === "b")).toBe(1)
    expect(after.guests.find((g) => g.tabId === "b")).toBe(guestB)
    expect(after.guests.find((g) => g.tabId === "a")).not.toBe(guestA)
  })
})
