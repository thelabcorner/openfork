import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmMemberSession } from "@/swarm/member-session"
import { SwarmMemberSessionRunner } from "@/swarm/member-session-runner"
import { SwarmMemberSessionWake } from "@/swarm/member-session-wake"
import { testEffect } from "../lib/effect"

const emptyResult: SwarmMemberSession.ReconcileResult = {
  scanned: 0,
  bound: 0,
  alreadyBound: 0,
  cleaned: 0,
  preserved: 0,
  failed: [],
}

type ReconcileInput = Parameters<SwarmMemberSession.Interface["reconcile"]>[0]
let reconcileImpl: (input?: ReconcileInput) => Effect.Effect<SwarmMemberSession.ReconcileResult> = () =>
  Effect.succeed(emptyResult)
let reconcileInputs: ReconcileInput[] = []
let listener: EventV2.Subscriber | undefined

const lifecycleMock = Layer.mock(SwarmMemberSession.Service, {
  reconcile: (input?: ReconcileInput) =>
    Effect.suspend(() => {
      reconcileInputs.push(input)
      return reconcileImpl(input)
    }),
} as never)

const eventsMock = Layer.mock(EventV2.Service, {
  listen: (next: EventV2.Subscriber) =>
    Effect.sync(() => {
      listener = next
      return Effect.void
    }),
} as never)

const wakeLayer = SwarmMemberSessionWake.layer
const runnerLayer = Layer.provide(
  SwarmMemberSessionRunner.layer,
  Layer.mergeAll(lifecycleMock, eventsMock, wakeLayer),
)
const it = testEffect(Layer.merge(runnerLayer, wakeLayer))

const settleRunner = (runner: SwarmMemberSessionRunner.Interface) =>
  Effect.gen(function* () {
    yield* runner.start()
    for (let attempt = 0; attempt < 128; attempt++) {
      yield* Effect.yieldNow
      if ((yield* runner.activeReconciliations()) === 0) return
    }
    return yield* Effect.fail(new Error("runner did not settle"))
  })

describe("SwarmMemberSessionRunner", () => {
  it.live("coalesces wake bursts into one active scan plus one fresh rescan", () =>
    Effect.gen(function* () {
      let calls = 0
      let active = 0
      let maxActive = 0
      reconcileImpl = () =>
        Effect.sync(() => {
          calls++
          return emptyResult
        })

      const runner = yield* SwarmMemberSessionRunner.Service
      // Let the layer's automatic startup scan settle before installing the
      // blocking implementation used to probe burst coalescing.
      yield* settleRunner(runner)
      const startupCalls = calls

      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      let blockedCalls = 0
      reconcileImpl = () =>
        Effect.gen(function* () {
          blockedCalls++
          active++
          maxActive = Math.max(maxActive, active)
          if (blockedCalls === 1) {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          } else if (blockedCalls === 2) {
            yield* Deferred.succeed(second, undefined)
          }
          active--
          return emptyResult
        })

      yield* runner.poke()
      yield* Deferred.await(entered)
      expect(yield* runner.activeReconciliations()).toBe(1)

      yield* Effect.all(Array.from({ length: 8 }, () => runner.poke()), { concurrency: "unbounded", discard: true })
      expect(yield* runner.activeReconciliations()).toBe(1)
      expect(blockedCalls).toBe(1)

      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(second)
      yield* settleRunner(runner)

      expect(startupCalls).toBeGreaterThanOrEqual(1)
      expect(blockedCalls).toBe(2)
      expect(maxActive).toBe(1)
      expect(yield* runner.activeReconciliations()).toBe(0)
    }),
  )

  it.live("ignores unrelated events and wakes on Session deletion", () =>
    Effect.gen(function* () {
      let calls = 0
      let wake = yield* Deferred.make<void>()
      reconcileImpl = () =>
        Effect.sync(() => {
          calls++
          return emptyResult
        })

      const runner = yield* SwarmMemberSessionRunner.Service
      yield* settleRunner(runner)
      const baseline = calls
      expect(listener).toBeDefined()

      yield* listener!({ type: "session.next.text.delta" } as never)
      yield* Effect.yieldNow
      expect(calls).toBe(baseline)

      reconcileImpl = () =>
        Effect.gen(function* () {
          calls++
          yield* Deferred.succeed(wake, undefined)
          return emptyResult
        })
      yield* listener!({ type: "session.deleted" } as never)
      yield* Deferred.await(wake)
      yield* settleRunner(runner)
      expect(calls).toBe(baseline + 1)
      expect(yield* runner.activeReconciliations()).toBe(0)
    }),
  )

  it.live("preserves explicit Swarm scope through the recovery wake seam", () =>
    Effect.gen(function* () {
      reconcileInputs = []
      reconcileImpl = () => Effect.succeed(emptyResult)
      const runner = yield* SwarmMemberSessionRunner.Service
      const wake = yield* SwarmMemberSessionWake.Service
      yield* settleRunner(runner)
      reconcileInputs = []

      const swarmID = Swarm.ID.make("swr_runner_scope")
      const completed = yield* Deferred.make<void>()
      reconcileImpl = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(completed, undefined)
          return emptyResult
        })

      expect(yield* wake.request(swarmID)).toBe(true)
      yield* Deferred.await(completed)
      yield* settleRunner(runner)
      expect(reconcileInputs).toEqual([{ swarmID }])
    }),
  )
})
