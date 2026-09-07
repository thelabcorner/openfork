import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { lockTableSize, withFileLocks } from "../../src/tool/file-lock"

describe("tool.file-lock", () => {
  test("evicts idle entries instead of growing without bound", async () => {
    const before = lockTableSize()
    await Effect.runPromise(withFileLocks(["/a", "/b", "/a"], Effect.void))
    expect(lockTableSize()).toBe(before)
  })
  test("releases every lock when the holder is interrupted", async () => {
    const before = lockTableSize()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const fiber = yield* withFileLocks(["/x"], Deferred.await(gate)).pipe(Effect.forkScoped)
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
          // A leaked lock would hang here and trip bun's test timeout instead.
          const done = yield* withFileLocks(["/x"], Effect.succeed("ok"))
          expect(done).toBe("ok")
        }),
      ),
    )
    expect(lockTableSize()).toBe(before)
  })
  test("serializes overlapping sections in acquisition order", async () => {
    const seen: string[] = []
    await Effect.runPromise(
      Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const first = yield* withFileLocks(["/s"], Effect.gen(function* () {
          seen.push("first-in")
          yield* Deferred.await(gate)
          seen.push("first-out")
        })).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        const second = yield* withFileLocks(["/s"], Effect.sync(() => {
          seen.push("second")
        })).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(seen).toEqual(["first-in", "first-out", "second"])
      }),
      ),
    )
  })
})
