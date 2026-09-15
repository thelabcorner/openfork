import { expect, mock, test } from "bun:test"

// operations.ts imports electron's `nativeTheme` (main-process only); stub the
// module so the ownership branches can be exercised without Electron.
mock.module("electron", () => ({
  nativeTheme: { shouldUseDarkColors: false },
}))

import type { GuestRecord, GuestRegistry } from "./guest"
import { BrowserPermissionDeniedError, BrowserStaleRefError } from "./errors"
import type { ControlSessionManager } from "./control-session"
import type { BrowserDispatchContext, HostOwner } from "./contracts"
import type { BrowserOperationsOptions } from "./operations"
import type { WebviewVisualController } from "./visual/webview-controller"

const { BrowserOperations } = await import("./operations")

// Stubbed registry + sessions: no CDP, no webview, no Electron. The ownership
// branches must be asserted BEFORE any control-session/CDP path is reached.

const agentOwner = (sessionId: string): HostOwner => ({ kind: "agent", sessionId })
const userOwner: HostOwner = { kind: "user" }
const context = (sessionId = "sess-1"): BrowserDispatchContext => ({
  requestId: `test-${sessionId || "internal"}`,
  sessionId,
  windowId: "win-1",
  messageId: "msg-test",
  timeoutMs: 15_000,
})

const makeRecord = (tabId: string, owner: HostOwner, overrides: Partial<GuestRecord> = {}): GuestRecord => {
  const muted = { setAudioMuted: () => undefined } as unknown as GuestRecord["webContents"]
  return {
    runtimeTabId: tabId,
    lifecycleGeneration: 1,
    windowId: "win-1",
    owner,
    webContentsId: 1,
    url: "https://example.com",
    title: "Example",
    readyState: "complete",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    colorScheme: "light",
    controller: "none",
    generation: 0,
    crashed: false,
    attached: true,
    muted: false,
    snapshotVersion: 0,
    webContents: muted,
    ...overrides,
  } as GuestRecord
}

type Harness = {
  operations: InstanceType<typeof BrowserOperations>
  records: Map<string, GuestRecord>
  calls: string[]
  tabRequests: Array<{ tabId: string; url: string }>
  snapshotRefs: Map<string, Map<string, { x: number; y: number; selector?: string }>>
  visualCalls: Array<{ operation: string; input: Record<string, unknown> }>
}

const makeHarness = (initial: GuestRecord[]): Harness => {
  const records = new Map(initial.map((record) => [record.runtimeTabId, record]))
  const calls: string[] = []
  const tabRequests: Array<{ tabId: string; url: string }> = []
  const snapshotRefs = new Map<string, Map<string, { x: number; y: number; selector?: string }>>()
  const visualCalls: Array<{ operation: string; input: Record<string, unknown> }> = []
  let operationsRef: Harness["operations"] | undefined
  const registry = {
    get: (tabId: string) => records.get(tabId),
    requireTab: (tabId?: string) => (tabId ? records.get(tabId) : undefined),
    list: () => [...records.values()],
    get activeTab() {
      return records.values().next().value
    },
    get size() {
      return records.size
    },
    getAppearance: () => "system" as const,
    getRecording: () => ({ active: false }),
    getSnapshotRefs: (tabId: string) => snapshotRefs.get(tabId),
    setOwner: (tabId: string, owner: HostOwner) => {
      calls.push(`setOwner:${tabId}`)
      const record = records.get(tabId)
      if (record) record.owner = owner
    },
    setMuted: (tabId: string, muted: boolean) => {
      calls.push(`setMuted:${tabId}`)
      const record = records.get(tabId)
      if (record) record.muted = muted
    },
    activate: (tabId: string) => calls.push(`activate:${tabId}`),
    remove: (tabId: string) => {
      calls.push(`remove:${tabId}`)
      records.delete(tabId)
    },
  } as unknown as GuestRegistry
  const visual = {
    run: async (_tab: GuestRecord, operation: string, input: Record<string, unknown>) => {
      visualCalls.push({ operation, input })
      return { visual: { schemaVersion: 1, protocolVersion: 1, runId: "test", status: "ok", operation } }
    },
  } as unknown as WebviewVisualController
  const options: BrowserOperationsOptions = {
    registry,
    sessions: {} as unknown as ControlSessionManager,
    visual,
    recordingDirectory: ".",
    maxResultBytes: 64_000,
    onTabRequest: (request) => {
      calls.push(`tabRequest:${request.tabId}`)
      tabRequests.push({ tabId: request.tabId, url: request.url })
      // Mimic the renderer: mount the <webview> and register it immediately.
      const record = makeRecord(request.tabId, userOwner, { url: request.url })
      records.set(request.tabId, record)
      queueMicrotask(() => {
        operationsRef?.prepareOpen(request.tabId, record)
        operationsRef?.resolveOpen(request.tabId, record)
      })
      return 1
    },
    onTabRequestExpired: () => undefined,
    onTabClose: (tabId) => calls.push(`tabClose:${tabId}`),
    onTabClosed: (tabId) => calls.push(`tabClosed:${tabId}`),
    onPointerEvent: () => undefined,
  }
  const operations = new BrowserOperations(options)
  operationsRef = operations
  return { operations, records, calls, tabRequests, snapshotRefs, visualCalls }
}

