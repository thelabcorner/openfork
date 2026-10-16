/**
 * Isolated session-scoped HTTP routing read comparison.
 * Uses an ephemeral SQLite database; no app, sidecar, or live Session is loaded.
 *
 * bun script/benchmark-session-route-projection.ts 4
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"

const sizeMiB = Math.max(1, Math.min(16, Number(process.argv[2] ?? 4) || 4))
const folder = mkdtempSync(join(tmpdir(), "openfork-session-route-"))
const filename = join(folder, "routing.db")
const id = "ses_benchmark_location"
const samples = 21
const median = (numbers: number[]) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]!

try {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
      VALUES ('p_route_bench', '/route-bench', 'route-bench', '[]', 1000, 1000)
    `)
    const largeMetadata = { userInformation: "X".repeat(sizeMiB * 1024 * 1024) }
    yield* db.run(sql`
      INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated, metadata)
      VALUES (${id}, 'p_route_bench', '/route-bench', 'route-bench', 'Route benchmark', '1', 1000, 1000,
        ${JSON.stringify(largeMetadata)})
    `)

    const oldRead = () => readDb.select().from(SessionTable)
      .where(eq(SessionTable.id, id as any)).get().pipe(Effect.orDie)
    const narrowRead = () => readDb.select({
      directory: SessionTable.directory,
      workspaceID: SessionTable.workspace_id,
    }).from(SessionTable).where(eq(SessionTable.id, id as any)).get().pipe(Effect.orDie)

    const old = yield* oldRead()
    const narrow = yield* narrowRead()
    if (!old || !narrow || old.directory !== narrow.directory || old.workspace_id !== narrow.workspaceID)
      throw new Error("The minimal routing identity diverged")

    const fullSamples: number[] = []
    const projectionSamples: number[] = []
    for (let i = 0; i < samples; i++) {
      for (const mode of i % 2 ? ["projection", "full"] as const : ["full", "projection"] as const) {
        const start = performance.now()
        if (mode === "full") yield* oldRead()
        else yield* narrowRead()
        ;(mode === "full" ? fullSamples : projectionSamples).push(performance.now() - start)
      }
    }
    const before = median(fullSamples)
    const after = median(projectionSamples)
    return {
      largeMetadataMiB: sizeMiB,
      samples,
      fullSessionMedianMs: Number(before.toFixed(4)),
      routingProjectionMedianMs: Number(after.toFixed(4)),
      isolatedSpeedup: Number((before / after).toFixed(2)),
      fullSampleRangeMs: [Math.min(...fullSamples), Math.max(...fullSamples)],
      projectedSampleRangeMs: [Math.min(...projectionSamples), Math.max(...projectionSamples)],
    }
  }).pipe(Effect.provide(Database.layerFromPath(filename))))
  console.log(JSON.stringify(result, null, 2))
} finally {
  rmSync(folder, { recursive: true, force: true })
}
