import { expect, test } from "bun:test"
import {
  ControlArbiter,
  ControlEpoch,
  ControllerState,
  ExpectedAgentInputQueue,
  createEpochGuardedSender,
  handleHumanInput,
  matchesExpectedAgentInput,
} from "./arbitration"
import type { HumanInputSignal } from "./contracts"
import { BrowserControlInterruptedError } from "./errors"

const pointer = (x: number, y: number, button = 0): HumanInputSignal => ({ kind: "pointer", x, y, button })
const key = (key: string, code: string): HumanInputSignal => ({ kind: "key", key, code })

test("matchesExpectedAgentInput: pointer within ±1px + same button; key exact", () => {
  expect(matchesExpectedAgentInput(pointer(100.4, 200.9, 0), pointer(100, 200, 0))).toBe(true)
  expect(matchesExpectedAgentInput(pointer(102, 200, 0), pointer(100, 200, 0))).toBe(false)
  expect(matchesExpectedAgentInput(pointer(100, 200, 1), pointer(100, 200, 0))).toBe(false)
  expect(matchesExpectedAgentInput(key("a", "KeyA"), key("a", "KeyA"))).toBe(true)
  expect(matchesExpectedAgentInput(key("b", "KeyB"), key("a", "KeyA"))).toBe(false)
})

test("ExpectedAgentInputQueue: consume matches once; unknown signal returns null", () => {
  const queue = new ExpectedAgentInputQueue()
  queue.push("tab1", pointer(50, 50))
  expect(queue.consume(pointer(50, 50))).not.toBeNull()
  expect(queue.consume(pointer(50, 50))).toBeNull()
  expect(queue.size).toBe(0)
})

test("ExpectedAgentInputQueue: TTL expiry drops stale entries", () => {
  const queue = new ExpectedAgentInputQueue()
  queue.push("tab1", pointer(10, 10), -1) // already expired
  expect(queue.consume(pointer(10, 10))).toBeNull()
})

test("handleHumanInput: matching expected agent input does NOT bump the epoch", () => {
  const epoch = new ControlEpoch()
  const queue = new ExpectedAgentInputQueue()
  queue.push("tab1", pointer(50, 50))
  const before = epoch.get("tab1")
  const result = handleHumanInput(epoch, queue, "tab1", pointer(50, 50))
  expect(result).toEqual({ bumped: false, consumed: true })
  expect(epoch.get("tab1")).toBe(before)
})

test("handleHumanInput: unmatched input bumps the epoch", () => {
  const epoch = new ControlEpoch()
  const queue = new ExpectedAgentInputQueue()
  const before = epoch.get("tab1")
  const result = handleHumanInput(epoch, queue, "tab1", pointer(5, 5))
  expect(result).toEqual({ bumped: true, consumed: false })
  expect(epoch.get("tab1")).toBe(before + 1)
})

test("createEpochGuardedSender: sendCleanup bypasses epoch bumps; send throws BrowserControlInterrupted", async () => {
  const epoch = new ControlEpoch()
  const commands: string[] = []
  const { send, sendCleanup } = createEpochGuardedSender(epoch, async (method) => {
    commands.push(method)
    return { ok: true }
  })

  // Bump mid-flight: send's post-command check throws.
  const promise = send("tab1", "Input.dispatchMouseEvent")
  epoch.bump("tab1")
  await expect(promise).rejects.toBeInstanceOf(BrowserControlInterruptedError)

  // Cleanup always lands.
  await sendCleanup("tab1", "Emulation.setFocusEmulationEnabled")
  expect(commands).toEqual(["Input.dispatchMouseEvent", "Emulation.setFocusEmulationEnabled"])
})

test("ControllerState: agent marker, human window expiry, none default", () => {
  const state = new ControllerState()
  expect(state.get("tab1")).toBe("none")
  state.set("tab1", "agent")
  expect(state.get("tab1")).toBe("agent")
  state.set("tab1", "human", 750, 1_000)
  expect(state.get("tab1", 1_500)).toBe("human")
  expect(state.get("tab1", 2_000)).toBe("none")
  state.delete("tab1")
  expect(state.get("tab1")).toBe("none")
})

test("ControlArbiter.preempt: bumps the epoch (kills in-flight send) and clears controller/queue", async () => {
  const arbiter = new ControlArbiter()
  arbiter.setAgent("tab1")
  arbiter.expectAgentInput("tab1", pointer(50, 50))
  expect(arbiter.controller("tab1")).toBe("agent")
  expect(arbiter.getExpectedInputs().size).toBe(1)

  const { send } = createEpochGuardedSender(arbiter.getEpoch(), async () => ({ ok: true }))
  const inFlight = send("tab1", "Input.dispatchMouseEvent")
  arbiter.preempt("tab1")
  await expect(inFlight).rejects.toBeInstanceOf(BrowserControlInterruptedError)

  expect(arbiter.controller("tab1")).toBe("none")
  expect(arbiter.getExpectedInputs().size).toBe(0)
})