test("claim on a user tab flips the owner to the session (O4)", async () => {
  const { operations, records, calls } = makeHarness([makeRecord("tab_user", userOwner)])
  const result = await operations.dispatch(undefined, { name: "claim", input: { tabId: "tab_user" } }, context())
  expect(result).toEqual({ claimed: { tabId: "tab_user", owner: agentOwner("sess-1") } })
  expect(records.get("tab_user")?.owner).toEqual(agentOwner("sess-1"))
  expect(calls).toContain("setOwner:tab_user")
})

test("status keeps renderer lifecycle epochs off the broker wire", async () => {
  const { operations } = makeHarness([makeRecord("tab_status", userOwner, { lifecycleGeneration: 99 })])
  const result = await operations.dispatch(undefined, { name: "status", input: {} }, context(""))
  const tabs = result.tabs as Array<Record<string, unknown>>
  expect(tabs).toHaveLength(1)
  expect(tabs[0]).not.toHaveProperty("lifecycleGeneration")
})

test("claim on the session's own tab is idempotent (O6)", async () => {
  const { operations, records, calls } = makeHarness([makeRecord("tab_own", agentOwner("sess-1"))])
  const result = await operations.dispatch(undefined, { name: "claim", input: { tabId: "tab_own" } }, context())
  expect(result).toEqual({ claimed: { tabId: "tab_own", owner: agentOwner("sess-1") } })
  expect(records.get("tab_own")?.owner).toEqual(agentOwner("sess-1"))
  expect(calls).not.toContain("setOwner:tab_own")
})

test("claim on another session's tab throws BrowserPermissionDenied (O5)", async () => {
  const { operations } = makeHarness([makeRecord("tab_other", agentOwner("sess-2"))])
  await expect(operations.dispatch(undefined, { name: "claim", input: { tabId: "tab_other" } }, context())).rejects.toBeInstanceOf(
    BrowserPermissionDeniedError,
  )
})

test("setTabOwner flips the owner to ANY user-chosen value (D7)", async () => {
  const { operations, records } = makeHarness([makeRecord("tab_a", userOwner)])
  const result = await operations.dispatch(undefined, { name: "set_tab_owner", input: { tabId: "tab_a", owner: agentOwner("sess-2") } }, context())
  expect(result).toEqual({ assigned: { tabId: "tab_a", owner: agentOwner("sess-2") } })
  expect(records.get("tab_a")?.owner).toEqual(agentOwner("sess-2"))
  // "Return to me"
  await operations.dispatch(undefined, { name: "set_tab_owner", input: { tabId: "tab_a", owner: userOwner } }, context())
  expect(records.get("tab_a")?.owner).toEqual(userOwner)
})

