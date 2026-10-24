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

it.effect("six independent Session waiters share one capture and one can cancel safely", () =>
  Effect.gen(function* () {
    const admitted = yield* Deferred.make<void>()
    const attempts = yield* Ref.make(0)
    const appProcessLayer = Layer.mock(AppProcess.Service, {
      run: () => Ref.updateAndGet(attempts, (n) => n + 1).pipe(
        Effect.tap(() => Deferred.succeed(admitted, undefined)),
        Effect.andThen(Effect.never),
      ),
    })
    const snapshotLayer = LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node]), [
      [AppProcess.node, appProcessLayer],
    ])
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const waiters = yield* Effect.forEach(
        Array.from({ length: 6 }),
        () => snapshot.track().pipe(Effect.forkScoped),
      )
      yield* TestClock.withLive(awaitWithTimeout(
        Deferred.await(admitted),
        "shared producer did not start",
        "5 seconds",
      ))
      yield* Fiber.interrupt(waiters[0]!)
      const early = yield* TestClock.withLive(Effect.all(
        waiters.slice(1).map(Fiber.await),
        { concurrency: 5 },
      ).pipe(Effect.timeoutOption("45 millis")))
      expect(Option.isNone(early)).toBe(true)
      expect((yield* Ref.get(attempts))).toBe(1)
      yield* TestClock.adjust("5 minutes")
      const results = yield* TestClock.withLive(awaitWithTimeout(
        Effect.all(waiters.slice(1).map(Fiber.join), { concurrency: 5 }),
        "shared producer failed to release sibling waiters",
        "5 seconds",
      ))
      expect(results).toEqual(Array.from({ length: 5 }, () => undefined))
      expect((yield* Ref.get(attempts))).toBe(1)
    }).pipe(Effect.provide(snapshotLayer), withTmpdirInstance({ git: true }))
  }),
)
