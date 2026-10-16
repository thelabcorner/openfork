import { describe, expect, test } from "bun:test"
import { LimitRecoveryRunner } from "@/session/limit-recovery-runner"

const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for limit recovery runner")
    await Bun.sleep(5)
  }
}

describe("LimitRecoveryRunner clock", () => {
  test("a contended batch stops after its first failed dispatch per worker", async () => {
    let batches = 0
    let dispatched = 0
    const runner = LimitRecoveryRunner.make({
      nextDueAt: async () => undefined,
      due: async () => ++batches === 1
        ? Array.from({ length: 50 }, (_, n) => ({ sessionID: `ses_busy_${n}`, generation: 1 }))
        : [],
      dispatch: async () => {
        dispatched++
        throw new Error("database is locked")
      },
      concurrency: 2,
    })
    try {
      runner.start()
      await waitUntil(() => dispatched === 2)
      await Bun.sleep(60)
      expect(dispatched).toBe(2)
    } finally {
      runner.stop()
    }
  })

  test("re-arms within bounded backoff after a transient deadline-query error", async () => {
    let reads = 0
    let errors = 0
    const runner = LimitRecoveryRunner.make({
      nextDueAt: async () => {
        if (++reads === 1) throw new Error("database is locked")
        return undefined
      },
      due: async () => [],
      dispatch: async () => {},
      onError: () => { errors++ },
    })
    try {
      runner.start()
      await waitUntil(() => reads >= 2, 2_000)
      expect(errors).toBe(1)
    } finally {
      runner.stop()
    }
  })

  test("backs off failed due claims even when wakes arrive during contention", async () => {
    let attempts = 0
    let errors = 0
    const runner = LimitRecoveryRunner.make({
      nextDueAt: async () => attempts < 2 ? Date.now() : undefined,
      due: async () => attempts < 2 ? [{ sessionID: "ses_busy", generation: 1 }] : [],
      dispatch: async () => {
        if (++attempts === 1) throw new Error("database is locked")
      },
      concurrency: 1,
      onError: () => { errors++ },
    })
    try {
      runner.start()
      await waitUntil(() => attempts === 1)
      runner.wake()
      runner.wake()
      await Bun.sleep(180)
      expect(attempts).toBe(1)
      expect(errors).toBe(1)
      await waitUntil(() => attempts === 2, 2_000)
      expect(errors).toBe(1)
    } finally {
      runner.stop()
    }
  })

  test("coalesces wakes while dispatch is running and never overlaps batches", async () => {
    let dueCalls = 0
    let dispatchCalls = 0
    let activeDispatches = 0
    let maxActiveDispatches = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const runner = LimitRecoveryRunner.make({
      nextDueAt: async () => undefined,
      due: async () => {
        dueCalls++
        return dueCalls === 1 ? [{ sessionID: "ses_runner", generation: 1 }] : []
      },
      dispatch: async () => {
        dispatchCalls++
        activeDispatches++
        maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches)
        await held
        activeDispatches--
      },
      concurrency: 1,
    })

    try {
      runner.start()
      await waitUntil(() => dispatchCalls === 1)

      // Multiple mutations arriving during one batch collapse to one immediate
      // durable re-read; they must not create overlapping ticks or timers.
      runner.wake()
      runner.wake()
      runner.wake()
      release()

      await waitUntil(() => dueCalls >= 2)
      expect(dueCalls).toBe(2)
      expect(dispatchCalls).toBe(1)
      expect(maxActiveDispatches).toBe(1)
    } finally {
      runner.stop()
      release()
    }
  })


  test("invalidates an async arm when a wake takes over the single clock", async () => {
    let dueCalls = 0
    let nextDueCalls = 0
    let resolveFirst!: (value: number | undefined) => void
    const firstDue = new Promise<number | undefined>((resolve) => {
      resolveFirst = resolve
    })

    const runner = LimitRecoveryRunner.make({
      nextDueAt: async () => {
        nextDueCalls++
        if (nextDueCalls === 1) return firstDue
        if (nextDueCalls === 2) return Date.now() + 20
        return undefined
      },
      due: async () => {
        dueCalls++
        return []
      },
      dispatch: async () => {},
      concurrency: 1,
    })

    try {
      runner.start()
      await waitUntil(() => nextDueCalls === 1)

      // This wake owns the clock now. Resolving the older arm afterwards must
      // not install a second timer that can fire after the replacement timer.
      runner.wake()
      await waitUntil(() => nextDueCalls === 2)
      resolveFirst(Date.now() + 1)

      await waitUntil(() => dueCalls >= 3)
      await Bun.sleep(35)
      expect(dueCalls).toBe(3)
    } finally {
      runner.stop()
      resolveFirst(undefined)
    }
  })

  test("stop invalidates an in-flight arm before it can install a timer", async () => {
    let dueCalls = 0
    let resolveDue!: (value: number | undefined) => void
    const heldDue = new Promise<number | undefined>((resolve) => {
      resolveDue = resolve
    })

    const runner = LimitRecoveryRunner.make({
      nextDueAt: async () => heldDue,
      due: async () => {
        dueCalls++
        return []
      },
      dispatch: async () => {},
    })

    runner.start()
    await waitUntil(() => dueCalls === 1)
    runner.stop()
    resolveDue(Date.now())
    await Bun.sleep(25)
    expect(dueCalls).toBe(1)
  })
})