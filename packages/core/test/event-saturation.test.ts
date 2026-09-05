import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Ref, Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

// Saturation harness for the concurrent-sessions event storm.
//
// Failure mode it guards: 4-6 streaming sessions × token deltas × SSE
// listeners saturates the single Node event loop, starving the 10s SSE
// heartbeat past the frontend liveness window (red status blip). The three
// mechanisms are measured directly:
//   1. publish latency distribution under burst (notify fan-out cost),
//   2. event-loop drift via a raw 10ms interval during the burst (any sync
//      CPU anywhere in the publish path shows up here),
//   3. in-order delivery across listeners (the sequential-notify contract).
// Thresholds are deliberately generous (slow-CI-proof); they catch order-of-
// magnitude regressions, not absolute budgets.

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make("project"), workspaceID: WorkspaceV2.ID.make("wrk_test") }),
  ),
)

const Delta = EventV2.define({
  type: "test.saturation.delta",
  schema: {
    sessionID: Schema.String,
    partID: Schema.String,
    field: Schema.String,
    delta: Schema.String,
    seq: Schema.Number,
  },
})

const DurableMarker = EventV2.define({
  type: "test.saturation.marker",
  durable: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Location.node]), [[Location.node, locationLayer]]),
)

function quantiles(samples: number[], qs: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return qs.map((q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0)
}

describe("event saturation", () => {
  it.live(
    "absorbs a multi-session delta burst without loop starvation",
    () =>
      Effect.gen(function* () {
      const events = yield* EventV2.Service

      // Twelve subscribers mimic the live fan-out (SSE connections, the
      // event bridge, tool reload, projectors): plain filter+record
      // listeners, one that also serializes every event (the downstream
      // JSON.stringify cost, on the same thread), and one listener that
      // yields mid-delivery. The in-order assertion below locks the
      // sequential-delivery invariant that SSE barrier semantics rely on
      // (a full part update must never overtake its deltas).
      const received: number[][] = Array.from({ length: 12 }, () => [])
      const unsubs = yield* Effect.all(
        received.map((log, index) =>
          events.listen((event) =>
            Effect.gen(function* () {
              if (event.type !== Delta.type) return
              if (index === 11) yield* Effect.yieldNow
              if (index === 10) JSON.stringify({ id: event.id, type: event.type, data: event.data })
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only narrowing of the known Delta payload shape
              log.push((event.data as { seq: number }).seq)
            }),
          ),
        ),
      )

      // Raw interval drift detector: any synchronous block of the event loop
      // (sync sqlite, stringify-in-publish, fiber churn) delays these ticks.
      const gaps: number[] = []
      let last = Date.now()
      const timer = setInterval(() => {
        const now = Date.now()
        gaps.push(now - last)
        last = now
      }, 10)

      // Background DB contention: four fibers publishing durable markers
      // continuously, the way concurrent sessions' status flips and part
      // commits contend on the shared sqlite connection.
      const stop = yield* Ref.make(false)
      const contenders = yield* Effect.forkScoped(
        Effect.all(
          [0, 1, 2, 3].map((lane) =>
            Effect.gen(function* () {
              let n = 0
              while (!(yield* Ref.get(stop))) {
                yield* events.publish(DurableMarker, { id: `lane-${lane}-${n++}`, text: "ping" }).pipe(Effect.orDie)
                yield* Effect.yieldNow
              }
            }),
          ),
          { concurrency: "unbounded", discard: true },
        ),
      )

      const latencies: number[] = []
      const sessions = ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e", "ses_f"]
      // Realistic coalesced-delta size: the processor flushes up to ~2KB per
      // publish, so stringify/copy/encode costs must be measured at that
      // scale, not with toy 16-byte payloads.
      const payload = "0123456789abcdef".repeat(128)
      const total = 6000
      try {
        for (let i = 0; i < total; i++) {
          const sessionID = sessions[i % sessions.length]
          const start = Date.now()
          yield* events.publish(Delta, {
            sessionID,
            partID: `part-${sessionID}`,
            field: "text",
            delta: payload,
            seq: i,
          })
          latencies.push(Date.now() - start)
        }
      } finally {
        clearInterval(timer)
        yield* Effect.all(unsubs.map((off) => off), { discard: true })
        yield* Ref.set(stop, true)
        yield* Fiber.join(contenders)
      }

      // 1. Every listener received every delta, in publish order — including
      // the poison listener, which interleaves under unordered fan-out.
      for (const log of received) {
        expect(log.length).toBe(total)
        for (let i = 1; i < log.length; i++) {
          if (log[i] <= log[i - 1]) {
            expect(`out-of-order delivery at index ${i}`).toBe("in order")
            break
          }
        }
      }

      // 2. Publish latency stays interactive under burst.
      const [p50, p99, max] = quantiles(latencies, [0.5, 0.99, 1])
      // eslint-disable-next-line no-console
      console.log(`[saturation] publish ms p50=${p50} p99=${p99} max=${max} loopMaxGapMs=${Math.max(...gaps)}`)
      expect({ p50, p99, max }).toMatchObject({})
      expect(p99).toBeLessThan(250)
      expect(max).toBeLessThan(2000)

      // 3. The event loop itself was never starved: 10ms ticks must keep
      // flowing even mid-burst (heartbeat/IO liveness depends on this).
      const maxGap = Math.max(...gaps)
      expect(maxGap).toBeLessThan(1000)
      }),
    // Durable-write contention is intentionally part of this stress harness;
    // on a cold Windows SQLite connection it can exceed Bun's five-second
    // default even though the measured event-loop budget remains healthy.
    { timeout: 30_000 },
  )
})
