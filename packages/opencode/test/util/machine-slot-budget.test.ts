import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Semaphore } from "effect"
import {
  acquireMachineSlot,
  configuredMachineSlotWaitMs,
  machineSlotWaitingSnapshot,
  MachineSlotWaitTimeoutError,
  withLocalAdmissionSlot,
} from "../../src/util/machine-slot-budget"

const worker = path.join(import.meta.dir, "../fixture/machine-slot-worker.ts")

async function runWorker(input: Record<string, unknown>) {
  const proc = Bun.spawn([process.execPath, worker, JSON.stringify(input)], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ])
  return { code, stdout, stderr }
}

describe("machine slot budget", () => {
  test("interruptible cross-process admission cancels without running or retaining a lease", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-machine-cancel-"))
    const prefix = "machine-cancel"
    const holder = await acquireMachineSlot({ prefix, slots: 1, dir, signal: new AbortController().signal })
    let executed = false
    const waiting = Effect.runFork(Effect.acquireUseRelease(
      Effect.tryPromise((signal) => acquireMachineSlot({
        prefix, slots: 1, dir, signal, retryMs: 20, maxWaitMs: 5_000,
      })).pipe(Effect.orDie, Effect.interruptible),
      () => Effect.sync(() => { executed = true }),
      (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
    ))
    try {
      const until = performance.now() + 2_000
      while (!machineSlotWaitingSnapshot().some((entry) => entry.lane === prefix)) {
        if (performance.now() > until) throw new Error("Machine queue did not fill")
        await Bun.sleep(10)
      }
      await Effect.runPromise(Fiber.interrupt(waiting).pipe(Effect.timeout("2 seconds")))
      expect(executed).toBe(false)
      expect(machineSlotWaitingSnapshot().filter((entry) => entry.lane === prefix)).toEqual([])
    } finally {
      await Effect.runPromise(Fiber.interrupt(waiting))
      await holder.release()
    }
    const next = await acquireMachineSlot({ prefix, slots: 1, dir, signal: new AbortController().signal })
    await next.release()
    await fs.rm(dir, { recursive: true, force: true })
  }, 10_000)

  test("saturated slot probing backs off instead of hammering the lock filesystem", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-slot-backoff-"))
    const holder = await acquireMachineSlot({
      prefix: "backoff", slots: 1, signal: new AbortController().signal, dir,
    })
    let polls = 0
    try {
      await expect(acquireMachineSlot({
        prefix: "backoff", slots: 1,
        signal: new AbortController().signal, dir,
        retryMs: 10, maxWaitMs: 230,
        onWait: () => { polls++ },
      })).rejects.toBeInstanceOf(MachineSlotWaitTimeoutError)
      // Fixed 10 ms polling would require ~23 rounds. Exponential backoff
      // limits metadata pressure while the queue remains fully interruptible.
      expect(polls).toBeGreaterThan(1)
      expect(polls).toBeLessThan(12)
    } finally {
      await holder.release()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("local and machine-wide admission consume one total queue deadline", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-total-queue-"))
    const original = process.env.OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS
    const controller = new AbortController()
    const occupied = await acquireMachineSlot({ prefix: "double-wait", slots: 1, signal: controller.signal, dir })
    const semaphore = Semaphore.makeUnsafe(1)
    const entered = await Effect.runPromise(Deferred.make<void>())
    const holder = Effect.runFork(semaphore.withPermit(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.sleep("110 millis"))),
    ))
    try {
      await Effect.runPromise(Deferred.await(entered))
      process.env.OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS = "240"
      let secondStageBudget = Infinity
      const startedAt = performance.now()
      const blocked = await Effect.runPromise(Effect.exit(withLocalAdmissionSlot(
        semaphore,
        (remainingWaitMs) => {
          secondStageBudget = remainingWaitMs
          return Effect.tryPromise((signal) =>
            acquireMachineSlot({
              prefix: "double-wait", slots: 1, signal, dir,
              retryMs: 10, maxWaitMs: remainingWaitMs,
            }),
          ).pipe(Effect.orDie)
        },
        "test-total-queue",
        1,
      )))
      expect(Exit.isFailure(blocked)).toBe(true)
      expect(secondStageBudget).toBeGreaterThan(0)
      expect(secondStageBudget).toBeLessThan(200)
      // Windows filesystem probes can occasionally exceed the remaining
      // budget; the logical expiration is still shared and must be enforced
      // before execution. Do not assert a real-time OS scheduling guarantee.
      expect(performance.now() - startedAt).toBeLessThan(750)
    } finally {
      if (original === undefined) delete process.env.OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS
      else process.env.OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS = original
      await Effect.runPromise(Fiber.join(holder))
      await occupied.release()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("in-process admission queue also expires without running an unadmitted body or leaking a permit", async () => {
    const semaphore = Semaphore.makeUnsafe(1)
    const entered = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const holder = Effect.runFork(withLocalAdmissionSlot(
      semaphore,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      "test-local-admission",
      1,
    ))
    const prior = process.env.OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS
    try {
      await Effect.runPromise(Deferred.await(entered))
      process.env.OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS = "60"
      let executed = false
      const queued = await Effect.runPromise(Effect.exit(withLocalAdmissionSlot(
        semaphore,
        Effect.sync(() => { executed = true }),
        "test-local-admission",
        1,
      )))
      expect(Exit.isFailure(queued)).toBe(true)
      expect(executed).toBe(false)
      expect(machineSlotWaitingSnapshot().some((row) => row.lane === "test-local-admission")).toBe(false)
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS
      else process.env.OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS = prior
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await Effect.runPromise(Fiber.join(holder))
    }
    await Effect.runPromise(withLocalAdmissionSlot(semaphore, Effect.void, "test-local-admission", 1))
  })

  test("admission deadline configuration is positive and capped", () => {
    expect(configuredMachineSlotWaitMs({})).toBe(120_000)
    expect(configuredMachineSlotWaitMs({ OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS: "0" })).toBe(120_000)
    expect(configuredMachineSlotWaitMs({ OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS: "Infinity" })).toBe(120_000)
    expect(configuredMachineSlotWaitMs({ OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS: "99999999" })).toBe(600_000)
    expect(configuredMachineSlotWaitMs({ OPENCODE_MAX_PROCESS_QUEUE_WAIT_MS: "137" })).toBe(137)
  })

  test("occupied permit times out without leaking queue ownership", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-slot-"))
    try {
      const holder = await acquireMachineSlot({ prefix: "occupied", slots: 1, signal: new AbortController().signal, dir })
      try {
        const pending = acquireMachineSlot({ prefix: "occupied", slots: 1, signal: new AbortController().signal, dir, retryMs: 10, maxWaitMs: 50 })
        expect(machineSlotWaitingSnapshot().some((row) => row.lane === "occupied")).toBe(true)
        await expect(pending).rejects.toBeInstanceOf(MachineSlotWaitTimeoutError)
        expect(machineSlotWaitingSnapshot().some((row) => row.lane === "occupied")).toBe(false)
      } finally {
        await holder.release()
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("cancellation while queued is prompt, with no leaked permits", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-slot-"))
    try {
      const holder = await acquireMachineSlot({ prefix: "cancelled", slots: 1, signal: new AbortController().signal, dir })
      const controller = new AbortController()
      const pending = acquireMachineSlot({ prefix: "cancelled", slots: 1, signal: controller.signal, dir, retryMs: 10 })
      controller.abort(new Error("cancel queued command"))
      try {
        await expect(pending).rejects.toThrow("cancel queued command")
      } finally {
        await holder.release()
      }
      const admitted = await acquireMachineSlot({ prefix: "cancelled", slots: 1, signal: new AbortController().signal, dir })
      await admitted.release()
      expect(machineSlotWaitingSnapshot().some((row) => row.lane === "cancelled")).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("unexpected filesystem failure cannot become an infinite queue", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-slot-"))
    try {
      const invalidRoot = path.join(dir, "file")
      await fs.writeFile(invalidRoot, "file")
      await expect(acquireMachineSlot({
        prefix: "bad-root",
        slots: 1,
        signal: new AbortController().signal,
        dir: invalidRoot,
        maxWaitMs: 1000,
      })).rejects.toMatchObject({ code: expect.stringMatching(/ENOTDIR|EEXIST/) })
      expect(machineSlotWaitingSnapshot().some((row) => row.lane === "bad-root")).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("serializes independent processes through one machine-wide slot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-machine-slot-"))
    const locks = path.join(root, "locks")
    const active = path.join(root, "active")
    const overlap = path.join(root, "overlap")
    const done = path.join(root, "done")
    const input = {
      prefix: `test-${Date.now()}-${Math.random()}`,
      slots: 1,
      dir: locks,
      holdMs: 150,
      active,
      overlap,
      done,
    }

    try {
      const results = await Promise.all([runWorker(input), runWorker(input), runWorker(input)])
      for (const result of results) expect(result.code, result.stderr).toBe(0)
      const overlapped = await fs.readFile(overlap, "utf8").catch(() => "")
      expect(overlapped).toBe("")
      const completed = (await fs.readFile(done, "utf8")).trim().split(/\r?\n/).filter(Boolean)
      expect(completed).toHaveLength(3)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
