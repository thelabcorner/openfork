/**
 * Benchmark worker-batch session/type subscription setup, not event dispatch.
 * Reproduce: bun packages/core/script/session-event-listener-bench.ts
 *
 * All event listeners are local and disposable; EventV2's backing DB is
 * explicitly in-memory. Never opens production application state.
 */
import { Effect, Layer, Schema } from "effect"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"

const definitions = Array.from({ length: 5 }, (_, index) =>
  EventV2.define({
    type: `bench.session.control-${index}`,
    schema: { sessionID: Schema.String, text: Schema.String },
  }))
const widths = [1, 5, 10, 25, 50, 100, 200]
const rounds = 12
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2
}

const layer = Layer.provide(EventV2.layerWith(), Database.layerFromPath(":memory:"))
const report = await Effect.runPromise(Effect.gen(function* () {
  const events = yield* EventV2.Service
  const rows = []
  for (const width of widths) {
    const ids = Array.from({ length: width }, (_, index) => `ses_listener_bench_${index}`)
    const legacy: number[] = []
    const batched: number[] = []
    for (let round = 0; round < rounds; round++) {
      for (const mode of round % 2 === 0 ? ["legacy", "batched"] as const : ["batched", "legacy"] as const) {
        const started = performance.now()
        const unsubscribe = mode === "legacy"
          ? yield* Effect.all(ids.flatMap((id) =>
            definitions.map((definition) => events.listenSessionType(definition, id, () => Effect.void))))
          : [yield* events.listenSessionTypes(definitions, ids, () => Effect.void)]
        const elapsed = performance.now() - started
        if (mode === "legacy") legacy.push(elapsed)
        else batched.push(elapsed)
        yield* Effect.forEach(unsubscribe, (detach) => detach, { discard: true })
      }
    }
    const a = median(legacy), b = median(batched)
    rows.push({
      sessions: width,
      listenerKeys: width * definitions.length,
      legacyMedianMs: +a.toFixed(3),
      batchedMedianMs: +b.toFixed(3),
      ratio: +(a / b).toFixed(2),
    })
  }
  return rows
}).pipe(Effect.provide(layer)))
console.log(JSON.stringify({ benchmark: "session-type-listener-batch", rounds, report }, null, 2))