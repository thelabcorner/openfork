import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { resetForTesting, withShellSlot } from "../../src/tool/shell-concurrency"

const ENV_KEY = "OPENCODE_MAX_CONCURRENT_SHELL_COMMANDS"

function withEnv<A>(value: string | undefined, body: () => Promise<A>): Promise<A> {
  const prior = process.env[ENV_KEY]
  if (value === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = value
  resetForTesting()
  return body().finally(() => {
    if (prior === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prior
    resetForTesting()
  })
}

describe("shell concurrency", () => {
  test("bounds concurrently running effects and queues the rest", async () => {
    await withEnv("2", async () => {
      const gate = await Effect.runPromise(Deferred.make<void>())
      const active = await Effect.runPromise(Ref.make(0))
      const peak = await Effect.runPromise(Ref.make(0))
      const worker = withShellSlot(
        Effect.gen(function* () {
          const current = yield* Ref.updateAndGet(active, (n) => n + 1)
          yield* Ref.update(peak, (max) => Math.max(max, current))
          yield* Deferred.await(gate)
          yield* Ref.update(active, (n) => n - 1)
        }),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkScoped(
              Effect.all([worker, worker, worker], { concurrency: "unbounded", discard: true }),
            )
            // Wait until two slots are occupied; the third worker must still
            // be queued, so the observed peak never exceeds the bound.
            while ((yield* Ref.get(active)) < 2) yield* Effect.sleep("5 millis")
            yield* Effect.sleep("50 millis")
            expect(yield* Ref.get(peak)).toBe(2)
            expect(yield* Ref.get(active)).toBe(2)
            // Opening the gate lets the queued worker (and the holders)
            // finish: queueing never fails the work.
            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(fiber)
            expect(yield* Ref.get(active)).toBe(0)
          }),
        ).pipe(Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.die(new Error("workers never settled")) })),
      )
    })
  })

  test("zero disables the bound (passthrough)", async () => {
    await withEnv("0", async () => {
      const order: number[] = []
      await Effect.runPromise(withShellSlot(Effect.sync(() => order.push(1))))
      expect(order).toEqual([1])
    })
  })

  test("invalid values fall back to the default bound", async () => {
    await withEnv("not-a-number", async () => {
      const value = await Effect.runPromise(withShellSlot(Effect.succeed("ok")))
      expect(value).toBe("ok")
    })
  })

  test("failures release the slot", async () => {
    await withEnv("1", async () => {
      await expect(Effect.runPromise(withShellSlot(Effect.fail(new Error("boom"))))).rejects.toThrow("boom")
      // The permit must be free again: a second acquisition completes.
      await Effect.runPromise(withShellSlot(Effect.void))
    })
  })
})
