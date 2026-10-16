import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { awaitShellRegistration, withShellJobLifecycle } from "../../src/background/shell-job"

describe("shell job admission receipts", () => {
  test("cancelling queued work revokes monitor delivery even without spawning", async () => {
    const receipt = await Effect.runPromise(Deferred.make<boolean>())
    const queued = await Effect.runPromise(Deferred.make<void>())
    let disposed = 0
    const run = withShellJobLifecycle(
      Deferred.succeed(queued, undefined).pipe(Effect.andThen(Effect.never)),
      receipt,
      Effect.sync(() => { disposed++ }),
    )
    const fiber = Effect.runFork(run)
    await Effect.runPromise(Deferred.await(queued))
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds")))
    expect(disposed).toBe(1)
    expect(await Effect.runPromise(awaitShellRegistration(receipt, 50))).toBe(false)
  })

  test("admitted, short-lived work keeps true spawn receipt and disposes exactly once", async () => {
    const receipt = await Effect.runPromise(Deferred.make<boolean>())
    let disposed = 0
    const outcome = await Effect.runPromise(withShellJobLifecycle(
      Deferred.succeed(receipt, true).pipe(Effect.as("finished")),
      receipt,
      Effect.sync(() => { disposed++ }),
    ))
    expect(outcome).toBe("finished")
    expect(await Effect.runPromise(awaitShellRegistration(receipt, 50))).toBe(true)
    expect(disposed).toBe(1)
  })

  test("startup failure releases delivery and resolves the receipt without claiming spawn", async () => {
    const receipt = await Effect.runPromise(Deferred.make<boolean>())
    let disposed = 0
    const exit = await Effect.runPromise(Effect.exit(withShellJobLifecycle(
      Effect.fail(new Error("spawn failed")),
      receipt,
      Effect.sync(() => { disposed++ }),
    )))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(disposed).toBe(1)
    expect(await Effect.runPromise(awaitShellRegistration(receipt, 50))).toBe(false)
  })

  test("preserves proof even if the shell has already exited and unregistered", async () => {
    const receipt = await Effect.runPromise(Deferred.make<boolean>())
    await Effect.runPromise(Deferred.succeed(receipt, true))
    expect(await Effect.runPromise(awaitShellRegistration(receipt, 50))).toBe(true)
  })

  test("a startup failure signals not admitted instead of polling", async () => {
    const receipt = await Effect.runPromise(Deferred.make<boolean>())
    await Effect.runPromise(Deferred.succeed(receipt, false))
    expect(await Effect.runPromise(awaitShellRegistration(receipt, 50))).toBe(false)
  })

  test("a queued launch returns promptly at its admission window without consuming a permit", async () => {
    const receipt = await Effect.runPromise(Deferred.make<boolean>())
    const startedAt = performance.now()
    expect(await Effect.runPromise(awaitShellRegistration(receipt, 35))).toBe(false)
    expect(performance.now() - startedAt).toBeLessThan(500)
    // The background job may still later be admitted. No Session-side
    // polling is needed and the first launch response is not rewritten.
    await Effect.runPromise(Deferred.succeed(receipt, true))
    expect(await Effect.runPromise(awaitShellRegistration(receipt, 35))).toBe(true)
  })

  test("many concurrent launches share one producer signal without status reads", async () => {
    const receipt = await Effect.runPromise(Deferred.make<boolean>())
    const queued = Array.from({ length: 100 }, () => awaitShellRegistration(receipt, 1_000))
    const run = Effect.runPromise(Effect.all(queued, { concurrency: "unbounded" }))
    await Effect.runPromise(Deferred.succeed(receipt, true))
    expect(await run).toEqual(Array.from({ length: 100 }, () => true))
  })
})