test("close with another session's tab throws BrowserPermissionDenied (broker double-check)", async () => {
  const { operations } = makeHarness([makeRecord("tab_other", agentOwner("sess-2"))])
  await expect(operations.dispatch(undefined, { name: "close", input: { tabId: "tab_other" } }, context())).rejects.toBeInstanceOf(
    BrowserPermissionDeniedError,
  )
})

test("close of the session's own tab destroys it and emits tab.closed (O11)", async () => {
  const { operations, records, calls } = makeHarness([makeRecord("tab_own", agentOwner("sess-1"))])
  const result = await operations.dispatch(undefined, { name: "close", input: { tabId: "tab_own" } }, context())
  expect(result).toMatchObject({ closed: { tabId: "tab_own", guestsRemaining: 0 } })
  expect(records.has("tab_own")).toBe(false)
  expect(calls).toContain("tabClosed:tab_own")
})

test("duplicate inherits the source tab's owner (O17)", async () => {
  const { operations, records, tabRequests, calls } = makeHarness([makeRecord("tab_src", agentOwner("sess-1"))])
  const result = await operations.dispatch(undefined, { name: "duplicate", input: { tabId: "tab_src" } }, context())
  const duplicated = result as { duplicated: { tabId: string; url: string } }
  // The renderer registered the new webview; resolveOpen copied the source owner.
  expect(records.get(duplicated.duplicated.tabId)?.owner).toEqual(agentOwner("sess-1"))
  expect(tabRequests[0]?.url).toBe("https://example.com")
  expect(calls).toContain(`activate:${duplicated.duplicated.tabId}`)
})

test("setMuted flips the record's muted flag and syncs (O18)", async () => {
  const { operations, records, calls } = makeHarness([makeRecord("tab_a", userOwner)])
  const result = await operations.dispatch(undefined, { name: "set_muted", input: { tabId: "tab_a", muted: true } }, context())
  expect(result).toEqual({ muted: { tabId: "tab_a", muted: true } })
  expect(records.get("tab_a")?.muted).toBe(true)
  expect(calls).toContain("setMuted:tab_a")
})

test("visual element ref resolves through the current snapshot selector before SnapEye runs", async () => {
  const record = makeRecord("tab_visual", agentOwner("sess-1"), { snapshotVersion: 7 })
  const harness = makeHarness([record])
  harness.snapshotRefs.set("tab_visual", new Map([["e1", { x: 10, y: 20, selector: "#save" }]]))

  await harness.operations.dispatch("tab_visual", {
    name: "visual_diff",
    input: { name: "panel", target: { kind: "element", target: { ref: "e1", snapshotVersion: 7 } } },
  }, context())

  expect(harness.visualCalls).toHaveLength(1)
  expect(harness.visualCalls[0]?.operation).toBe("diff")
  expect(harness.visualCalls[0]?.input.target).toEqual({ kind: "css", selector: "#save" })
})

test("visual element ref fails stale before the SnapEye runtime is invoked", async () => {
  const record = makeRecord("tab_visual", agentOwner("sess-1"), { snapshotVersion: 8 })
  const harness = makeHarness([record])
  harness.snapshotRefs.set("tab_visual", new Map([["e1", { x: 10, y: 20, selector: "#save" }]]))

  await expect(harness.operations.dispatch("tab_visual", {
    name: "visual_capture",
    input: { name: "panel", target: { kind: "element", target: { ref: "e1", snapshotVersion: 7 } } },
  }, context())).rejects.toBeInstanceOf(BrowserStaleRefError)
  expect(harness.visualCalls).toHaveLength(0)
})

