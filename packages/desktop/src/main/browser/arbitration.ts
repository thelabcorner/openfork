import {
  EXPECTED_INPUT_TTL_MS,
  HUMAN_PREEMPT_WINDOW_MS,
  type Controller,
} from "./types"
export { EXPECTED_INPUT_TTL_MS, HUMAN_PREEMPT_WINDOW_MS } from "./types"
import { BrowserControlInterruptedError } from "./errors"

// T3-style control arbitration. Each tab owns a monotonic control epoch; a
// bump (human preemption, connection supersession, tab reset) kills any
// in-flight agent action. `send()` checks the epoch before AND after every
// debugger command so a preemption mid-command surfaces as
// BrowserControlInterrupted. `sendCleanup()` bypasses the epoch entirely so
// partial input can never leave Chromium with a held key or focus emulation.

export type EpochView = { get(tabId: string): number }

export class ControlEpoch implements EpochView {
  private readonly epochs = new Map<string, number>()

  get(tabId: string) {
    return this.epochs.get(tabId) ?? 0
  }

  bump(tabId: string) {
    const next = this.get(tabId) + 1
    this.epochs.set(tabId, next)
    return next
  }

  delete(tabId: string) {
    this.epochs.delete(tabId)
  }
}

export type DebuggerCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>

// Wraps a raw debugger command with epoch checks. On a bump before the command
// runs, or between command and response, throws BrowserControlInterruptedError.
export function createEpochGuardedSender(epoch: EpochView, command: DebuggerCommand) {
  const send = async (tabId: string, method: string, params?: Record<string, unknown>) => {
    const before = epoch.get(tabId)
    const result = await command(method, params)
    if (epoch.get(tabId) !== before) throw new BrowserControlInterruptedError()
    return result
  }
  // Cleanup commands MUST land even when the epoch was bumped mid-action.
  const sendCleanup = async (tabId: string, method: string, params?: Record<string, unknown>) => {
    void tabId
    return command(method, params)
  }
  return { send, sendCleanup }
}

// --- expected-agent-input queue ---

export type HumanInputSignal = { kind: "pointer"; x: number; y: number; button: number } | { kind: "key"; key: string; code: string }

type ExpectedAgentInput = HumanInputSignal & { expiresAt: number }

const POINTER_TOLERANCE_PX = 1

export function matchesExpectedAgentInput(signal: HumanInputSignal, expected: HumanInputSignal) {
  if (signal.kind !== expected.kind) return false
  if (signal.kind === "pointer" && expected.kind === "pointer") {
    if (signal.button !== expected.button) return false
    return Math.abs(signal.x - expected.x) <= POINTER_TOLERANCE_PX && Math.abs(signal.y - expected.y) <= POINTER_TOLERANCE_PX
  }
  if (signal.kind === "key" && expected.kind === "key") {
    return signal.key === expected.key && signal.code === expected.code
  }
  return false
}

export class ExpectedAgentInputQueue {
  private readonly entries: ExpectedAgentInput[] = []

  push(tabId: string, signal: HumanInputSignal, ttlMs = EXPECTED_INPUT_TTL_MS) {
    this.entries.push({ ...signal, expiresAt: Date.now() + ttlMs })
    void tabId
  }

  private prune() {
    const now = Date.now()
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].expiresAt <= now) this.entries.splice(i, 1)
    }
  }

  // Matches and consumes the first pending expected input for the signal, or
  // null when nothing matched (a real human input).
  consume(signal: HumanInputSignal): HumanInputSignal | null {
    this.prune()
    const index = this.entries.findIndex((entry) => matchesExpectedAgentInput(signal, entry))
    if (index === -1) return null
    const [matched] = this.entries.splice(index, 1)
    if (matched.kind === "pointer") {
      return { kind: "pointer", x: matched.x, y: matched.y, button: matched.button }
    }
    return { kind: "key", key: matched.key, code: matched.code }
  }

  clear() {
    this.entries.length = 0
  }

  get size() {
    return this.entries.length
  }
}

// --- human preemption decision ---

export type HumanPreemptResult = { bumped: boolean; consumed: boolean }

