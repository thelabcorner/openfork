import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Ref } from "effect"
import { makeLeasedReaderPool } from "@opencode-ai/core/database/scan-read-pool"

test("read pool bounds active callbacks and never shares an active connection", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const active = yield* Ref.make(0)
    const peak = yield* Ref.make(0)
    const finished = yield* Ref.make(0)
    const live = yield* Ref.make(new Set<number>())
    const pool = yield* makeLeasedReaderPool(3, (slot) => Effect.sync(() => ({ slot })))
    const jobs = yield* Effect.forEach(Array.from({ length: 30 }, (_, i) => i), (i) =>
      Effect.forkScoped(pool.withLease((reader) => Effect.gen(function* () {
        const occupied = yield* Ref.get(live)
        expect(occupied.has(reader.slot)).toBe(false)
        yield* Ref.set(live, new Set([...occupied, reader.slot]))
        const running = yield* Ref.updateAndGet(active, (n) => n + 1)
        yield* Ref.update(peak, (n) => Math.max(n, running))
        yield* Effect.sleep("3 millis")
        const current = yield* Ref.get(live)
        expect(current.has(reader.slot)).toBe(true)
        yield* Ref.set(live, new Set([...current].filter((slot) => slot !== reader.slot)))
        yield* Ref.update(active, (n) => n - 1)
        yield* Ref.update(finished, (n) => n + 1)
        return reader.slot
      }))),
    )
    const result = yield* Fiber.joinAll(jobs)
    expect(result).toHaveLength(30)
    expect(new Set(result).size).toBe(3)
    expect(yield* Ref.get(finished)).toBe(30)
    expect((yield* Ref.get(live)).size).toBe(0)
    expect(yield* Ref.get(peak)).toBe(3)
  })))
})

test("cancelled queued reader leaves no reservation; exceptions release the acquired slot", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let opens = 0
    const pool = yield* makeLeasedReaderPool(1, () => Effect.sync(() => ({ id: ++opens })))
    const occupied = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const first = yield* Effect.forkScoped(pool.withLease((reader) => Effect.gen(function* () {
      yield* Deferred.succeed(occupied, undefined)
      yield* Deferred.await(release)
      return reader.id
    })))
    yield* Deferred.await(occupied)
    const queued = yield* Effect.forkScoped(pool.withLease(() => Effect.succeed("should not start")))
    yield* Fiber.interrupt(queued)
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(first)).toBe(1)
    const failed = yield* Effect.exit(pool.withLease(() => Effect.fail("test error")))
    expect(Exit.isFailure(failed)).toBe(true)
    const fresh = yield* pool.withLease((reader) => Effect.succeed(reader.id))
    expect(fresh).toBe(1)
    expect(opens).toBe(1)
  })))
})

test("failed and interrupted reader initialization release their slots for retry", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let attempts = 0
    const entered = yield* Deferred.make<void>()
    const never = yield* Deferred.make<void>()
    const pool = yield* makeLeasedReaderPool(1, () => Effect.gen(function* () {
      attempts++
      if (attempts === 1) return yield* Effect.die(new Error("synthetic open failure"))
      if (attempts === 2) {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(never)
      }
      return { id: 17 }
    }))
    const failed = yield* Effect.exit(pool.withLease((reader) => Effect.succeed(reader.id)))
    expect(Exit.isFailure(failed)).toBe(true)
    const interrupted = yield* pool.withLease((reader) => Effect.succeed(reader.id)).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(interrupted)
    expect(yield* pool.withLease((reader) => Effect.succeed(reader.id))).toBe(17)
    expect(attempts).toBe(3)
  })))
})
