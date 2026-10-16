/**
 * Inspect only an isolated disposable file-backed SQLite/Effect graph.
 * Reproduce: bun packages/core/script/session-owner-batch-bench.ts
 * No live sessions, provider calls, production DB or app restart.
 */
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { RuntimeOwner } from "../src/runtime-owner"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { SessionExecutionOwner } from "../src/session/execution-owner"
import { SessionExecutionOwnerTable } from "../src/session/execution-owner.sql"
import { AbsolutePath } from "../src/schema"

const rows = [1, 10, 25, 50, 100, 200, 400]
const rounds = 8
const median = (values: number[]) => {
  const ordered = values.toSorted((a, b) => a - b)
  return (ordered[(ordered.length - 1) >> 1]! + ordered[ordered.length >> 1]!) / 2
}
const directory = mkdtempSync(join(tmpdir(), "openfork-owner-bench-"))
const filename = join(directory, "owner-bench.db")
const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, RuntimeOwner.node, SessionExecutionOwner.node]),
  [[Database.node, Database.layerFromPath(filename)]],
)
let results: Array<{ sessions: number; separateMedianMs: number; batchedMedianMs: number; ratio: number }>
try {
results = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const database = yield* Database.Service
  // Fail before writing even one fixture row if dependency injection ever
  // regresses to the user's default OpenFork database.
  if (resolve(database.filename) !== resolve(filename)) {
    return yield* Effect.die(new Error("Benchmark database isolation failed; refusing to write fixture rows"))
  }
  const { db } = database
  const runtime = yield* RuntimeOwner.Service
  const owner = yield* SessionExecutionOwner.Service
  const retained = yield* runtime.retain
  yield* db.insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/owner-bench"), sandboxes: [] })
    .onConflictDoNothing().run().pipe(Effect.orDie)
  const ids = Array.from({ length: 400 }, (_, index) => SessionSchema.ID.make(`ses_owner_bench_${index}`))
  yield* db.insert(SessionTable).values(ids.map((id, index) => ({
    id, project_id: Project.ID.global, slug: `owner-bench-${index}`,
    directory: "/owner-bench", title: `Benchmark ${index}`, version: "test",
  }))).run().pipe(Effect.orDie)
  yield* db.insert(SessionExecutionOwnerTable).values(ids.map((id) => ({
    session_id: id, generation: 3, owner_id: runtime.id, acquired_at: Date.now(),
  }))).run().pipe(Effect.orDie)
  const report: Array<{ sessions: number; separateMedianMs: number; batchedMedianMs: number; ratio: number }> = []
  for (const n of rows) {
    const targets = ids.slice(0, n)
    const separate: number[] = []
    const batched: number[] = []
    for (let i = 0; i < rounds; i++) {
      for (const mode of i % 2 === 0 ? ["separate", "batched"] as const : ["batched", "separate"] as const) {
        const started = performance.now()
        if (mode === "separate") {
          const states = yield* Effect.forEach(targets, owner.snapshot, { concurrency: 4 })
          if (states.length !== n || states.some((value) => value.runtime?.id !== runtime.id)) {
            throw new Error("per-Session ownership parity failure")
          }
          separate.push(performance.now() - started)
        } else {
          const states = yield* owner.snapshotMany(targets)
          if (states.size !== n || [...states.values()].some((value) => value.runtime?.id !== runtime.id)) {
            throw new Error("batch ownership parity failure")
          }
          batched.push(performance.now() - started)
        }
      }
    }
    const a = median(separate), b = median(batched)
    report.push({ sessions: n, separateMedianMs: +a.toFixed(3), batchedMedianMs: +b.toFixed(3), ratio: +(a/b).toFixed(2) })
  }
  yield* retained.release
  return report
}).pipe(Effect.provide(layer))))
} finally {
  rmSync(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ benchmark: "session-owner-wal-snapshot", rounds, report: results }, null, 2))