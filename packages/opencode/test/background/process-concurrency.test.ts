import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { machineSlotWaitingSnapshot } from "../../src/util/machine-slot-budget"
import {
  BACKGROUND_PROCESS_ENV,
  configuredBackgroundProcessLimit,
  DEFAULT_BACKGROUND_PROCESSES,
  MAX_SAFE_BACKGROUND_PROCESSES,
  MONITOR_PROCESS_ENV,
  configuredMonitorProcessLimit,
  needsBackgroundSnapshotMutationLease,
  DEFAULT_MONITOR_PROCESSES,
  MAX_SAFE_MONITOR_PROCESSES,
  UNSAFE_DISABLE_BACKGROUND_PROCESS_ENV,
  resetBackgroundProcessConcurrencyForTesting,
  withBackgroundProcessSlot,
  withMonitorProcessSlot,
} from "../../src/background/process-concurrency"

describe("background process concurrency", () => {
  test("cancelled monitor waiters release the queue and capacity overrides cannot fork a second pool", async () => {
    const previous = process.env[MONITOR_PROCESS_ENV]
    process.env[MONITOR_PROCESS_ENV] = "1"
    resetBackgroundProcessConcurrencyForTesting()
    const gate = await Effect.runPromise(Deferred.make<void>())
    const started = await Effect.runPromise(Deferred.make<void>())
    let executed = false
    const owner = Effect.runFork(withMonitorProcessSlot(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate))),
    ))
    try {
      await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("5 seconds")))
      // An unrelated Session changing its environment must not mint fresh
      // local permits while the original monitor still owns its permit.
      process.env[MONITOR_PROCESS_ENV] = "8"
      const cancelled = Effect.runFork(withMonitorProcessSlot(Effect.sync(() => { executed = true })))
      const deadline = performance.now() + 3_000
      while (!machineSlotWaitingSnapshot().some((entry) => entry.lane === "openfork-local-monitor-v1")) {
        if (performance.now() > deadline) throw new Error("Monitor cancellation test did not queue")
        await Bun.sleep(10)
      }
      await Effect.runPromise(Fiber.interrupt(cancelled))
      expect(executed).toBe(false)
      expect(machineSlotWaitingSnapshot().filter((entry) => entry.lane === "openfork-local-monitor-v1")).toEqual([])
      await Effect.runPromise(Deferred.succeed(gate, undefined))
      await Effect.runPromise(Fiber.join(owner))
      await Effect.runPromise(withMonitorProcessSlot(Effect.sync(() => { executed = true })))
      expect(executed).toBe(true)
    } finally {
      await Effect.runPromise(Deferred.succeed(gate, undefined))
      await Effect.runPromise(Fiber.interrupt(owner))
      if (previous === undefined) delete process.env[MONITOR_PROCESS_ENV]
      else process.env[MONITOR_PROCESS_ENV] = previous
      resetBackgroundProcessConcurrencyForTesting()
    }
  }, 10_000)

  test("50 queued monitors do not generate 50 machine-lock polling loops", async () => {
    const previous = process.env[MONITOR_PROCESS_ENV]
    process.env[MONITOR_PROCESS_ENV] = "1"
    resetBackgroundProcessConcurrencyForTesting()
    const gate = await Effect.runPromise(Deferred.make<void>())
    const started = await Effect.runPromise(Deferred.make<void>())
    const seen: number[] = []
    const monitor = (id: number) => withMonitorProcessSlot(
      Effect.gen(function* () {
        seen.push(id)
        if (id === 0) yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(gate)
      }),
    )
    const first = Effect.runFork(monitor(0))
    const others: ReturnType<typeof Effect.runFork>[] = []
    try {
      await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("5 seconds")))
      for (let i = 1; i <= 50; i++) others.push(Effect.runFork(monitor(i)))
      // Only one monitor acquires an OS lease. All other local Sessions await
      // the in-memory semaphore, rather than hammering the same lock files.
      const deadline = performance.now() + 3_000
      while (machineSlotWaitingSnapshot().filter((x) => x.lane === "openfork-local-monitor-v1").length < 50) {
        if (performance.now() > deadline) throw new Error("Monitor queue did not fill")
        await Bun.sleep(10)
      }
      expect(seen).toEqual([0])
      expect(machineSlotWaitingSnapshot().filter((x) => x.lane === "openfork-local-monitor-v1").length).toBe(50)
      expect(machineSlotWaitingSnapshot().filter((x) => x.lane === "openfork-monitor-process-v1").length).toBe(0)
      await Effect.runPromise(Deferred.succeed(gate, undefined))
      await Effect.runPromise(Effect.forEach([first, ...others], (fiber) => Fiber.join(fiber), { concurrency: "unbounded" }))
      expect(seen.length).toBe(51)
      expect(seen).toEqual(Array.from({ length: 51 }, (_, i) => i))
      expect(machineSlotWaitingSnapshot().filter((x) => x.lane === "openfork-local-monitor-v1").length).toBe(0)
    } finally {
      await Effect.runPromise(Deferred.succeed(gate, undefined))
      await Effect.runPromise(Effect.forEach([first, ...others], (fiber) => Fiber.interrupt(fiber), { concurrency: "unbounded" }))
      if (previous === undefined) delete process.env[MONITOR_PROCESS_ENV]
      else process.env[MONITOR_PROCESS_ENV] = previous
      resetBackgroundProcessConcurrencyForTesting()
    }
  }, 20_000)

  test("background shells have a separate bounded local queue from monitors", async () => {
    const previous = process.env[BACKGROUND_PROCESS_ENV]
    process.env[BACKGROUND_PROCESS_ENV] = "2"
    resetBackgroundProcessConcurrencyForTesting()
    const gate = await Effect.runPromise(Deferred.make<void>())
    const active: number[] = []
    const operation = (id: number) => withBackgroundProcessSlot(
      Effect.gen(function* () {
        active.push(id)
        yield* Deferred.await(gate)
      }),
    )
    const fibers = Array.from({ length: 20 }, (_, i) => Effect.runFork(operation(i)))
    try {
      const deadline = performance.now() + 4_000
      while (active.length < 2 || machineSlotWaitingSnapshot().filter((x) => x.lane === "openfork-local-background-v1").length < 18) {
        if (performance.now() > deadline) throw new Error("Background queue did not fill")
        await Bun.sleep(10)
      }
      expect(active.slice().sort((a, b) => a - b)).toEqual([0, 1])
      expect(machineSlotWaitingSnapshot().filter((x) => x.lane === "opencode-background-process-v1").length).toBe(0)
      await Effect.runPromise(Deferred.succeed(gate, undefined))
      await Effect.runPromise(Effect.forEach(fibers, (fiber) => Fiber.join(fiber), { concurrency: "unbounded" }))
      // With two permits the filesystem admission races independently.
      // Every submitted job must progress; their *wall-clock start order*
      // is not a strict FIFO guarantee across the two machine permits.
      expect(active.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    } finally {
      await Effect.runPromise(Deferred.succeed(gate, undefined))
      await Effect.runPromise(Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber), { concurrency: "unbounded" }))
      if (previous === undefined) delete process.env[BACKGROUND_PROCESS_ENV]
      else process.env[BACKGROUND_PROCESS_ENV] = previous
      resetBackgroundProcessConcurrencyForTesting()
    }
  }, 20_000)

  test("monitors have a separately bounded process capacity", () => {
    expect(configuredMonitorProcessLimit({})).toBe(DEFAULT_MONITOR_PROCESSES)
    expect(configuredMonitorProcessLimit({ [MONITOR_PROCESS_ENV]: "0" })).toBe(DEFAULT_MONITOR_PROCESSES)
    expect(configuredMonitorProcessLimit({ [MONITOR_PROCESS_ENV]: "1" })).toBe(1)
    expect(configuredMonitorProcessLimit({ [MONITOR_PROCESS_ENV]: "999" })).toBe(MAX_SAFE_MONITOR_PROCESSES)
    expect(configuredMonitorProcessLimit({ [MONITOR_PROCESS_ENV]: "Infinity" })).toBe(DEFAULT_MONITOR_PROCESSES)
  })
  test("monitor observers never hold an unbounded Snapshot mutation lease", () => {
    expect(needsBackgroundSnapshotMutationLease("monitor")).toBe(false)
    expect(needsBackgroundSnapshotMutationLease("shell")).toBe(true)
  })

  test("uses a conservative default", () => {
    expect(configuredBackgroundProcessLimit({})).toBe(DEFAULT_BACKGROUND_PROCESSES)
  })

  test("invalid or zero values cannot disable the guard", () => {
    expect(configuredBackgroundProcessLimit({ [BACKGROUND_PROCESS_ENV]: "0" })).toBe(DEFAULT_BACKGROUND_PROCESSES)
    expect(configuredBackgroundProcessLimit({ [BACKGROUND_PROCESS_ENV]: "nope" })).toBe(DEFAULT_BACKGROUND_PROCESSES)
  })

  test("large overrides are hard capped", () => {
    expect(configuredBackgroundProcessLimit({ [BACKGROUND_PROCESS_ENV]: "999" })).toBe(MAX_SAFE_BACKGROUND_PROCESSES)
  })

  test("disable requires the explicit unsafe switch", () => {
    expect(configuredBackgroundProcessLimit({ [UNSAFE_DISABLE_BACKGROUND_PROCESS_ENV]: "1" })).toBeUndefined()
  })
})
