import { expect, test } from "bun:test"
import { Database as NativeSQLite } from "bun:sqlite"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "../../src/database/database"
import { retrySqliteBusyCause } from "../../src/database/sqlite-busy"

test("Core Database service boots WAL/migrations and survives lock contention with worker-backed Bun SQLite", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-worker-database-service-"))
  const filename = join(folder, "integration.db")
  const previous = process.env.OPENFORK_SQLITE_ASYNC_WORKER
  process.env.OPENFORK_SQLITE_ASYNC_WORKER = "1"
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, readDb } = yield* Database.Service
      const journal = yield* db.get<{ journal_mode: string }>("PRAGMA journal_mode")
      expect(journal?.journal_mode.toLowerCase()).toBe("wal")
      yield* db.run("CREATE TABLE IF NOT EXISTS bun_worker_integration(id INTEGER PRIMARY KEY)")
      yield* db.run("INSERT INTO bun_worker_integration VALUES(1)")
      const rows = yield* readDb.all<{ id: number }>("SELECT id FROM bun_worker_integration")
      expect(rows).toEqual([{ id: 1 }])
      const peer = new NativeSQLite(filename)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        peer.exec("PRAGMA busy_timeout=0")
        peer.exec("BEGIN IMMEDIATE")
        timer = setTimeout(() => peer.exec("COMMIT"), 300)
        const started = performance.now()
        // Native busy timeout remains short, so a low-priority caller has to
        // retry the statement after the peer yields its WAL writer lock.
        yield* retrySqliteBusyCause(
          () => db.run("INSERT INTO bun_worker_integration VALUES(2)"),
          { maxElapsedMs: 2000, delayMs: 25, maxDelayMs: 75 },
        )
        expect(performance.now() - started).toBeLessThan(2000)
      } finally {
        if (timer) clearTimeout(timer)
        try { peer.exec("ROLLBACK") } catch {}
        peer.close()
      }
      expect(yield* readDb.all<{ id: number }>("SELECT id FROM bun_worker_integration ORDER BY id"))
        .toEqual([{ id: 1 }, { id: 2 }])
    }).pipe(Effect.provide(Database.layerFromPath(filename)))))
  } finally {
    if (previous === undefined) delete process.env.OPENFORK_SQLITE_ASYNC_WORKER
    else process.env.OPENFORK_SQLITE_ASYNC_WORKER = previous
    await rm(folder, { recursive: true, force: true })
  }
}, 40_000)