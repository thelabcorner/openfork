import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Snapshot } from "../../src/snapshot"
import { withTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

it.effect("cancelling the first snapshot waiter does not cancel a sibling or the shared producer", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>()
    const secondStarted = yield* Deferred.make<void>()
    const attempts = yield* Ref.make(0)
    const appProcessLayer = Layer.mock(AppProcess.Service, {
      run: () =>
        Ref.updateAndGet(attempts, (value) => value + 1).pipe(
          Effect.flatMap((attempt) =>
            Deferred.succeed(attempt === 1 ? firstStarted : secondStarted, undefined),
          ),
          Effect.andThen(Effect.never),
        ),
    })
    const snapshotLayer = LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node]), [
      [AppProcess.node, appProcessLayer],
    ])

    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const first = yield* snapshot.track().pipe(Effect.forkScoped)
      yield* TestClock.withLive(
        awaitWithTimeout(Deferred.await(firstStarted), "first Git capture never started", "5 seconds"),
      )
      const sibling = yield* snapshot.track().pipe(Effect.forkScoped)
      yield* Fiber.interrupt(first)
      const early = yield* TestClock.withLive(
        Fiber.await(sibling).pipe(Effect.timeoutOption("30 millis")),
      )
      // In particular, the abandoned caller must NOT interrupt other sessions.
      expect(Option.isNone(early)).toBe(true)
      expect((yield* Ref.get(attempts))).toBe(1)

      yield* TestClock.adjust("5 minutes")
      expect(yield* TestClock.withLive(
        awaitWithTimeout(Fiber.join(sibling), "shared producer did not time out", "5 seconds"),
      )).toBeUndefined()

      const fresh = yield* snapshot.track().pipe(Effect.forkScoped)
      yield* TestClock.withLive(
        awaitWithTimeout(Deferred.await(secondStarted), "expired capture was still cached", "5 seconds"),
      )
      expect((yield* Ref.get(attempts))).toBe(2)
      yield* TestClock.adjust("5 minutes")
      expect(yield* TestClock.withLive(
        awaitWithTimeout(Fiber.join(fresh), "fresh capture did not time out", "5 seconds"),
      )).toBeUndefined()
    }).pipe(Effect.provide(snapshotLayer), withTmpdirInstance({ git: true }))
  }),
)
