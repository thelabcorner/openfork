import { expect, test } from "bun:test"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  checkpointWal,
  checkpointIntervalMs,
  unchangedCleanWal,
  checkpointIsStalled,
  WAL_PRESSURE_BYTES,
  WAL_NORMAL_CHECKPOINT_INTERVAL_MS,
  WAL_PRESSURE_CHECKPOINT_INTERVAL_MS,
} from "../../src/database/database"

test("adaptive WAL checkpoint pressure favors reader and foreground stability", () => {
  expect(checkpointIntervalMs(0, false)).toBe(WAL_NORMAL_CHECKPOINT_INTERVAL_MS)
  expect(checkpointIntervalMs(WAL_PRESSURE_BYTES - 1, false)).toBe(WAL_NORMAL_CHECKPOINT_INTERVAL_MS)
  expect(checkpointIntervalMs(WAL_PRESSURE_BYTES, false)).toBe(WAL_PRESSURE_CHECKPOINT_INTERVAL_MS)
  expect(checkpointIntervalMs(WAL_PRESSURE_BYTES * 32, false)).toBe(WAL_PRESSURE_CHECKPOINT_INTERVAL_MS)
  // A pinned WAL reader prevents progress; expensive futile passes must back off.
  expect(checkpointIntervalMs(WAL_PRESSURE_BYTES * 32, true)).toBe(WAL_NORMAL_CHECKPOINT_INTERVAL_MS)
  expect(checkpointIntervalMs(WAL_PRESSURE_BYTES * 32, false, true)).toBe(WAL_NORMAL_CHECKPOINT_INTERVAL_MS)
  expect(checkpointIntervalMs(WAL_PRESSURE_BYTES * 32, false, false)).toBe(WAL_PRESSURE_CHECKPOINT_INTERVAL_MS)
  expect(unchangedCleanWal({ size: WAL_PRESSURE_BYTES, modifiedAt: 10 }, { size: WAL_PRESSURE_BYTES, modifiedAt: 10 })).toBe(true)
  expect(unchangedCleanWal({ size: WAL_PRESSURE_BYTES, modifiedAt: 11 }, { size: WAL_PRESSURE_BYTES, modifiedAt: 10 })).toBe(false)
  expect(unchangedCleanWal(undefined, { size: WAL_PRESSURE_BYTES, modifiedAt: 10 })).toBe(false)
})

test("WAL progress never confuses log recycling with reader checkpoint starvation", () => {
  const previous = { busy: 0, log: 20_000, checkpointed: 12_000, pendingPages: 8_000 }
  expect(checkpointIsStalled(previous, { busy: 0, log: 21_000, checkpointed: 12_000, pendingPages: 9_000 })).toBe(true)
  expect(checkpointIsStalled(previous, { busy: 0, log: 21_000, checkpointed: 12_050, pendingPages: 8_950 })).toBe(false)
  expect(checkpointIsStalled(previous, { busy: 0, log: 100, checkpointed: 20, pendingPages: 80 })).toBe(false)
  expect(checkpointIsStalled(previous, { busy: 0, log: 20_000, checkpointed: 20_000, pendingPages: 0 })).toBe(false)
  expect(checkpointIsStalled(undefined, previous)).toBe(false)
})

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
    const status = await Effect.runPromise(checkpointWal(filename).pipe(Effect.timeout("2 seconds")))
    expect(status).toBeDefined()
    expect(status?.pendingPages).toBeGreaterThanOrEqual(0)
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

test("PASSIVE worker checkpoint respects pinned WAL reader while foreground writer continues", async () => {
  const directory = await mkdtemp(join(import.meta.dir, ".checkpoint-reader-test-"))
  const filename = join(directory, "pinned.sqlite")
  const writer = new NativeDatabase(filename)
  let reader: NativeDatabase | undefined
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
    writer.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY, body BLOB)")
    writer.query("INSERT INTO probe(body) VALUES (?)").run(Buffer.alloc(8192, 7))
    reader = new NativeDatabase(filename, { readonly: true, create: false })
    reader.exec("BEGIN")
    expect(reader.query("SELECT count(*) AS count FROM probe").get()).toEqual({ count: 1 })
    writer.exec("BEGIN IMMEDIATE")
    const insert = writer.query("INSERT INTO probe(body) VALUES (?)")
    for (let i = 0; i < 128; i++) insert.run(Buffer.alloc(8192, i))
    writer.exec("COMMIT")

    const started = performance.now()
    const result = await Effect.runPromise(checkpointWal(filename).pipe(Effect.timeout("3 seconds")))
    expect(result).toBeDefined()
    expect(result!.pendingPages).toBeGreaterThan(0)
    expect(performance.now() - started).toBeLessThan(3_000)
    writer.query("INSERT INTO probe(body) VALUES (?)").run(Buffer.alloc(16, 9))
    expect(reader.query("SELECT count(*) AS count FROM probe").get()).toEqual({ count: 1 })
    reader.exec("ROLLBACK")
    const settled = await Effect.runPromise(checkpointWal(filename).pipe(Effect.timeout("3 seconds")))
    expect(settled?.pendingPages).toBe(0)
    expect(writer.query("SELECT count(*) AS count FROM probe").get()).toEqual({ count: 130 })
  } finally {
    try { reader?.exec("ROLLBACK") } catch {}
    reader?.close()
    writer.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 12_000)

test("in-memory storage skips file checkpoint maintenance", async () => {
  await Effect.runPromise(checkpointWal(":memory:"))
})
