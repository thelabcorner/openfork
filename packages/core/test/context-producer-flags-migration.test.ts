import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import migration from "../src/database/migration/20261010073540_context-producer-flags"

/**
 * Upgrade a real legacy schema *including* the old JSON-expression indexes.
 * This test intentionally avoids opening the production database.
 */
describe("Context producer scalar migration", () => {
  test("backfills message and part facts and swaps all three legacy probe indexes", async () => {
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,data TEXT NOT NULL)")
      db.exec("CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,session_id TEXT NOT NULL,data TEXT NOT NULL)")
      db.exec("CREATE INDEX message_session_summary_probe_idx ON message(session_id) WHERE json_extract(data,'$.summary')=1")
      db.exec("CREATE INDEX message_session_opaque_probe_idx ON message(session_id) WHERE json_type(data,'$.\"$cdbRef\"') IS NOT NULL")
      db.exec("CREATE INDEX part_session_opaque_context_probe_idx ON part(session_id) WHERE json_type(data,'$.\"$cdbRef\"') IS NOT NULL")
      const message = db.prepare("INSERT INTO message(id,session_id,data) VALUES (?,?,?)")
      message.run("normal", "a", JSON.stringify({ role: "user" }))
      message.run("summary", "a", JSON.stringify({ role: "assistant", summary: true }))
      message.run("opaque", "b", JSON.stringify({ $cdbRef: "stored" }))
      const part = db.prepare("INSERT INTO part(id,message_id,session_id,data) VALUES (?,?,?,?)")
      part.run("text", "normal", "a", JSON.stringify({ type: "text", text: "hello" }))
      part.run("compaction", "normal", "a", JSON.stringify({ type: "compaction" }))
      part.run("opaque", "opaque", "b", JSON.stringify({ $cdbRef: "stored" }))
      const tx = { run: (sql: string) => Effect.sync(() => db.exec(sql)) }
      await Effect.runPromise(migration.up(tx as never))
      expect(db.query("SELECT id,context_summary,context_opaque FROM message ORDER BY id").all()).toEqual([
        { id: "normal", context_summary: 0, context_opaque: 0 },
        { id: "opaque", context_summary: 0, context_opaque: 1 },
        { id: "summary", context_summary: 1, context_opaque: 0 },
      ])
      expect(db.query("SELECT id,context_compaction,context_opaque FROM part ORDER BY id").all()).toEqual([
        { id: "compaction", context_compaction: 1, context_opaque: 0 },
        { id: "opaque", context_compaction: 0, context_opaque: 1 },
        { id: "text", context_compaction: 0, context_opaque: 0 },
      ])
      const indexes = db.query<{name:string;sql:string}, []>("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE '%probe_idx' OR name='part_session_opaque_context_probe_idx'").all()
      expect(indexes).toHaveLength(3)
      for (const index of indexes) {
        expect(index.sql).not.toContain("json_extract")
        expect(index.sql).not.toContain("json_type")
        expect(index.sql).toContain("context_")
      }
      // SQLite must be allowed to select these partial indexes for the exact
      // boolean predicate emitted by ContextLedgerPage.
      const queryPlans = [
        "EXPLAIN QUERY PLAN SELECT id FROM message INDEXED BY message_session_summary_probe_idx WHERE session_id='a' AND context_summary=1",
        "EXPLAIN QUERY PLAN SELECT id FROM message INDEXED BY message_session_opaque_probe_idx WHERE session_id='b' AND context_opaque=1",
        "EXPLAIN QUERY PLAN SELECT id FROM part INDEXED BY part_session_opaque_context_probe_idx WHERE session_id='b' AND context_opaque=1",
      ]
      for (const query of queryPlans) {
        const rows = db.query(query).all() as Array<{detail:string}>
        expect(rows.some((row) => row.detail.includes("INDEX"))).toBe(true)
      }
    } finally {
      db.close()
    }
  })
})