// Guest-posted human-input signal arrives while agent actions may be in
// flight. If it matches a pending expected agent input (the guest's own echo
// of the agent's CDP-dispatched input), consume it and DON'T bump. Otherwise
// the human really took over: bump the epoch (kills in-flight agent actions),
// flip controller to human, open the preemption window.
export function handleHumanInput(
  epoch: ControlEpoch,
  queue: ExpectedAgentInputQueue,
  tabId: string,
  signal: HumanInputSignal,
  now = Date.now(),
): HumanPreemptResult {
  const consumed = queue.consume(signal)
  if (consumed) return { bumped: false, consumed: true }
  epoch.bump(tabId)
  return { bumped: true, consumed: false }
}

export type PreemptWindow = { until: number; controller: Controller }

// Controller bookkeeping per tab: "agent" while an action runs, "human" inside
// a preemption window, "none" otherwise.
export class ControllerState {
  private readonly windows = new Map<string, PreemptWindow>()

  set(tabId: string, controller: Controller, windowMs?: number, now = Date.now()) {
    if (controller === "human") {
      this.windows.set(tabId, { until: now + (windowMs ?? HUMAN_PREEMPT_WINDOW_MS), controller })
      return
    }
    if (controller === "agent") {
      // agent actions are not windows; keep a marker so resolveAgent below works
      this.windows.set(tabId, { until: Number.POSITIVE_INFINITY, controller })
      return
    }
    this.windows.delete(tabId)
  }

  get(tabId: string, now = Date.now()): Controller {
    const window = this.windows.get(tabId)
    if (!window) return "none"
    if (window.controller === "agent") return "agent"
    if (window.until <= now) {
      this.windows.delete(tabId)
      return "none"
    }
    return "human"
  }

  delete(tabId: string) {
    this.windows.delete(tabId)
  }
}

export interface ControlArbiterOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Per-tab control arbitration facade: owns one epoch, one expected-input queue,
 * and one controller state per tab. This is the API the operations layer and
 * the guest registry consume.
 */
export class ControlArbiter {
  private readonly epoch = new ControlEpoch()
  private readonly queue = new ExpectedAgentInputQueue()
  private readonly controllers = new ControllerState()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: ControlArbiterOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  getEpoch(): ControlEpoch {
    return this.epoch
  }

  getExpectedInputs(): ExpectedAgentInputQueue {
    return this.queue
  }

  expectAgentInput(tabId: string, signal: HumanInputSignal) {
    this.queue.push(tabId, signal)
  }

  consumeExpectedAgentInput(tabId: string, signal: HumanInputSignal): boolean {
    void tabId
    return this.queue.consume(signal) !== null
  }

  captureEpoch(tabId: string): number {
    return this.epoch.get(tabId)
  }

  isEpochCurrent(tabId: string, epoch: number): boolean {
    return this.epoch.get(tabId) === epoch
  }

  /** Human input decision + preemption window lifecycle. Async (waits out the window). */
  async handleHumanInput(tabId: string, signal: HumanInputSignal): Promise<void> {
    const result = handleHumanInput(this.epoch, this.queue, tabId, signal, this.now())
    if (!result.bumped) return
    this.controllers.set(tabId, "human", HUMAN_PREEMPT_WINDOW_MS, this.now())
    await this.sleep(HUMAN_PREEMPT_WINDOW_MS)
    // Finalize: never clobber a NEWER human window; only clear our own.
    if (this.controllers.get(tabId, this.now()) === "human") this.controllers.set(tabId, "none")
  }

  controller(tabId: string): Controller {
    return this.controllers.get(tabId, this.now())
  }

  /** Force a controller state. Never clobbers an active human window. */
  setControllerFor(tabId: string, controller: Controller) {
    if (this.controllers.get(tabId, this.now()) === "human") return
    this.controllers.set(tabId, controller)
  }

  setAgent(tabId: string) {
    this.setControllerFor(tabId, "agent")
  }

  /** Clear per-tab state: epoch, controller, and pending expected inputs. */
  reset(tabId: string) {
    this.epoch.delete(tabId)
    this.controllers.delete(tabId)
    this.queue.clear()
  }

  /** Close-driven preemption (D9): the user is closing the tab, so any in-flight
   * agent action must fail with BrowserControlInterrupted — bump the epoch (kills
   * guarded `send` mid-command) and clear controller/queue state. */
  preempt(tabId: string) {
    this.epoch.bump(tabId)
    this.controllers.delete(tabId)
    this.queue.clear()
  }
}
