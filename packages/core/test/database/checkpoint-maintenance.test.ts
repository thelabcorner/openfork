import { expect, test } from "bun:test"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { checkpointWal } from "../../src/database/database"

test("checkpoint maintenance finishes while a foreground writer remains held", async () => {
  const directory = await mkdtemp(join(import.meta.dir, ".checkpoint-test-"))
  const filename = join(directory, "probe.sqlite")
  const primary = new NativeDatabase(filename, { create: true })
  try {
    primary.exec("PRAGMA journal_mode=WAL; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('committed')")
    primary.exec("BEGIN IMMEDIATE; INSERT INTO probe VALUES ('still-active')")
    // The checkpoint must complete without asking this writer to release its
    // reservation. A zero-timeout PASSIVE maintenance handle may leave frames
    // for a later pass; it must not wait behind session persistence.
    await Effect.runPromise(checkpointWal(filename).pipe(Effect.timeout("2 seconds")))
    expect(primary.query("SELECT value FROM probe ORDER BY rowid").all()).toEqual([
      { value: "committed" }, { value: "still-active" },
    ])
    primary.exec("ROLLBACK")
    expect(primary.query("SELECT count(*) AS count FROM probe").get()).toEqual({ count: 1 })
  } finally {
    primary.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("in-memory storage skips file checkpoint maintenance", async () => {
  await Effect.runPromise(checkpointWal(":memory:"))
})
