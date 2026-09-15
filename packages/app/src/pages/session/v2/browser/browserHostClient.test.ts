import { describe, expect, test } from "bun:test"
import { browserHostClient, type GuestTabState, type HostOwner } from "./browserHostClient"

// Regression coverage for the "tabs reload in a loop" bug: Solid's <For> in
// browser-panel-v2.tsx reconciles guests by object reference, so any state
// push that produces a "new" object for an unchanged tab tears down and
// remounts that tab's <webview> (a visible reload). applyGuestTab/applyHostState
// must reuse the previous object reference whenever nothing actually changed.

function tab(overrides: Partial<GuestTabState> & { tabId: string }): GuestTabState {
  return {
    lifecycleGeneration: 1,
    url: "https://example.com",
    title: "Example",
    readyState: "Success",
    controller: "none",
    zoomFactor: 1,
    attached: true,
    owner: { kind: "user" },
    active: false,
    muted: false,
    ...overrides,
  }
}

describe("browserHostClient state identity", () => {
  test("onState pushes preserve object identity across the guests list", async () => {
    let onStateCb: ((tab: GuestTabState) => void) | undefined
    let preloadRequests = 0

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
        getGuestPreloadPath: async () => {
          preloadRequests += 1
          return "guest-preload.js"
        },
        assignTab: async (tabId: string, owner: HostOwner) => ({ tabId, owner }),
        closeRange: async () => ({ closed: [] }),
        refreshTab: async () => {},
        duplicateTab: async (tabId: string) => ({ tabId, url: "" }),
        setTabMuted: async () => {},
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

    // A full-state refresh containing byte-for-byte equivalent tab state must
    // not invalidate the host signal or any per-tab item references.
    await browserHostClient.refreshState()
    expect(browserHostClient.state()).toBe(before)

    // The preload path is process-stable. Repeated tab mounts should share one
    // renderer->main request instead of issuing one IPC round-trip per tab.
    expect(await browserHostClient.getGuestPreloadPath()).toBe("guest-preload.js")
    expect(await browserHostClient.getGuestPreloadPath()).toBe("guest-preload.js")
    expect(preloadRequests).toBe(1)

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

  test("visual project calls are bound to the active session context and preserve binary previews", async () => {
    const calls: Array<{ method: string; context: unknown; payload?: unknown }> = []
    const bytes = new Uint8Array([1, 2, 3, 4])
    ;(window as unknown as { api: unknown }).api = {
      browser: {
        visualHistory: async (context: unknown, input: unknown) => {
          calls.push({ method: "history", context, payload: input })
          return { root: ".snapeye", baselines: [], runs: [] }
        },
        visualArtifact: async (context: unknown, input: unknown) => {
          calls.push({ method: "artifact", context, payload: input })
          return { kind: "current", path: ".snapeye/runs/r1/current.png", mime: "image/png", byteLength: 4 }
        },
        visualArtifactPreview: async (context: unknown, input: unknown) => {
          calls.push({ method: "preview", context, payload: input })
          return {
            descriptor: { kind: "current", path: ".snapeye/runs/r1/current.png", mime: "image/png", byteLength: 4 },
            bytes,
            sha256: "a".repeat(64),
          }
        },
        visualApproveRun: async (context: unknown, runId: string, expected: unknown) => {
          calls.push({ method: "approve", context, payload: { runId, expected } })
          return {
            baseline: { name: "panel", imagePath: ".snapeye/baselines/panel.png", byteLength: 4 },
            sourceRunId: runId,
          }
        },
      },
    }

    browserHostClient.setAnnotationTarget({ sessionID: "ses_visual", directory: "C:/project" } as never)
    expect(browserHostClient.visualProjectContext()).toEqual({ sessionId: "ses_visual", directory: "C:/project" })
    expect(await browserHostClient.visualHistory({ maxRuns: 5 })).toEqual({ root: ".snapeye", baselines: [], runs: [] })
    const input = { source: "run", runId: "r1", artifact: "current" } as const
    expect((await browserHostClient.visualArtifact(input))?.path).toBe(".snapeye/runs/r1/current.png")
    const preview = await browserHostClient.visualArtifactPreview(input)
    expect(preview?.bytes).toEqual(bytes)
    expect(preview?.sha256).toBe("a".repeat(64))
    const expected = {
      currentSha256: "a".repeat(64),
      resultSha256: "b".repeat(64),
      baselineSha256: "c".repeat(64),
      baselineMetadataSha256: "d".repeat(64),
    }
    expect((await browserHostClient.visualApproveRun("r1", expected)).sourceRunId).toBe("r1")
    expect(calls.map((call) => call.method)).toEqual(["history", "artifact", "preview", "approve"])
    for (const call of calls) expect(call.context).toEqual({ sessionId: "ses_visual", directory: "C:/project" })

    browserHostClient.setAnnotationTarget(null)
    expect(browserHostClient.visualProjectContext()).toBeNull()
    expect(await browserHostClient.visualHistory()).toEqual({ root: ".snapeye", baselines: [], runs: [] })
    await expect(browserHostClient.visualApproveRun("r1", expected)).rejects.toThrow("active Desktop project session")
  })
})
