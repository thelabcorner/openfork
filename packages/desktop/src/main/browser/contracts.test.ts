import { expect, test } from "bun:test"
import {
  canClaimTab,
  canDispatchTab,
  isBrokerRequest,
  isBrowserOperationName,
  isCoords,
  isElementTarget,
  isHumanInputSignal,
  isLocator,
  isRefTarget,
  rangeTargets,
  toWireGuestTabState,
  type GuestTabState,
} from "./contracts"

test("isBrowserOperationName covers the 27 ops (canon {name} discriminator)", () => {
  const names = [
    "status",
    "open",
    "claim",
    "set_tab_owner",
    "navigate",
    "resize",
    "set_appearance",
    "snapshot",
    "screenshot",
    "click",
    "type",
    "press",
    "scroll",
    "evaluate",
    "wait_for",
    "recording_start",
    "recording_stop",
    "close",
    "highlight",
    "annotate",
    "query",
    "profiler_start",
    "profiler_stop",
    "react_inspect",
    "refresh",
    "duplicate",
    "set_muted",
  ]
  for (const name of names) expect(isBrowserOperationName(name)).toBe(true)
  expect(isBrowserOperationName("teleport")).toBe(false)
})

test("isBrokerRequest accepts claim / set_tab_owner envelopes with tabId", () => {
  const claim = {
    requestId: "req-1",
    sessionId: "sess-1",
    messageId: "msg-1",
    timeoutMs: 5_000,
    tabId: "tab_1",
    operation: { name: "claim", input: { tabId: "tab_1" } },
  }
  expect(isBrokerRequest(claim)).toBe(true)
  const setOwner = {
    requestId: "req-2",
    sessionId: "sess-1",
    messageId: "msg-2",
    timeoutMs: 5_000,
    operation: { name: "set_tab_owner", input: { tabId: "tab_1", owner: { kind: "user" } } },
  }
  expect(isBrokerRequest(setOwner)).toBe(true)
})

test("toWireGuestTabState carries owner + active + muted", () => {
  const record = {
    runtimeTabId: "tab_1",
    windowId: "win-1",
    owner: { kind: "agent", sessionId: "sess-1" },
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
    muted: true,
    snapshotVersion: 0,
  } satisfies GuestTabState
  const wire = toWireGuestTabState(record, true)
  expect(wire.owner).toEqual({ kind: "agent", sessionId: "sess-1" })
  expect(wire.active).toBe(true)
  expect(wire.muted).toBe(true)
})

test("rangeTargets computes close-left/right/others/all relative to a tab", () => {
  const tabs = ["a", "b", "c", "d"]
  expect(rangeTargets(tabs, "c", "left")).toEqual(["a", "b"])
  expect(rangeTargets(tabs, "c", "right")).toEqual(["d"])
  expect(rangeTargets(tabs, "c", "others")).toEqual(["a", "b", "d"])
  expect(rangeTargets(tabs, "c", "all")).toEqual(["a", "b", "c", "d"])
  expect(rangeTargets(tabs, "a", "left")).toEqual([])
  expect(rangeTargets(tabs, "d", "right")).toEqual([])
  expect(rangeTargets(tabs, "nope", "others")).toEqual(["a", "b", "c", "d"])
  expect(rangeTargets(tabs, "nope", "right")).toEqual([])
})

test("canDispatchTab / canClaimTab ownership gates (O1-O6)", () => {
  expect(canDispatchTab({ kind: "agent", sessionId: "sess-1" }, "sess-1")).toBe("ok")
  expect(canDispatchTab({ kind: "agent", sessionId: "sess-2" }, "sess-1")).toBe("other-agent")
  expect(canDispatchTab({ kind: "user" }, "sess-1")).toBe("user-owned")
  expect(canClaimTab({ kind: "user" }, "sess-1")).toBe("ok")
  expect(canClaimTab({ kind: "agent", sessionId: "sess-1" }, "sess-1")).toBe("idempotent")
  expect(canClaimTab({ kind: "agent", sessionId: "sess-2" }, "sess-1")).toBe("denied")
})

test("isBrokerRequest accepts a valid canonical envelope ({name} op, input nested in operation)", () => {
  const request = {
    requestId: "req-1",
    sessionId: "sess-1",
    messageId: "msg-1",
    timeoutMs: 5_000,
    operation: { name: "click", input: { target: { type: "css", value: "#go" } } },
  }
  expect(isBrokerRequest(request)).toBe(true)
})

test("isBrokerRequest rejects the divergent {op} discriminator envelope", () => {
  const request = {
    requestId: "req-1",
    sessionId: "sess-1",
    messageId: "msg-1",
    timeoutMs: 5_000,
    operation: { op: "click", input: {} },
  }
  expect(isBrokerRequest(request)).toBe(false)
})

test("isBrokerRequest rejects malformed envelopes", () => {
  expect(isBrokerRequest(null)).toBe(false)
  expect(isBrokerRequest("nope")).toBe(false)
  expect(isBrokerRequest({})).toBe(false)
  expect(
    isBrokerRequest({
      requestId: "req-1",
      sessionId: "sess-1",
      messageId: "msg-1",
      timeoutMs: "soon",
      operation: { name: "click", input: {} },
    }),
  ).toBe(false)
  expect(
    isBrokerRequest({
      requestId: "req-1",
      sessionId: "sess-1",
      messageId: "msg-1",
      timeoutMs: 5_000,
      operation: { name: "explode", input: {} },
    }),
  ).toBe(false)
  expect(
    isBrokerRequest({
      requestId: "req-1",
      sessionId: "sess-1",
      messageId: "msg-1",
      timeoutMs: 5_000,
      operation: { name: "click" },
    }),
  ).toBe(false)
})

test("target guards: coords / locator / ref / ElementTarget union", () => {
  expect(isCoords({ x: 1, y: 2 })).toBe(true)
  expect(isCoords({ x: "1", y: 2 })).toBe(false)
  expect(isLocator({ type: "css", value: "#go" })).toBe(true)
  expect(isLocator({ type: "hover", value: "#go" })).toBe(false)
  expect(isRefTarget({ ref: "e7", snapshotVersion: 3 })).toBe(true)
  expect(isRefTarget({ ref: "e7" })).toBe(false)
  expect(isElementTarget({ ref: "e7", snapshotVersion: 3 })).toBe(true)
  expect(isElementTarget({ type: "css", value: "#go" })).toBe(true)
  expect(isElementTarget({ x: 1, y: 2 })).toBe(true)
  expect(isElementTarget({ kind: "ref", ref: "e7" })).toBe(false) // divergent {kind} union is out of contract
})

test("isHumanInputSignal guards pointer/key shapes", () => {
  expect(isHumanInputSignal({ kind: "pointer", x: 1, y: 2, button: 0 })).toBe(true)
  expect(isHumanInputSignal({ kind: "key", key: "a", code: "KeyA" })).toBe(true)
  expect(isHumanInputSignal({ kind: "pointer", x: 1 })).toBe(false)
  expect(isHumanInputSignal(null)).toBe(false)
})
