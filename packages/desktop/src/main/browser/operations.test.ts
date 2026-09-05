import { expect, mock, test } from "bun:test"

// operations.ts imports electron's `nativeTheme` (main-process only); stub the
// module so the ownership branches can be exercised without Electron.
mock.module("electron", () => ({
  nativeTheme: { shouldUseDarkColors: false },
}))

import type { GuestRecord, GuestRegistry } from "./guest"
import { BrowserPermissionDeniedError } from "./errors"
import type { ControlSessionManager } from "./control-session"
import type { HostOwner } from "./contracts"
import type { BrowserOperationsOptions } from "./operations"

const { BrowserOperations } = await import("./operations")

// Stubbed registry + sessions: no CDP, no webview, no Electron. The ownership
// branches must be asserted BEFORE any control-session/CDP path is reached.

const agentOwner = (sessionId: string): HostOwner => ({ kind: "agent", sessionId })
const userOwner: HostOwner = { kind: "user" }

const makeRecord = (tabId: string, owner: HostOwner, overrides: Partial<GuestRecord> = {}): GuestRecord => {
  const muted = { setAudioMuted: () => undefined } as unknown as GuestRecord["webContents"]
  return {
    runtimeTabId: tabId,
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
}

const makeHarness = (initial: GuestRecord[]): Harness => {
  const records = new Map(initial.map((record) => [record.runtimeTabId, record]))
  const calls: string[] = []
  const tabRequests: Array<{ tabId: string; url: string }> = []
  let operationsRef: Harness["operations"] | undefined
  const registry = {
    get: (tabId: string) => records.get(tabId),
    requireTab: (tabId?: string) => (tabId ? records.get(tabId) : undefined),
    list: () => [...records.values()],
    get size() {
      return records.size
    },
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
    unregister: (tabId: string) => {
      calls.push(`unregister:${tabId}`)
      records.delete(tabId)
    },
  } as unknown as GuestRegistry
  const options: BrowserOperationsOptions = {
    registry,
    sessions: {} as unknown as ControlSessionManager,
    recordingDirectory: ".",
    maxResultBytes: 64_000,
    onTabRequest: (request) => {
      calls.push(`tabRequest:${request.tabId}`)
      tabRequests.push({ tabId: request.tabId, url: request.url })
      // Mimic the renderer: mount the <webview> and register it immediately.
      const record = makeRecord(request.tabId, userOwner, { url: request.url })
      records.set(request.tabId, record)
      queueMicrotask(() => operationsRef?.resolveOpen(request.tabId, record))
    },
    onTabClose: (tabId) => calls.push(`tabClose:${tabId}`),
    onTabClosed: (tabId) => calls.push(`tabClosed:${tabId}`),
    onPointerEvent: () => undefined,
  }
  const operations = new BrowserOperations(options)
  operationsRef = operations
  return { operations, records, calls, tabRequests }
}

test("claim on a user tab flips the owner to the session (O4)", async () => {
  const { operations, records, calls } = makeHarness([makeRecord("tab_user", userOwner)])
  const result = await operations.dispatch(undefined, { name: "claim", input: { tabId: "tab_user" } }, "sess-1")
  expect(result).toEqual({ claimed: { tabId: "tab_user", owner: agentOwner("sess-1") } })
  expect(records.get("tab_user")?.owner).toEqual(agentOwner("sess-1"))
  expect(calls).toContain("setOwner:tab_user")
})

test("claim on the session's own tab is idempotent (O6)", async () => {
  const { operations, records, calls } = makeHarness([makeRecord("tab_own", agentOwner("sess-1"))])
  const result = await operations.dispatch(undefined, { name: "claim", input: { tabId: "tab_own" } }, "sess-1")
  expect(result).toEqual({ claimed: { tabId: "tab_own", owner: agentOwner("sess-1") } })
  expect(records.get("tab_own")?.owner).toEqual(agentOwner("sess-1"))
  expect(calls).not.toContain("setOwner:tab_own")
})

test("claim on another session's tab throws BrowserPermissionDenied (O5)", async () => {
  const { operations } = makeHarness([makeRecord("tab_other", agentOwner("sess-2"))])
  await expect(operations.dispatch(undefined, { name: "claim", input: { tabId: "tab_other" } }, "sess-1")).rejects.toBeInstanceOf(
    BrowserPermissionDeniedError,
  )
})

test("setTabOwner flips the owner to ANY user-chosen value (D7)", async () => {
  const { operations, records } = makeHarness([makeRecord("tab_a", userOwner)])
  const result = await operations.dispatch(undefined, { name: "set_tab_owner", input: { tabId: "tab_a", owner: agentOwner("sess-2") } }, "sess-1")
  expect(result).toEqual({ assigned: { tabId: "tab_a", owner: agentOwner("sess-2") } })
  expect(records.get("tab_a")?.owner).toEqual(agentOwner("sess-2"))
  // "Return to me"
  await operations.dispatch(undefined, { name: "set_tab_owner", input: { tabId: "tab_a", owner: userOwner } }, "sess-1")
  expect(records.get("tab_a")?.owner).toEqual(userOwner)
})

test("close with another session's tab throws BrowserPermissionDenied (broker double-check)", async () => {
  const { operations } = makeHarness([makeRecord("tab_other", agentOwner("sess-2"))])
  await expect(operations.dispatch(undefined, { name: "close", input: { tabId: "tab_other" } }, "sess-1")).rejects.toBeInstanceOf(
    BrowserPermissionDeniedError,
  )
})

test("close of the session's own tab destroys it and emits tab.closed (O11)", async () => {
  const { operations, records, calls } = makeHarness([makeRecord("tab_own", agentOwner("sess-1"))])
  const result = await operations.dispatch(undefined, { name: "close", input: { tabId: "tab_own" } }, "sess-1")
  expect(result).toMatchObject({ closed: { tabId: "tab_own", guestsRemaining: 0 } })
  expect(records.has("tab_own")).toBe(false)
  expect(calls).toContain("tabClosed:tab_own")
})

test("duplicate inherits the source tab's owner (O17)", async () => {
  const { operations, records, tabRequests, calls } = makeHarness([makeRecord("tab_src", agentOwner("sess-1"))])
  const result = await operations.dispatch(undefined, { name: "duplicate", input: { tabId: "tab_src" } }, "sess-1")
  const duplicated = result as { duplicated: { tabId: string; url: string } }
  // The renderer registered the new webview; resolveOpen copied the source owner.
  expect(records.get(duplicated.duplicated.tabId)?.owner).toEqual(agentOwner("sess-1"))
  expect(tabRequests[0]?.url).toBe("https://example.com")
  expect(calls).toContain(`activate:${duplicated.duplicated.tabId}`)
})

test("setMuted flips the record's muted flag and syncs (O18)", async () => {
  const { operations, records, calls } = makeHarness([makeRecord("tab_a", userOwner)])
  const result = await operations.dispatch(undefined, { name: "set_muted", input: { tabId: "tab_a", muted: true } }, "sess-1")
  expect(result).toEqual({ muted: { tabId: "tab_a", muted: true } })
  expect(records.get("tab_a")?.muted).toBe(true)
  expect(calls).toContain("setMuted:tab_a")
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
    unregister: (tabId: string) => records.delete(tabId),
  } as unknown as GuestRegistry
  const options: BrowserOperationsOptions = {
    registry,
    sessions,
    recordingDirectory: ".",
    maxResultBytes: 64_000,
    onTabRequest: () => undefined,
    onTabClose: () => undefined,
    onTabClosed: () => undefined,
    onPointerEvent: () => undefined,
  }
  const operations = new BrowserOperations(options)
  return { operations, calls, fireDevtoolsClosed: () => devtoolsClosedHandler?.(), getReattachCount: () => reattachCount }
}

test("open_devtools detaches engine debugger, opens detached DevTools, re-attaches on close", async () => {
  const { operations, calls, fireDevtoolsClosed, getReattachCount } = makeDevtoolsHarness()
  const result = await operations.dispatch(undefined, { name: "open_devtools", input: { tabId: "tab_dt" } }, "sess-1")
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
  await operations.dispatch(undefined, { name: "open_devtools", input: { tabId: "tab_dt" } }, "sess-1")
  calls.length = 0
  // Second open while already open.
  const result = await operations.dispatch(undefined, { name: "open_devtools", input: { tabId: "tab_dt" } }, "sess-1")
  expect((result as any).devtools).toMatchObject({ open: true, focused: true })
  // Must not detach/re-open a second time.
  expect(calls).not.toContain("detach:1")
  expect(calls).not.toContain("openDevTools")
})
