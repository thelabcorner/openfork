import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database, optimizePlannerStats } from "../../src/database/database"

test("background planner maintenance creates index statistics without commandeering the primary SQL lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-planner-statistics-"))
  const filename = join(directory, "planner.sqlite")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, readDb } = yield* Database.Service
      yield* db.run(sql`CREATE TABLE planner_probe (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL)`)
      yield* db.run(sql`CREATE INDEX planner_probe_group_idx ON planner_probe(group_id)`)
      yield* db.run(sql`
        WITH RECURSIVE numbers(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000
        )
        INSERT INTO planner_probe (id, group_id) SELECT n, n % 12 FROM numbers
      `)
      const before = yield* readDb.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'sqlite_stat1'`)
      expect(before?.count).toBe(0)
      // This uses a separate, short-busy-timeout native worker even on Bun.
      yield* optimizePlannerStats(filename)
      const after = yield* readDb.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'sqlite_stat1'`)
      expect(after?.count).toBe(1)
      const stats = yield* readDb.get<{ stat: string }>(sql`
        SELECT stat FROM sqlite_stat1 WHERE tbl='planner_probe' AND idx='planner_probe_group_idx'
      `)
      expect(stats?.stat).toMatch(/^1000 /)
      expect(yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM planner_probe`))
        .toEqual({ count: 1000 })
      // A repeat run is safe and does not schedule another primary lane scan.
      yield* optimizePlannerStats(filename)
    }).pipe(Effect.provide(Database.layerFromPath(filename)))))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}, 30_000)

test("in-memory planner maintenance is a no-op", async () => {
  await Effect.runPromise(optimizePlannerStats(":memory:"))
})
