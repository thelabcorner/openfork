/**
 * Benchmarks the complete V1 Session row decoder versus the actual
 * authoritative two-column delegation projection on a disposable WAL DB.
 * Never initializes the user's configured OpenFork database.
 * Reproduce: cd packages/opencode && bun script/worker-origin-projection-bench.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { inArray } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { fromRow } from "../src/session/session"

const directory = mkdtempSync(join(tmpdir(), "openfork-worker-origin-bench-"))
const filename = join(directory, "origin-bench.db")
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2
}
const report = await (async () => {
  try {
    return await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const database = yield* Database.Service
      if (resolve(database.filename) !== resolve(filename) || database.readDb === database.db) {
        return yield* Effect.die(new Error("Worker origin benchmark is not isolated; refusing fixture writes"))
      }
      const { db, readDb } = database
      yield* db.insert(ProjectTable).values({
        id: Project.ID.global, worktree: AbsolutePath.make("/origin-bench"), sandboxes: [],
      }).onConflictDoNothing().run().pipe(Effect.orDie)
      const ids = Array.from({ length: 200 }, (_, index) => SessionSchema.ID.make(`ses_origin_bench_${index}`))
      const diff = [{ file: "benchmark", before: "x".repeat(24_000), after: "y".repeat(24_000) }] as any
      const origin = {
        producer: "oxp",
        principalRef: "oxp:benchmark",
        invocationRef: "oxp-inv:benchmark",
        rootRef: "root-benchmark",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        nestedDelegation: false,
      }
      yield* db.insert(SessionTable).values(ids.map((id, index) => ({
        id, project_id: Project.ID.global, slug: `origin-bench-${index}`,
        directory: "/origin-bench", title: `Origin Benchmark ${index}`, version: "bench",
        summary_diffs: diff,
        metadata: { workerDelegation: origin },
      }))).run().pipe(Effect.orDie)
      const result: Array<{ sessions: number; fullMedianMs: number; projectedMedianMs: number; ratio: number }> = []
      for (const count of [1, 10, 25, 50, 100, 200]) {
        const keys = ids.slice(0, count)
        const full: number[] = [], projected: number[] = []
        for (let round = 0; round < 8; round++) {
          for (const mode of round % 2 === 0 ? ["full", "projection"] as const : ["projection", "full"] as const) {
            const start = performance.now()
            if (mode === "full") {
              const rows = yield* readDb.select().from(SessionTable).where(inArray(SessionTable.id, keys))
                .all().pipe(Effect.orDie)
              const origins = rows.map((row) => SessionMetadataOwnership.workerDelegation(fromRow(row).metadata))
              if (origins.length !== count || origins.some((item) => item?.principalRef !== origin.principalRef)) {
                throw Error("Full row decoding broke origin parity")
              }
              full.push(performance.now() - start)
            } else {
              const rows = yield* readDb.select({ id: SessionTable.id, metadata: SessionTable.metadata })
                .from(SessionTable).where(inArray(SessionTable.id, keys)).all().pipe(Effect.orDie)
              const origins = rows.map((row) => SessionMetadataOwnership.workerDelegation(row.metadata ?? undefined))
              if (origins.length !== count || origins.some((item) => item?.principalRef !== origin.principalRef)) {
                throw Error("Projection decoding broke origin parity")
              }
              projected.push(performance.now() - start)
            }
          }
        }
        const before = median(full), after = median(projected)
        result.push({
          sessions: count, fullMedianMs: +before.toFixed(3),
          projectedMedianMs: +after.toFixed(3), ratio: +(before / after).toFixed(2),
        })
      }
      return result
    }).pipe(Effect.provide(Database.layerFromPath(filename)))))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})()
console.log(JSON.stringify({ benchmark: "worker-origin-narrow-vs-full", rounds: 8, report }, null, 2))