// --- DevTools/CDP handoff (P9.2) -----------------------------------------------
// Opening DevTools must detach the engine debugger, open detached DevTools, and
// re-attach (re-applying appearance) when DevTools closes. It must NOT crash,
// and must degrade cleanly when the control session is unavailable. We drive a
// fake webContents + session manager through the open_devtools dispatch path.

const makeDevtoolsHarness = () => {
  const calls: string[] = []
  let devtoolsOpen = false
  let devtoolsClosedHandler: (() => void) | null = null
  const wc = {
    id: 1,
    isDevToolsOpened: () => devtoolsOpen,
    openDevTools: (_opts: unknown) => {
      calls.push("openDevTools")
      devtoolsOpen = true
    },
    focusDevTools: () => {
      calls.push("focusDevTools")
    },
    once: (event: string, cb: () => void) => {
      if (event === "devtools-closed") devtoolsClosedHandler = cb
    },
    isDestroyed: () => false,
  } as unknown as GuestRecord["webContents"]
  const record = makeRecord("tab_dt", userOwner, { webContents: wc as GuestRecord["webContents"] })
  const records = new Map([[record.runtimeTabId, record]])
  let reattachCount = 0
  const sessions = {
    detach: (id: number) => {
      calls.push(`detach:${id}`)
    },
    reattach: async (_wc: unknown, tabId: string) => {
      reattachCount += 1
      calls.push(`reattach:${tabId}`)
    },
  } as unknown as ControlSessionManager
  const registry = {
    get: (tabId: string) => records.get(tabId),
    requireTab: (tabId?: string) => (tabId ? records.get(tabId) : undefined),
    list: () => [...records.values()],
    get size() {
      return records.size
    },
    setOwner: () => undefined,
    setMuted: () => undefined,
    activate: () => undefined,
    remove: (tabId: string) => records.delete(tabId),
  } as unknown as GuestRegistry
  const options: BrowserOperationsOptions = {
    registry,
    sessions,
    visual: { run: async () => ({ visual: {} }) } as unknown as WebviewVisualController,
    recordingDirectory: ".",
    maxResultBytes: 64_000,
    onTabRequest: () => 1,
    onTabRequestExpired: () => undefined,
    onTabClose: () => undefined,
    onTabClosed: () => undefined,
    onPointerEvent: () => undefined,
  }
  const operations = new BrowserOperations(options)
  return { operations, calls, fireDevtoolsClosed: () => devtoolsClosedHandler?.(), getReattachCount: () => reattachCount }
}

test("open_devtools detaches engine debugger, opens detached DevTools, re-attaches on close", async () => {
  const { operations, calls, fireDevtoolsClosed, getReattachCount } = makeDevtoolsHarness()
  const result = await operations.dispatch(undefined, { name: "open_devtools", input: { tabId: "tab_dt" } }, context())
  expect((result as any).devtools.open).toBe(true)
  // Engine session detached BEFORE DevTools opened.
  expect(calls.indexOf("detach:1")).toBeLessThan(calls.indexOf("openDevTools"))
  // No crash, and not yet reattached.
  expect(getReattachCount()).toBe(0)

  // DevTools closes — engine session must re-attach (and reapply appearance).
  fireDevtoolsClosed()
  expect(getReattachCount()).toBe(1)
  expect(calls).toContain("reattach:tab_dt")
})

test("open_devtools on an already-open DevTools reports open without re-detaching", async () => {
  const { operations, calls } = makeDevtoolsHarness()
  // First open.
  await operations.dispatch(undefined, { name: "open_devtools", input: { tabId: "tab_dt" } }, context())
  calls.length = 0
  // Second open while already open.
  const result = await operations.dispatch(undefined, { name: "open_devtools", input: { tabId: "tab_dt" } }, context())
  expect((result as any).devtools).toMatchObject({ open: true, focused: true })
  // Must not detach/re-open a second time.
  expect(calls).not.toContain("detach:1")
  expect(calls).not.toContain("openDevTools")
})
