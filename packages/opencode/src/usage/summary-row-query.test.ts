import { Database as SQLite } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { sql, type SQL } from "drizzle-orm"
import {
  usageScopedProjectFilter,
  usageSummaryDimensionsQuery,
  usageSummaryRawRowsQuery,
  usageSummaryRowsQuery,
} from "./summary-row-query"

const dialect = new SQLiteSyncDialect()

/** Isolated SQLite parity fixture. No application paths, processes, or user DB. */
function fixture() {
  const db = new SQLite(":memory:")
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT,directory TEXT,title TEXT);
    CREATE TABLE usage_session(session_id TEXT PRIMARY KEY,project_id TEXT,directory TEXT,title TEXT,project_name TEXT);
    CREATE TABLE project(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE usage_record(
      message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,provider_id TEXT,model_id TEXT,
      variant TEXT,created_at INTEGER,completed_at INTEGER NOT NULL,
      request_sent_at INTEGER,first_token_at INTEGER,streamed_at INTEGER,
      cost_usd REAL,input_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,
      output_tokens INTEGER,reasoning_tokens INTEGER,agent TEXT,mode TEXT
    );
    CREATE INDEX usage_record_completed_idx ON usage_record(completed_at);
    CREATE INDEX usage_record_session_completed_idx ON usage_record(session_id,completed_at);
    CREATE INDEX session_project_idx ON session(project_id);
    CREATE INDEX usage_session_project_idx ON usage_session(project_id);
  `)
  let seed = 0x7f1ba239
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 2 ** 32
  }
  const projects = ["p0", "p1", "p2", "p3", "p4"]
  const s = db.prepare("INSERT INTO session VALUES(?,?,?,?)")
  const h = db.prepare("INSERT INTO usage_session VALUES(?,?,?,?,?)")
  const p = db.prepare("INSERT INTO project VALUES(?,?)")
  const r = db.prepare("INSERT INTO usage_record VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  db.transaction(() => {
    projects.forEach(key => p.run(key, "Live " + key))
    for (let i = 0; i < 165; i++) {
      const id = "s" + i
      const assigned = projects[i % projects.length]!
      // Reassigned 1/13 of live sessions. Stale tombstone project MUST lose.
      if (i % 9 !== 0) s.run(id, i % 13 === 0 ? projects[(i + 2) % 5]! : assigned, "/live/" + id, "Live " + id)
      // Some deleted Sessions are represented only in the persistent tombstone.
      if (i % 4 !== 0) h.run(id, assigned, "/history/" + id, "Prior " + id, "History " + assigned)
    }
    for (let i = 0; i < 5_777; i++) {
      const roll = random()
      const sid = roll < .025 ? "orphan" + (i % 7) : "s" + Math.floor(random() * 165)
      const stamp = 1_700_000_000_000 + (i % 233) * 1000
      r.run(
        "m" + i,sid,i % 7 === 0 ? null : "provider" + i%4,
        i % 13 === 0 ? null : "model" + i%12,
        i%21 === 0 ? "" : i%11===0 ? "high" : null,
        stamp-100,stamp,null,null,null,i%3===0?null:i/100000,
        i%300, i%25, 3, i%40, 0,i%23===0?"summary":"build",i%31===0?"compaction":"primary",
      )
    }
  })()
  const query = <T = Record<string,unknown>>(statement: SQL): T[] => {
    const compiled = dialect.sqlToQuery(statement)
    return db.prepare(compiled.sql).all(...compiled.params as (number | string | null)[]) as T[]
  }
  return { db, query }
}

describe("Usage summary SQL exactness", () => {
  test("aggregation projection omits unused message identities without changing every scalar or page cursor", () => {
    const { db, query } = fixture()
    try {
      const request = { since: 1_700_000_000_000, until: 1_700_000_234_000 }
      for (const page of [undefined, { limit: 37, after: null }]) {
        const full = query(usageSummaryRawRowsQuery(request, page))
        const compact = query(usageSummaryRawRowsQuery(request, page, false))
        expect(compact).toHaveLength(full.length)
        expect(compact.every((row) => !Object.hasOwn(row, "id"))).toBe(true)
        for (let index = 0; index < full.length; index++) {
          const { id: _omitted, ...expected } = full[index]!
          expect(compact[index]).toEqual(expected)
        }
      }
    } finally { db.close() }
  })

  test("indexed project and time-first SQL produce identical complete rows across randomized scopes", () => {
    const { db, query } = fixture()
    try {
      const bounds = [
        [1_700_000_000_000,1_700_000_234_000],
        [1_700_000_012_000,1_700_000_026_000],
        [1_700_000_111_000,1_700_000_112_000],
        [1_700_000_221_000,1_700_000_250_000],
        [1_700_000_500_000,1_700_000_501_000],
      ]
      for (const [since, until] of bounds) {
        for (const projectID of ["p0","p1","p2","p3","p4"]) {
          const request = { since: since!,until: until! }
          const reference = query(usageSummaryRowsQuery(request,projectID,false))
          const candidate = query(usageSummaryRowsQuery(request,projectID,true))
          expect(candidate.length).toBe(reference.length)
          const mismatch = candidate.findIndex((row, i) => JSON.stringify(row) !== JSON.stringify(reference[i]))
          expect(mismatch).toBe(-1)
          const scopedIDs = query<{message_id:string}>(
            // Query tests the shared Inspection SQL project predicate.
            // All rows are selected by Session ID without metadata joins.
            sqlForScopedIDs(request,usageScopedProjectFilter(projectID)),
          ).map(row=>row.message_id).sort()
          expect(scopedIDs).toEqual(reference.map(row=>String(row.id)).sort())
        }
      }
    } finally { db.close() }
  })

  test("dimension-once slim rows match full attribution, including orphans, deleted sessions and reassignment", () => {
    const {db,query}=fixture()
    try {
      const request = {since:1_700_000_000_000,until:1_700_000_234_000}
      const dimensions = new Map(
        query<{session_id:string,project_id:string,directory:string,session_title:string,project_name:string|null}>(
          usageSummaryDimensionsQuery(request),
        ).map(row=>[row.session_id,row] as const),
      )
      const reference = query<{
        id: string
        project_id: string
        directory: string
        session_title: string
        project_name: string | null
      }>(usageSummaryRowsQuery(request,null,false))
      const slim = query<Record<string,unknown>>(usageSummaryRawRowsQuery(request))
      expect(dimensions.size).toBeGreaterThan(150)
      expect(slim.length).toBe(reference.length)
      for (let i=0;i<slim.length;i++) {
        const row=slim[i]!
        const dimension=dimensions.get(String(row.session_id))
        expect(dimension).toBeDefined()
        const expected=reference[i]!
        expect(row.id).toBe(expected.id)
        for(const key of ["project_id","directory","session_title","project_name"] as const)
          expect(dimension?.[key]).toEqual(expected[key])
      }
      expect([...dimensions.values()].some(row=>row.project_id==="__historical__")).toBe(true)
    } finally {db.close()}
  })

  test("keyset pages neither lose nor duplicate tied timestamps at varied page sizes", () => {
    const {db,query}=fixture()
    try {
      const request={since:1_700_000_000_000,until:1_700_000_234_000}
      const full=query<{id:string,completed_ms:number}>(usageSummaryRawRowsQuery(request))
      for(const limit of [1,2,3,7,17,127,4096,20_000]) {
        const out: string[] = []
        let after: {completedAt:number,rowID:number}|null=null
        let turns=0
        do {
          const page: Array<{id:string,completed_ms:number,cursor_id:number}> = query<{id:string,completed_ms:number,cursor_id:number}>(
            usageSummaryRawRowsQuery(request,{limit,after}),
          )
          if(!page.length)break
          out.push(...page.map(row=>row.id))
          const end=page.at(-1)!
          after={completedAt:end.completed_ms,rowID:end.cursor_id}
          turns++
          if(page.length<limit)break
          expect(turns).toBeLessThan(full.length+1)
        }while(true)
        expect(out).toEqual(full.map(row=>row.id))
        expect(new Set(out).size).toBe(full.length)
      }
    } finally {db.close()}
  })
})

function sqlForScopedIDs(request: {since:number;until:number}, project: SQL): SQL {
  // This deliberately uses the exact project filter fragment from production.
  return sql`SELECT r.message_id FROM usage_record r
    WHERE r.completed_at >= ${request.since} AND r.completed_at < ${request.until}
      AND ${project}`
}
