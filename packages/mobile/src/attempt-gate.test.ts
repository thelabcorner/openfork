import { describe, expect, test } from "bun:test"
import { createAttemptGate } from "./attempt-gate"

describe("mobile async authentication attempts", () => {
  test("invalidates and aborts superseded pairing, restore and migration requests", () => {
    const gate = createAttemptGate()
    const restore = gate.start()
    expect(restore.current()).toBe(true)
    const pair = gate.start()
    expect(restore.signal.aborted).toBe(true)
    expect(restore.current()).toBe(false)
    expect(pair.current()).toBe(true)
    gate.invalidate()
    expect(pair.signal.aborted).toBe(true)
    expect(pair.current()).toBe(false)
    const migration = gate.start()
    expect(migration.current()).toBe(true)
    expect(migration.signal.aborted).toBe(false)
  })

  test("a delayed completed request cannot become current after a newer operation", async () => {
    const gate = createAttemptGate()
    const old = gate.start()
    let resolve!: () => void
    const pending = new Promise<void>((next) => { resolve = next })
    const commit = pending.then(() => old.current())
    const latest = gate.start()
    resolve()
    expect(await commit).toBe(false)
    expect(latest.current()).toBe(true)
  })
})