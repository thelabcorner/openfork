/**
 * Reproduce the worker waitMany overhead before/after indexed completion.
 *
 * bun packages/core/script/background-wait-concurrency-bench.ts
 *
 * Local, process-scoped Effect fibers only: no provider, network, browser,
 * production database, or live Session. Results are NOT end-to-end latency.
 * The legacy arm is the original waitMany raceFirst tree using BackgroundJob.wait.
 */
import { BackgroundJob } from "../src/background-job"
import { LayerNode } from "../src/effect/layer-node"
import { Deferred, Effect, Fiber } from "effect"

const widths = [1, 5, 10, 25, 50, 100]
const rounds = 8
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2
}

const report = await Effect.runPromise(Effect.gen(function* () {
  const registry = yield* BackgroundJob.Service
  const idle = yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
    registry.start({ id: `bench-idle-${index}`, type: "bench", run: Effect.never }),
  )
  const rows: Array<{
    workers: number
    legacyMedianMs: number
    indexedMedianMs: number
    ratio: number
    separateSnapshotMedianMs: number
    batchedSnapshotMedianMs: number
    snapshotRatio: number
  }> = []

  for (const workers of widths) {
    const legacy: number[] = []
    const indexed: number[] = []
    for (let round = 0; round < rounds; round++) {
      for (const mode of round % 2 === 0 ? ["legacy", "indexed"] as const : ["indexed", "legacy"] as const) {
        const gate = yield* Deferred.make<void>()
        const trigger = yield* registry.start({
          id: `bench-trigger-${workers}-${round}-${mode}`,
          type: "bench",
          run: Deferred.await(gate).pipe(Effect.as("done")),
        })
        const targets = [trigger, ...idle.slice(0, workers - 1)]
        const operation = mode === "indexed"
          ? registry.waitAny({ jobs: targets.map(({ id, generation }) => ({ id, generation })) })
          : targets.reduce<Effect.Effect<unknown>>(
              (wake, { id }) => Effect.raceFirst(wake, registry.wait({ id }).pipe(Effect.asVoid)),
              Effect.never,
            )
        const started = performance.now()
        const waiter = yield* operation.pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(waiter)
        const elapsed = performance.now() - started
        if (mode === "indexed") indexed.push(elapsed)
        else legacy.push(elapsed)
      }
    }
    const legacyMedianMs = median(legacy)
    const indexedMedianMs = median(indexed)
    const separateSnapshots: number[] = []
    const batchedSnapshots: number[] = []
    const ids = idle.slice(0, workers).map((job) => job.id)
    for (let sample = 0; sample < 16; sample++) {
      for (const mode of sample % 2 === 0 ? ["separate", "batched"] as const : ["batched", "separate"] as const) {
        const start = performance.now()
        if (mode === "batched") {
          const values = yield* registry.getMany(ids)
          if (values.size !== ids.length) throw new Error("incomplete batched job snapshot")
          batchedSnapshots.push(performance.now() - start)
        } else {
          const values = yield* Effect.forEach(ids, (id) => registry.get(id), { concurrency: 4 })
          if (values.some((value) => value === undefined)) throw new Error("incomplete per-job snapshot")
          separateSnapshots.push(performance.now() - start)
        }
      }
    }
    const separateSnapshotMedianMs = median(separateSnapshots)
    const batchedSnapshotMedianMs = median(batchedSnapshots)
    rows.push({
      workers,
      legacyMedianMs: Math.round(legacyMedianMs * 1_000) / 1_000,
      indexedMedianMs: Math.round(indexedMedianMs * 1_000) / 1_000,
      ratio: Math.round((legacyMedianMs / indexedMedianMs) * 100) / 100,
      separateSnapshotMedianMs: Math.round(separateSnapshotMedianMs * 1_000) / 1_000,
      batchedSnapshotMedianMs: Math.round(batchedSnapshotMedianMs * 1_000) / 1_000,
      snapshotRatio: Math.round((separateSnapshotMedianMs / batchedSnapshotMedianMs) * 100) / 100,
    })
  }
  yield* Effect.forEach(idle, (job) => registry.cancel(job.id), { discard: true })
  return rows
}).pipe(Effect.provide(LayerNode.compile(BackgroundJob.node))))
console.log(JSON.stringify({ benchmark: "background-wait-indexed-completion", rounds, report }, null, 2))