import { describe, expect, it } from "bun:test"
import { Deferred, Effect } from "effect"
import * as AutoShareQueue from "../../src/session/auto-share-queue"

describe("SessionAutoShareQueue", () => {
  it("bounds queued work and coalesces the same session ID", async () => {
    const seen: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const completed = yield* Deferred.make<void>()
          const owner = yield* AutoShareQueue.make({
            capacity: 1,
            run: (task: { sessionID: string }) =>
              Effect.gen(function* () {
                seen.push(task.sessionID)
                if (task.sessionID === "session-a") {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                }
                if (task.sessionID === "session-b") yield* Deferred.succeed(completed, undefined)
              }),
          })

          expect(yield* owner.offer({ sessionID: "session-a" })).toBe(true)
          yield* Deferred.await(entered)
          expect(yield* owner.offer({ sessionID: "session-a" })).toBe(true)
          expect(yield* owner.offer({ sessionID: "session-b" })).toBe(true)
          expect(yield* owner.offer({ sessionID: "session-c" })).toBe(false)
          yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(completed).pipe(Effect.timeout("2 seconds"))
          expect(seen).toEqual(["session-a", "session-b"])
        }),
      ),
    )
  })

  it("interrupts its worker and queued work when the owning scope closes", async () => {
    let interrupted = false
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const owner = yield* AutoShareQueue.make({
            capacity: 2,
            run: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => (interrupted = true))))
              }),
          })
          yield* owner.offer({ sessionID: "session-a" })
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          yield* Effect.sleep("10 millis")
        }),
      ),
    )
    expect(interrupted).toBe(true)
  })
})
