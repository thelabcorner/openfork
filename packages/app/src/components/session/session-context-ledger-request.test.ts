import { describe, expect, test } from "bun:test"
import { createSessionContextLedgerRequest } from "./session-context-ledger-request"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("session context ledger request coordination", () => {
  test("coalesces simultaneous visibility and reactivation reads for a session", async () => {
    const pending = deferred<number>()
    let loads = 0
    const values: number[] = []
    const reader = createSessionContextLedgerRequest({
      load: () => {
        loads++
        return pending.promise
      },
      currentSession: () => "a",
      receive: (value: number) => values.push(value),
      error: () => { throw new Error("Unexpected read failure") },
    })
    const first = reader.read("a")
    const second = reader.read("a")
    expect(second).toBe(first)
    await Promise.resolve()
    expect(loads).toBe(1)
    pending.resolve(42)
    await first
    expect(values).toEqual([42])
  })

  test("serializes a fresh post-settlement read and discards the older snapshot", async () => {
    const old = deferred<number>()
    const fresh = deferred<number>()
    const values: number[] = []
    let calls = 0
    let inFlight = 0
    let maxInFlight = 0
    const reader = createSessionContextLedgerRequest({
      load: async () => {
        const source = ++calls === 1 ? old : fresh
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        try {
          return await source.promise
        } finally {
          inFlight--
        }
      },
      currentSession: () => "a",
      receive: (value: number) => values.push(value),
      error: () => { throw new Error("Unexpected read failure") },
    })
    const first = reader.read("a")
    await Promise.resolve()
    const second = reader.read("a", true)
    const repeated = reader.read("a", true)
    expect(repeated).toBe(second)
    await Promise.resolve()
    expect(calls).toBe(1)
    old.resolve(1)
    await first
    expect(values).toEqual([])
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(2)
    fresh.resolve(2)
    await second
    expect(values).toEqual([2])
    expect(maxInFlight).toBe(1)
  })

  test("session switch and unmount invalidate outstanding results and trailing requests", async () => {
    const pending = deferred<number>()
    const values: number[] = []
    let loads = 0
    let currentSession = "a"
    const reader = createSessionContextLedgerRequest({
      load: () => {
        loads++
        return pending.promise
      },
      currentSession: () => currentSession,
      receive: (value: number) => values.push(value),
      error: () => { throw new Error("Unexpected read failure") },
    })
    const first = reader.read("a")
    await Promise.resolve()
    const trailing = reader.read("a", true)
    currentSession = "b"
    reader.invalidate()
    pending.resolve(1)
    await Promise.all([first, trailing])
    expect(values).toEqual([])
    expect(loads).toBe(1)
    await reader.read(undefined)
    expect(values).toEqual([])
  })

  test("ignores superseded errors but reports the current error", async () => {
    const old = deferred<number>()
    const fresh = deferred<number>()
    const errors: string[] = []
    let calls = 0
    const reader = createSessionContextLedgerRequest({
      load: () => ++calls === 1 ? old.promise : fresh.promise,
      currentSession: () => "a",
      receive: () => {},
      error: (reason) => errors.push(String(reason)),
    })
    const first = reader.read("a")
    await Promise.resolve()
    const second = reader.read("a", true)
    old.reject("stale")
    await first
    expect(errors).toEqual([])
    await Promise.resolve()
    fresh.reject("current")
    await second
    expect(errors).toEqual(["current"])
  })

  test("A to B to A reactivation never resurrects stale A or old queued work", async () => {
    const abandoned = deferred<number>()
    const current = deferred<number>()
    const values: number[] = []
    let currentSession = "a"
    let calls = 0
    const reader = createSessionContextLedgerRequest({
      load: () => ++calls === 1 ? abandoned.promise : current.promise,
      currentSession: () => currentSession,
      receive: (value: number) => values.push(value),
      error: () => { throw new Error("Unexpected read failure") },
    })
    const old = reader.read("a")
    await Promise.resolve()
    const queued = reader.read("a", true)
    currentSession = "b"
    reader.invalidate()
    currentSession = "a"
    const newRead = reader.read("a")
    await Promise.resolve()
    abandoned.resolve(1)
    await Promise.all([old, queued])
    expect(values).toEqual([])
    expect(calls).toBe(2)
    current.resolve(2)
    await newRead
    expect(values).toEqual([2])
  })
})
