import { expect, test } from "bun:test"
import { Database as NativeDatabase } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isSqliteBusy } from "../../src/database/sqlite-busy"

function withPair(body: (a: NativeDatabase, b: NativeDatabase) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sqlite-snapshot-"))
  const filename = path.join(directory, "snapshot.sqlite")
  const a = new NativeDatabase(filename, { create: true })
  const b = new NativeDatabase(filename)
  try {
    for (const db of [a, b]) {
      db.exec("PRAGMA journal_mode=WAL")
      db.exec("PRAGMA busy_timeout=5000")
    }
    a.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    body(a, b)
  } finally {
    try {
      a.exec("ROLLBACK")
    } catch {}
    try {
      b.exec("ROLLBACK")
    } catch {}
    a.close()
    b.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test("DEFERRED read-to-write upgrade fails immediately with SQLITE_BUSY_SNAPSHOT after a peer commit", () => {
  withPair((a, b) => {
    a.exec("BEGIN")
    expect(a.query("SELECT count(*) AS count FROM probe").get()).toEqual({ count: 0 })

    b.exec("INSERT INTO probe(value) VALUES ('peer')")

    const started = performance.now()
    let failure: unknown
    try {
      a.exec("INSERT INTO probe(value) VALUES ('stale')")
    } catch (error) {
      failure = error
    }
    const elapsed = performance.now() - started

    expect(failure).toBeDefined()
    expect((failure as { code?: string }).code).toBe("SQLITE_BUSY_SNAPSHOT")
    expect((failure as { errno?: number }).errno).toBe(517)
    expect(isSqliteBusy(failure)).toBe(true)
    // busy_timeout=5000 cannot repair an obsolete WAL snapshot. SQLite rejects
    // the upgrade immediately rather than waiting for the writer lock.
    expect(elapsed).toBeLessThan(1000)
  })
})

test("BEGIN IMMEDIATE reserves the writer before the read snapshot", () => {
  withPair((a, b) => {
    b.exec("PRAGMA busy_timeout=25")
    a.exec("BEGIN IMMEDIATE")
    expect(a.query("SELECT count(*) AS count FROM probe").get()).toEqual({ count: 0 })

    let peerFailure: unknown
    try {
      b.exec("INSERT INTO probe(value) VALUES ('peer')")
    } catch (error) {
      peerFailure = error
    }
    expect(peerFailure).toBeDefined()
    expect(isSqliteBusy(peerFailure)).toBe(true)

    // The owner that reserved the writer before reading can always perform its
    // own write against the snapshot it established.
    a.exec("INSERT INTO probe(value) VALUES ('owner')")
    a.exec("COMMIT")

    b.exec("INSERT INTO probe(value) VALUES ('peer-after')")
    expect(b.query("SELECT count(*) AS count FROM probe").get()).toEqual({ count: 2 })
  })
})
