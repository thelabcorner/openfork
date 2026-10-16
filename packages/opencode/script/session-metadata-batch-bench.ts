/**
 * V1 Session.get versus Session.getMany SQL/decoding admission cost.
 * bun packages/opencode/script/session-metadata-batch-bench.ts
 *
 * Explicitly isolated disposable SQLite file, never the default OpenFork DB.
 * No provider, live session, Electron renderer, process kill or network.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { eq, inArray } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "../src/session/schema"
import { fromRow } from "../src/session/session"

const directory = mkdtempSync(join(tmpdir(), "openfork-v1-batch-bench-"))
const filename = join(directory, "session-bench.db")
const widths = [1, 5, 10, 25, 50, 100, 200, 400, 420]
const median = (data: number[]) => {
  const sorted = data.toSorted((a, b) => a - b)
  return (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2
}

try {
  const report = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { db, readDb, filename: actual } = yield* Database.Service
    if (resolve(actual) !== resolve(filename)) {
      return yield* Effect.die(new Error("Benchmark DB isolation failed; no fixture writes allowed"))
    }
    yield* db.insert(ProjectTable).values({
      id: Project.ID.global, worktree: AbsolutePath.make("/batch-read-bench"), sandboxes: [],
    }).onConflictDoNothing().run().pipe(Effect.orDie)
    const ids = Array.from({ length: 420 }, (_, index) => SessionID.make(`ses_v1_batch_${index}`))
    yield* db.insert(SessionTable).values(ids.map((id, index) => ({
      id, project_id: Project.ID.global, slug: `bench-${index}`,
      title: `bench-${index}`, directory: "/batch-read-bench", version: "test",
      metadata: { label: "fixture", epoch: index },
    }))).run().pipe(Effect.orDie)

    const results: Array<{ sessions: number; perSessionMs: number; batchedMs: number; metadataOnlyMs: number; ratio: number; metadataRatio: number }> = []
    for (const count of widths) {
      const addressed = ids.slice(0, count)
      const singles: number[] = []
      const batches: number[] = []
      const minimal: number[] = []
      for (let round = 0; round < 8; round++) {
        for (const mode of round % 2 === 0
          ? ["single", "batch", "metadata"] as const
          : ["metadata", "batch", "single"] as const) {
          const start = performance.now()
          if (mode === "single") {
            const rows = yield* Effect.forEach(addressed,
              (id) => readDb.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie),
              { concurrency: 4 },
            )
            const decoded = rows.map((row) => row && fromRow(row))
            if (decoded.some((item) => !item) || decoded.length !== count) throw new Error("Per-Session read lost data")
            singles.push(performance.now() - start)
          } else if (mode === "batch") {
            const rows: (typeof SessionTable.$inferSelect)[] = []
            for (let offset = 0; offset < addressed.length; offset += 400) {
              rows.push(...(yield* readDb.select().from(SessionTable)
                .where(inArray(SessionTable.id, addressed.slice(offset, offset + 400)))
                .all().pipe(Effect.orDie)))
            }
            const mapped = new Map(rows.map((row) => [row.id, fromRow(row)]))
            if (mapped.size !== count || addressed.some((id) => mapped.get(id)?.metadata?.epoch === undefined)) {
              throw new Error("Batched V1 projection omitted or corrupted worker metadata")
            }
            batches.push(performance.now() - start)
          } else {
            const found = new Map<string, Record<string, unknown> | null>()
            for (let offset = 0; offset < addressed.length; offset += 400) {
              const page = yield* readDb.select({
                id: SessionTable.id, metadata: SessionTable.metadata,
              }).from(SessionTable).where(inArray(SessionTable.id,
                addressed.slice(offset, offset + 400))).all().pipe(Effect.orDie)
              for (const row of page) found.set(row.id, row.metadata)
            }
            if (found.size !== count || addressed.some((id) => found.get(id)?.epoch === undefined)) {
              throw new Error("Metadata-only batch omitted or corrupted addressed Session origin")
            }
            minimal.push(performance.now() - start)
          }
        }
      }
      const a = median(singles), b = median(batches), c = median(minimal)
      results.push({ sessions: count, perSessionMs: +a.toFixed(3), batchedMs: +b.toFixed(3), metadataOnlyMs: +c.toFixed(3), ratio: +(a/b).toFixed(2), metadataRatio: +(b/c).toFixed(2) })
    }
    return results
  }).pipe(Effect.provide(Database.layerFromPath(filename)))))
  console.log(JSON.stringify({ benchmark: "v1-session-read-batch", rounds: 8, report }, null, 2))
} finally {
  rmSync(directory, { recursive: true, force: true })
}