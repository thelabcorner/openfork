import { expect, test } from "bun:test"
import {
  isBrokerRequest,
  isBrowserOperationName,
  isCoords,
  isElementTarget,
  isHumanInputSignal,
  isLocator,
  isRefTarget,
} from "./contracts"

test("isBrowserOperationName covers the 21 ops (canon {name} discriminator)", () => {
  const names = [
    "status",
    "open",
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
  ]
  for (const name of names) expect(isBrowserOperationName(name)).toBe(true)
  expect(isBrowserOperationName("teleport")).toBe(false)
})

test("isBrokerRequest accepts a valid canonical envelope ({name} op, top-level input)", () => {
  const request = {
    requestId: "req-1",
    sessionId: "sess-1",
    messageId: "msg-1",
    timeoutMs: 5_000,
    operation: { name: "click", input: { target: { type: "css", value: "#go" } } },
    input: {},
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
    input: {},
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
      input: {},
    }),
  ).toBe(false)
  expect(
    isBrokerRequest({
      requestId: "req-1",
      sessionId: "sess-1",
      messageId: "msg-1",
      timeoutMs: 5_000,
      operation: { name: "explode", input: {} },
      input: {},
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
