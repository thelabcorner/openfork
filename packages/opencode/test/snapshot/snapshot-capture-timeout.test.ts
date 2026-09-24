import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { Deferred, Effect, Fiber, Layer, Logger, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Snapshot } from "../../src/snapshot"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const CAPTURE_TIMEOUT = "5 minutes"
const SAFETY_TIMEOUT = "5 seconds"

const timeoutWarnings = (messages: unknown[]) =>
  messages.filter((message) => Array.isArray(message) && message[0] === "snapshot capture timed out")

it.effect("times out a stuck capture, warns once, and starts a fresh capture on the next call", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>()
    const secondStarted = yield* Deferred.make<void>()
    const initAttempts = yield* Ref.make(0)
    const messages: unknown[] = []
    const appProcessLayer = Layer.mock(AppProcess.Service, {
      run: () =>
        Ref.updateAndGet(initAttempts, (value) => value + 1).pipe(
          Effect.flatMap((attempt) => {
            if (attempt === 1) return Deferred.succeed(firstStarted, undefined)
            if (attempt === 2) return Deferred.succeed(secondStarted, undefined)
            return Effect.void
          }),
          Effect.andThen(Effect.never),
        ),
    })
    const snapshotLayer = LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node]), [
      [AppProcess.node, appProcessLayer],
    ])
    const loggerLayer = Logger.layer([
      Logger.make<unknown, void>((options) => {
        messages.push(options.message)
      }),
    ])

    return yield* Effect.gen(function* () {
      const test = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      yield* TestClock.withLive(snapshot.diagnostics())

      const first = yield* snapshot.track().pipe(Effect.forkScoped)
      yield* TestClock.withLive(
        awaitWithTimeout(Deferred.await(firstStarted), "first capture did not start", SAFETY_TIMEOUT),
      )
      expect((yield* snapshot.diagnostics()).captures).toBe(1)

      yield* TestClock.adjust(CAPTURE_TIMEOUT)
      const firstResult = yield* TestClock.withLive(
        awaitWithTimeout(Fiber.join(first), "first capture did not time out", SAFETY_TIMEOUT),
      )
      expect(firstResult).toBeUndefined()
      expect(timeoutWarnings(messages)).toEqual([
        [
          "snapshot capture timed out",
          expect.objectContaining({
            directory: test.directory,
            captures: 1,
          }),
        ],
      ])

      const afterFirst = yield* snapshot.diagnostics()
      const second = yield* snapshot.track().pipe(Effect.forkScoped)
      const secondOutcome = yield* TestClock.withLive(
        awaitWithTimeout(
          Effect.race(
            Deferred.await(secondStarted).pipe(Effect.as("started")),
            Fiber.join(second).pipe(Effect.as("returned")),
          ),
          "second capture did not start",
          SAFETY_TIMEOUT,
        ),
      )
      const afterSecond = yield* snapshot.diagnostics()
      expect({
        outcome: secondOutcome,
        captures: afterSecond.captures - afterFirst.captures,
        cacheHits: afterSecond.cacheHits - afterFirst.cacheHits,
      }).toEqual({ outcome: "started", captures: 1, cacheHits: 0 })

      yield* TestClock.adjust(CAPTURE_TIMEOUT)
      const secondResult = yield* TestClock.withLive(
        awaitWithTimeout(Fiber.join(second), "second capture did not time out", SAFETY_TIMEOUT),
      )
      expect(secondResult).toBeUndefined()
      expect((yield* snapshot.diagnostics()).captures).toBe(2)
      expect(timeoutWarnings(messages)).toHaveLength(2)
    }).pipe(Effect.provide(loggerLayer), Effect.provide(snapshotLayer), withTmpdirInstance({ git: true }))
  }),
)
