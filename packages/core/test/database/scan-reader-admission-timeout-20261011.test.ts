import { test, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { makeLeasedReaderPool } from "../../src/database/scan-read-pool"

test("bounded scanner backlog fails while the only lease is held, then recovers with no permit leak", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let created = 0
    const pool = yield* makeLeasedReaderPool(1, () => Effect.sync(() => ++created), 75)
    const held = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const first = yield* pool.withLease((value) => Effect.gen(function* () {
      yield* Deferred.succeed(held, undefined)
      yield* Deferred.await(release)
      return value
    })).pipe(Effect.forkScoped)
    yield* Deferred.await(held)
    const began = performance.now()
    const timedOut = yield* Effect.exit(pool.withLease((value) => Effect.succeed(value)))
    expect(Exit.isFailure(timedOut)).toBe(true)
    expect(performance.now() - began).toBeLessThan(1_000)
    expect(created).toBe(1)
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(first)).toBe(1)
    // Timeout must never install a release finalizer for a permit it did not
    // receive; the next admitted request must reuse the owned reader slot.
    expect(yield* pool.withLease((value) => Effect.succeed(value))).toBe(1)
    expect(created).toBe(1)
  })))
}, 7_000)
