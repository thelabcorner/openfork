import { describe, expect, test } from "bun:test"
import { DebuggerManager, type ChromeDebugger, type ChromeRuntime } from "./debugger"

function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>()
  return {
    api: {
      addListener: (listener: T) => void listeners.add(listener),
      removeListener: (listener: T) => void listeners.delete(listener),
    },
    count: () => listeners.size,
    emit: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args)
    },
  }
}

function harness() {
  const events = event<(source: { tabId: number; sessionId?: string }, method: string, params?: unknown) => void>()
  const detaches = event<(source: { tabId: number }, reason: string) => void>()
  const attachCallbacks: Array<() => void> = []
  const detachCallbacks: Array<() => void> = []
  const commands: Array<{ target: unknown; method: string; params: unknown }> = []
  let attachCalls = 0
  const api: ChromeDebugger = {
    attach: (_target, _version, cb) => {
      attachCalls++
      attachCallbacks.push(cb)
    },
    detach: (_target, cb) => detachCallbacks.push(cb),
    sendCommand: (target, method, params, cb) => {
      commands.push({ target, method, params })
      cb({ ok: true })
    },
    getTargets: (cb) => cb([]),
    onEvent: events.api,
    onDetach: detaches.api,
  }
  const runtime: ChromeRuntime = { get lastError() { return undefined } }
  const manager = new DebuggerManager({ debuggerApi: api, runtime })
  return { manager, events, detaches, attachCallbacks, detachCallbacks, commands, attachCalls: () => attachCalls }
}

describe("DebuggerManager optimized attachment lifecycle", () => {
  test("coalesces concurrent attach requests and does not enable Target auto-attach", async () => {
    const h = harness()
    const first = h.manager.attach(42)
    const second = h.manager.attach(42)
    expect(h.attachCalls()).toBe(1)
    expect(h.events.count()).toBe(0)
    h.attachCallbacks[0]!()
    await Promise.all([first, second])
    expect(h.manager.isAttached(42)).toBe(true)
    expect(h.commands).toEqual([])
  })

  test("detach racing an attach waits for attach and then detaches exactly once", async () => {
    const h = harness()
    const attaching = h.manager.attach(7)
    const detaching = h.manager.detach(7)
    expect(h.detachCallbacks).toHaveLength(0)
    h.attachCallbacks[0]!()
    await attaching
    await Promise.resolve()
    expect(h.detachCallbacks).toHaveLength(1)
    h.detachCallbacks[0]!()
    await detaching
    expect(h.manager.isAttached(7)).toBe(false)
  })

  test("external onDetach clears local attachment without a general CDP event listener", async () => {
    const h = harness()
    const attaching = h.manager.attach(9)
    h.attachCallbacks[0]!()
    await attaching
    h.detaches.emit({ tabId: 9 }, "target_closed")
    expect(h.manager.isAttached(9)).toBe(false)
    expect(h.events.count()).toBe(0)
  })
})
