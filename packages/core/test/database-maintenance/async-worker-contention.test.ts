import { expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"

// Regression: merely opening a second SQLite connection does not isolate
// synchronous sqlite3_step() from the application event loop. This reproduces
// the deadlock: one peer owns the WAL writer reservation, and a timer on the
// event loop must release it while background maintenance attempts a write.
test("background maintenance defaults to an async worker so a peer writer can yield", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-maint-worker-"))
  const file = join(directory, "maintenance.db")
  const holder = new BunDatabase(file)
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let releasedByTimer = false
  let holding = false

  try {
    holder.run("PRAGMA journal_mode=WAL")
    holder.run("CREATE TABLE IF NOT EXISTS maintenance_probe (id INTEGER PRIMARY KEY)")
    holder.run("BEGIN IMMEDIATE")
    holding = true

    await Effect.runPromise(
      Effect.scoped(
        Database.withBackfillDb(
          file,
          (db) =>
            Effect.gen(function* () {
              // The timer is installed ONLY once the maintenance worker has
              // finished its setup, avoiding a false pass from worker startup.
              releaseTimer = setTimeout(() => {
                holder.run("COMMIT")
                holding = false
                releasedByTimer = true
              }, 75)
              yield* db.run("INSERT INTO maintenance_probe(id) VALUES (1)")
            }),
          { busyTimeoutMs: 750 },
        ),
      ),
    )

    expect(releasedByTimer).toBe(true)
    expect(holder.query("SELECT count(*) AS rows FROM maintenance_probe").get()).toEqual({ rows: 1 })
  } finally {
    if (releaseTimer !== undefined) clearTimeout(releaseTimer)
    if (holding) holder.run("ROLLBACK")
    holder.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)
