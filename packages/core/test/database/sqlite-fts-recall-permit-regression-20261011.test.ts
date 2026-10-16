import { describe, expect, test } from "bun:test"
import { Database as NativeDb } from "bun:sqlite"
import * as Effect from "effect/Effect"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { SessionSearch } from "../../src/session/search"
import { sqliteFingerprint } from "../../src/database/sqlite-query-forensics"
import { sqliteQueryShape } from "../../src/database/sqlite-query-shape"

// This is the real production SQL rendered through Drizzle. Never read a user's DB.
const dialect = new SQLiteSyncDialect()
async function statements(ranking: "recent" | "relevance" = "relevance") {
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const db = {
    all(query: Parameters<typeof dialect.sqlToQuery>[0]) {
      statements.push(dialect.sqlToQuery(query))
      return Effect.succeed([])
    },
  }
  await Effect.runPromise(SessionSearch.search(db as never, {
    query: "needle", directoryPrefixes: ["/approved"], includeArchived: false,
    ranking, limit: 10,
  }))
  return statements
}

function fixture() {
  const db = new NativeDb(":memory:")
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, project_id TEXT NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT NOT NULL, time_created INTEGER NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL, search_text TEXT NOT NULL);
    CREATE INDEX part_session_idx ON part(session_id);
    CREATE INDEX session_directory_idx ON session(directory);
    CREATE VIRTUAL TABLE part_fts USING fts5(search_text, content='part', content_rowid='rowid');
  `)
  const session = db.prepare("INSERT INTO session (id,directory,title,project_id,time_archived) VALUES (?,?,?,?,?)")
  const message = db.prepare("INSERT INTO message (id,data,time_created) VALUES (?,?,?)")
  const part = db.prepare("INSERT INTO part (id,session_id,message_id,data,search_text) VALUES (?,?,?,?,?)")
  db.exec("BEGIN")
  for (let s = 0; s < 80; s++) {
    const id = "s" + s
    session.run(id, s % 4 === 0 ? "/approved/doc" + s : "/elsewhere/doc" + s, id, "project", s % 13 === 0 ? 1234 : null)
    for (let p = 0; p < 10; p++) {
      const n = s * 10 + p
      const msg = "m" + n
      message.run(msg, '{"role":"user"}', n)
      part.run("p" + n, id, msg, '{"type":"text"}', n % 7 === 0 ? "needle exemplar" : "common term")
    }
  }
  db.exec("COMMIT")
  db.exec("INSERT INTO part_fts(part_fts) VALUES('rebuild')")
  return db
}

describe("historical incident c2b111a6: scoped relevance FTS plan", () => {
  test("Drizzle emits a bounded FTS-first plan rather than one FTS probe per scoped part", async () => {
    const query = (await statements())[2]!
    // Known precise offending template before this repair: 1065 bytes, hash c2b111a6.
    expect(query.sql.length).toBeGreaterThan(100)
    expect(sqliteQueryShape(query.sql)).toContain("json=1")
    expect(query.sql).not.toMatch(/FROM\s*\(\s*SELECT\s+p\.rowid[\s\S]*?CROSS\s+JOIN\s+part_fts/i)
    expect(query.sql).toMatch(/FROM\s+part_fts\s+CROSS\s+JOIN\s+part\s+p/i)
    expect(sqliteFingerprint(query.sql)).not.toBe("c2b111a6")
    const db = fixture()
    try {
      const rows = db.prepare(query.sql).all(...(query.params as Array<string | number | null>)) as Array<{ part_id: string; directory: string }>
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThanOrEqual(10)
      expect(rows.every((row) => row.directory.startsWith("/approved/"))).toBe(true)
      // FTS must be the outer loop; joining one scoped row to MATCH for every part is prohibited.
      const detail = db.prepare("EXPLAIN QUERY PLAN " + query.sql).all(...(query.params as Array<string | number | null>))
        .map((row: any) => String(row.detail))
      expect(detail.some((line: string) => /VIRTUAL TABLE INDEX/i.test(line))).toBe(true)
    } finally {
      db.close()
    }
  })

  test("recent ranking still returns scoped native V1 parts", async () => {
    const query = (await statements("recent"))[2]!
    const db = fixture()
    try {
      const rows = db.prepare(query.sql).all(...(query.params as Array<string | number | null>)) as Array<{ part_id: string; directory: string }>
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.directory.startsWith("/approved/"))).toBe(true)
    } finally {
      db.close()
    }
  })
})
