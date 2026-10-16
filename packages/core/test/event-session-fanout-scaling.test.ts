import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Ref, Schema } from "effect"
import { EventV2 } from "../src/event"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { testEffect } from "./lib/effect"

// Characterization of the live synchronous EventV2 listener boundary.
// These are deliberately not CI timing thresholds: numbers depend on CPU
// contention and Bun's scheduler. The exact delivery counts are the gate.
const Delta = EventV2.define({
  type: "test.session-fanout.delta",
  schema: { sessionID: Schema.String, index: Schema.Number },
})
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

describe("EventV2 synchronous fanout scaling", () => {
  it.live("characterizes session-shaped subscriber fanout with exact delivery", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const counts = [0, 1, 10, 50, 100]
      const iterations = 600
      const results: Array<{ listeners: number; elapsedMs: number; eventsPerSecond: number }> = []
      for (const count of counts) {
        let observed = 0
        const unsubs = yield* Effect.all(
          Array.from({ length: count }, () =>
            events.listenType(Delta, () => Effect.sync(() => { observed++ })),
          ),
        )
        const start = performance.now()
        for (let index = 0; index < iterations; index++) {
          yield* events.publish(Delta, { sessionID: `ses_${index % 25}`, index })
        }
        const elapsedMs = performance.now() - start
        for (const off of unsubs) yield* off
        expect(observed).toBe(count * iterations)
        results.push({ listeners: count, elapsedMs, eventsPerSecond: Math.round(iterations * 1000 / elapsedMs) })
      }
      console.log("[session-fanout-scaling]", JSON.stringify(results))
    }),
  )

  it.live("session-indexed fanout delivers exactly once without waking unrelated sessions", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const perSession = Array.from({ length: 100 }, () => 0)
      const unsubscribers = yield* Effect.all(
        perSession.map((_, sessionIndex) =>
          events.listenSessionType(Delta, `ses_${sessionIndex}`, (event) =>
            Effect.sync(() => {
              expect(event.data.sessionID).toBe(`ses_${sessionIndex}`)
              perSession[sessionIndex]!++
            }),
          ),
        ),
      )
      const started = performance.now()
      for (let index = 0; index < 600; index++) {
        yield* events.publish(Delta, { sessionID: `ses_${index % 25}`, index })
      }
      const elapsedMs = performance.now() - started
      console.log("[session-indexed-fanout]", JSON.stringify({
        listeners: 100,
        events: 600,
        elapsedMs,
        eventsPerSecond: Math.round(600_000 / elapsedMs),
      }))
      expect(perSession.reduce((sum, count) => sum + count, 0)).toBe(600)
      expect(perSession.slice(0, 25).every((count) => count === 24)).toBe(true)
      expect(perSession.slice(25).every((count) => count === 0)).toBe(true)
      for (const off of unsubscribers) yield* off
      yield* events.publish(Delta, { sessionID: "ses_0", index: 600 })
      expect(perSession[0]).toBe(24)
    }),
  )

  it.live("an unrelated session-indexed suspended observer cannot stall publication", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const release = yield* Deferred.make<void>()
      let invoked = 0
      const off = yield* events.listenSessionType(Delta, "ses_b", () =>
        Effect.sync(() => { invoked++ }).pipe(Effect.andThen(Deferred.await(release))),
      )
      try {
        yield* events.publish(Delta, { sessionID: "ses_a", index: 1 }).pipe(
          Effect.timeout("2 seconds"),
        )
        expect(invoked).toBe(0)
      } finally {
        yield* Deferred.succeed(release, undefined)
        yield* off
      }
    }),
  )

  it.live("compares indexed and global fanout over alternating paired rounds", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const iterations = 600
      const samples = { global: [] as number[], indexed: [] as number[] }
      const measure = (mode: "global" | "indexed") => Effect.gen(function* () {
        let observed = 0
        const listeners = yield* Effect.all(
          Array.from({ length: 100 }, (_, index) =>
            mode === "global"
              ? events.listenType(Delta, () => Effect.sync(() => { observed++ }))
              : events.listenSessionType(Delta, `ses_${index}`, () => Effect.sync(() => { observed++ })),
          ),
        )
        const started = performance.now()
        for (let index = 0; index < iterations; index++) {
          yield* events.publish(Delta, { sessionID: `ses_${index % 25}`, index })
        }
        const elapsed = performance.now() - started
        for (const off of listeners) yield* off
        expect(observed).toBe(mode === "global" ? 100 * iterations : iterations)
        return elapsed
      })
      for (let round = 0; round < 6; round++) {
        const order = round % 2 === 0 ? (["global", "indexed"] as const) : (["indexed", "global"] as const)
        for (const mode of order) samples[mode].push(yield* measure(mode))
      }
      const median = (data: number[]) => {
        const sorted = data.toSorted((a, b) => a - b)
        return (sorted[2]! + sorted[3]!) / 2
      }
      const summary = {
        globalMedianMs: median(samples.global),
        indexedMedianMs: median(samples.indexed),
        speedup: median(samples.global) / median(samples.indexed),
        samples,
      }
      console.log("[session-fanout-paired]", JSON.stringify(summary))
      expect(summary.globalMedianMs).toBeGreaterThan(0)
      expect(summary.indexedMedianMs).toBeGreaterThan(0)
    }),
  )

  it.live("proves a nonmatching session listener can hold another session's event publication", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Ref.make(false)
      const off = yield* events.listenType(Delta, (event) =>
        // The listener belongs to session B, yet subscription is by type, so
        // it is invoked by unrelated session A's delta.
        event.data.sessionID === "ses_a"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      )
      const publisher = yield* Effect.forkChild(
        events.publish(Delta, { sessionID: "ses_a", index: 0 }).pipe(
          Effect.tap(() => Ref.set(completed, true)),
        ),
      )
      try {
        yield* Deferred.await(entered)
        expect(yield* Ref.get(completed)).toBe(false)
      } finally {
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(publisher)
        yield* off
      }
    }),
  )
})