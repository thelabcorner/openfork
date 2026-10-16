import { Database as SQLite } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { Effect, Schema } from "effect"
import type { SQL } from "drizzle-orm"
import {
  generationMetricsQuery,
  generationProjectRowsQuery,
  generationProjectTotalsQuery,
  projectDurationQuery,
  projectFailingRowsQuery,
  projectRowsQuery,
  projectToolRowsQuery,
  runWorkload,
  toolRowsQuery,
  toolTotalsQuery,
} from "./workload-query"
import { WorkloadSnapshot } from "./workload"

const dialect = new SQLiteSyncDialect()

function fixture(withTools = true, nullableProject = false) {
  const db = new SQLite(":memory:")
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE usage_session (session_id TEXT PRIMARY KEY, project_id TEXT, project_name TEXT);
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE usage_record (
      message_id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT, model_id TEXT,
      mode TEXT, agent TEXT, created_at INTEGER, request_sent_at INTEGER,
      first_token_at INTEGER, streamed_at INTEGER, completed_at INTEGER NOT NULL,
      input_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      output_tokens INTEGER, reasoning_tokens INTEGER
    );
    CREATE INDEX usage_record_completed_idx ON usage_record(completed_at);
    CREATE INDEX usage_record_model_completed_idx ON usage_record(provider_id, model_id, completed_at);
    CREATE INDEX usage_record_session_completed_idx ON usage_record(session_id, completed_at);
  `)
  if (withTools) db.exec(`
    CREATE TABLE native_tool_settlement (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT${nullableProject ? "" : " NOT NULL"}, provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL
    );
    CREATE INDEX native_tool_settlement_completed_idx ON native_tool_settlement(completed_at);
    CREATE INDEX native_tool_settlement_provider_model_completed_idx ON native_tool_settlement(provider_id, model_id, completed_at);
  `)
  const execute = <T>(statement: SQL, method: "all" | "get") => {
    const compiled = dialect.sqlToQuery(statement)
    const prepared = db.prepare(compiled.sql)
    return prepared[method](...(compiled.params as (string | number | null)[])) as T
  }
  // The production reader supplies exactly these two scalar methods; a history
  // hydration or Instance dependency cannot be satisfied by this fixture.
  const reader = {
    all: <T>(statement: SQL) => Effect.sync(() => execute<T[]>(statement, "all")),
    get: <T>(statement: SQL) => Effect.sync(() => execute<T | undefined>(statement, "get")),
  } as unknown as Parameters<typeof runWorkload>[0]
  const snapshot = (request: Parameters<typeof runWorkload>[1]) => Effect.runPromise(runWorkload(reader, request))
  return { db, snapshot, execute }
}

describe("native workload projection", () => {
  test("separates host-observed TTFT and generation, excludes invalid/missing timestamps and maintenance", async () => {
    const { db, snapshot } = fixture(false)
    try {
      db.exec(`
        INSERT INTO session VALUES ('s1','project'), ('s2','other');
        INSERT INTO usage_record VALUES
          ('m1','s1','p','a','primary',NULL,100,120,140,200,300,NULL,NULL,NULL,NULL,NULL),
          ('m2','s1','p','a','primary',NULL,100,130,170,210,301,NULL,NULL,NULL,NULL,NULL),
          ('m3','s1','p','a','primary',NULL,100,NULL,NULL,110,302,NULL,NULL,NULL,NULL,NULL),
          ('m4','s1','p','a','primary',NULL,200,210,205,195,303,NULL,NULL,NULL,NULL,NULL),
          ('m5','s1','p','a','maintenance',NULL,100,120,140,200,304,NULL,NULL,NULL,NULL,NULL),
          ('m6','s2','p','b','primary',NULL,100,120,140,200,305,NULL,NULL,NULL,NULL,NULL);
      `)
      const result = await snapshot({ since: 300, until: 306, providerID: "p", modelID: "a", projectID: "project" })
      expect(() => Schema.decodeUnknownSync(WorkloadSnapshot)(result)).not.toThrow()
      expect(result.generation.settlements).toBe(4)
      expect(result.generation.quantiles).toBe("exact")
      expect(result.generation.requestToFirstToken).toEqual({ samples: 2, sumMs: 60, p50Ms: 20, p95Ms: 40 })
      expect(result.generation.clientToFirstToken).toEqual({ samples: 3, sumMs: 115, p50Ms: 40, p95Ms: 70 })
      expect(result.generation.streamedGeneration).toEqual({ samples: 2, sumMs: 100, p50Ms: 40, p95Ms: 60 })
      expect(result.generation.providerInternalTTFT).toBeNull()
      expect(result.tools.provenance).toBe("unavailable")
      expect(result.watermark.generationCompletedAt).toBe(303)
    } finally { db.close() }
  })

  test("counts terminal outcomes without treating abort/denial/timeout as tool errors; stable top-N and coverage", async () => {
    const { db, snapshot } = fixture()
    try {
      db.exec(`
        INSERT INTO session VALUES ('s','project'), ('other','other');
         INSERT INTO native_tool_settlement VALUES
           ('a','s','project','p','a','read','success',100,110,10),
           ('b','s','project','p','a','read','error',100,120,20),
           ('c','s','project','p','a','read','abort',120,130,10),
           ('d','s','project','p','a','bash','denied',100,140,40),
           ('e','s','project','p','a','bash','timeout',100,150,50),
           ('f','s','project','p','a','write','unknown',100,160,60),
           ('g','other','other','p','b','read','error',100,170,70);
      `)
      const result = await snapshot({ since: 110, until: 170, providerID: "p", modelID: "a", projectID: "project", limit: 2 })
      expect(result.tools.quantiles).toBe("exact")
      expect(result.tools.totals).toEqual({ calls: 6, success: 1, error: 1, abort: 1, denied: 1, timeout: 1, unknown: 1,
        duration: { samples: 6, sumMs: 190, p50Ms: 20, p95Ms: 60 } })
      expect(result.tools.rows.map((row) => [row.tool, row.calls])).toEqual([["read", 3], ["bash", 2]])
      expect(result.tools.topFailingRows.map((row) => [row.tool, row.error])).toEqual([["read", 1]])
      expect(result.tools.topSlowRows.map((row) => [row.tool, row.duration.sumMs])).toEqual([
        ["bash", 90], ["write", 60],
      ])
      const allSlow = await snapshot({ since: 110, until: 170, providerID: "p", modelID: "a", projectID: "project", limit: 3 })
      expect(allSlow.tools.topSlowRows.map((row) => [row.tool, row.duration.sumMs])).toEqual([
        ["bash", 90], ["write", 60], ["read", 40],
      ])
      expect(result.tools.rows[0]?.duration).toEqual({ samples: 3, sumMs: 40, p50Ms: 10, p95Ms: 20 })
      expect(result.tools.omittedTools).toBe(1)
      expect(result.tools.firstRecordedAt).toBe(110)
      expect(result.tools.coverage).toContain("historical")
    } finally { db.close() }
  })

  test("deleted-session tombstones count once; a live reassigned project wins", async () => {
    const { db, snapshot } = fixture()
    try {
      db.exec(`
        INSERT INTO session VALUES ('live','new');
        INSERT INTO usage_session VALUES ('live','old',NULL), ('deleted','old',NULL);
         INSERT INTO native_tool_settlement VALUES
           ('a','live','new','p','m','read','success',1,10,9),
           ('b','deleted','old','p','m','read','success',1,11,10);
      `)
      expect((await snapshot({ since: 0, until: 20, projectID: "old" })).tools.totals.calls).toBe(1)
      expect((await snapshot({ since: 0, until: 20, projectID: "new" })).tools.totals.calls).toBe(1)
    } finally { db.close() }
  })

  test("large generation cohorts preserve exact sums/counts but suppress expensive quantile sorts", async () => {
    const { db, snapshot } = fixture(false)
    try {
      const insert = db.prepare("INSERT INTO usage_record VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      db.transaction(() => {
        for (let i = 0; i < 10_001; i++) insert.run(`m${i}`, "s", "p", "m", "primary", null, 100, 110, 120, 150, 200 + i, null, null, null, null, null)
      })()
      const result = await snapshot({ since: 0, until: 20_000, providerID: "p", modelID: "m" })
      expect(result.generation.settlements).toBe(10_001)
      expect(result.generation.quantiles).toBe("suppressed-large-cohort")
      expect(result.generation.requestToFirstToken).toEqual({
        samples: 10_001, sumMs: 100_010, p50Ms: null, p95Ms: null,
      })
      expect(result.generation.streamedGeneration.sumMs).toBe(300_030)
    } finally { db.close() }
  })

  test("indexed time/model plans and bounded response on a 20k-row workload", async () => {
    const { db, snapshot, execute } = fixture()
    try {
      const insert = db.prepare("INSERT INTO native_tool_settlement VALUES(?,?,?,?,?,?,?,?,?,?)")
      db.transaction(() => {
        for (let i = 0; i < 20_000; i++) insert.run(`call${i}`, "s", "perf", `p${i % 4}`, `m${i % 6}`, `tool${i % 80}`, "success", i, i + 10, 10)
      })()
      const request = { since: 9_000, until: 10_000, providerID: "p1", modelID: "m1", limit: 5 }
      const plan = execute<{ detail: string }[]>(toolRowsQuery(request, 5), "all")
      // EXPLAIN must see the composite cohort index, not message/part JSON.
      const compiled = dialect.sqlToQuery(toolTotalsQuery(request))
      const steps = db.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`).all(...compiled.params as number[]) as { detail: string }[]
      expect(steps.some((step) => step.detail.includes("native_tool_settlement_provider_model_completed_idx"))).toBe(true)
      expect(plan.length).toBeLessThanOrEqual(5)
      const started = performance.now()
      const result = await snapshot(request)
      console.info(`workload 20k rows: ${(performance.now() - started).toFixed(1)}ms; plan: ${steps.map((step) => step.detail).join(" | ")}`)
      expect(result.tools.rows.length).toBeLessThanOrEqual(5)
      expect(result.tools.totals.calls).toBeGreaterThan(0)
      // The narrowly filtered cohort has fewer than the sort cap.
      expect(result.tools.quantiles).toBe("exact")
      const global = await snapshot({ since: 0, until: 25_000, limit: 5 })
      expect(global.tools.quantiles).toBe("suppressed-large-cohort")
      expect(global.tools.totals.duration.p95Ms).toBeNull()
      expect(global.tools.totals.calls).toBe(20_000)
      // Project drilldown shares the type-level suppression gate but keeps exact counts.
      expect(global.projects.quantiles).toBe("suppressed-large-cohort")
      expect(global.projects.totals.calls).toBe(20_000)
      expect(global.projects.rows[0]?.duration.samples).toBe(20_000)
      expect(global.projects.rows[0]?.duration.p50Ms).toBeNull()
      expect(global.projects.rows[0]?.topTools.length).toBeLessThanOrEqual(5)
      expect(global.projects.rows[0]?.topTools[0]?.duration.p50Ms).toBeNull()
      // Scoped project boards remain index-driven and stay free of transcript work.
      const failingPlan = dialect.sqlToQuery(projectFailingRowsQuery(request, 5))
      const compositionPlan = dialect.sqlToQuery(projectToolRowsQuery(request, ["perf"]))
      for (const plan of [failingPlan, compositionPlan]) {
        const planSteps = db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...(plan.params as (string | number)[])) as { detail: string }[]
        expect(planSteps.some((step) => step.detail.includes("native_tool_settlement_provider_model_completed_idx"))).toBe(true)
        expect(plan.sql).not.toMatch(/\b(?:message|part|json_extract)\b/i)
      }
      const durationSql = dialect.sqlToQuery(projectDurationQuery(request, ["perf"])).sql
      expect(durationSql).not.toMatch(/\b(?:message|part|json_extract)\b/i)
      const timingSql = dialect.sqlToQuery(generationMetricsQuery(request)).sql
      expect(timingSql).not.toMatch(/\b(?:message|part|json_extract)\b/i)
    } finally { db.close() }
  })

  test("top projects rank by call volume using producer-attributed project_id with independent sum coverage", async () => {
    const { db, snapshot } = fixture()
    try {
      // Session project deliberately differs from the settlement's producer-stamped
      // project: attribution must come from the settlement row, never a session join.
      db.exec(`
        INSERT INTO session VALUES ('s1','sessionProjectA'), ('s2','sessionProjectB');
        INSERT INTO native_tool_settlement VALUES
          ('a','s1','projX','p','m','read','success',100,110,10),
          ('b','s1','projX','p','m','read','success',100,111,10),
          ('c','s1','projX','p','m','bash','success',100,112,10),
          ('d','s2','projY','p','m','read','success',100,113,10),
          ('e','s2','projY','p','m','write','error',100,114,10),
          ('f','s1','projZ','p','m','read','denied',100,115,10),
          ('g','s2','projY','q','n','read','success',100,116,10);
      `)
      const compiled = dialect.sqlToQuery(projectRowsQuery({ since: 100, until: 120, providerID: "p", modelID: "m", limit: 2 }, 2))
      const steps = db.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`).all(...(compiled.params as number[])) as { detail: string }[]
      expect(steps.some((step) => step.detail.includes("native_tool_settlement_provider_model_completed_idx"))).toBe(true)

      const result = await snapshot({ since: 100, until: 120, providerID: "p", modelID: "m", limit: 2 })
      expect(result.projects.provenance).toBe("producer-settlement")
      expect(result.projects.rows.map((row) => [row.project, row.calls])).toEqual([["projX", 3], ["projY", 2]])
      expect(result.projects.totalProjects).toBe(3)
      expect(result.projects.omittedProjects).toBe(1)
      // Independent full-sum coverage is unaffected by the top-N truncation.
      expect(result.projects.totals.calls).toBe(6)
      expect(result.projects.quantiles).toBe("exact")
      expect(result.projects.rows[0]).toEqual({
        project: "projX", projectName: null, calls: 3, success: 3, error: 0, abort: 0, denied: 0, timeout: 0, unknown: 0,
        duration: { samples: 3, sumMs: 33, p50Ms: 11, p95Ms: 12 },
        topTools: [
          { tool: "read", calls: 2, success: 2, error: 0, abort: 0, denied: 0, timeout: 0, unknown: 0,
            duration: { samples: 2, sumMs: 21, p50Ms: 10, p95Ms: 11 } },
          { tool: "bash", calls: 1, success: 1, error: 0, abort: 0, denied: 0, timeout: 0, unknown: 0,
            duration: { samples: 1, sumMs: 12, p50Ms: 12, p95Ms: 12 } },
        ],
      })
      // Independent boards are not truncated by the volume limit; on this
      // fixture the failure and time leaders are outside the volume top-N.
      expect(result.projects.topFailingRows.map((row) => [row.project, row.error])).toEqual([["projY", 1]])
      expect(result.projects.topSlowRows.map((row) => [row.project, row.duration.sumMs])).toEqual([["projX", 33], ["projY", 27]])
      // A session-scoped project never stamped onto any settlement is an empty
      // cohort, not a fallback to the session/project join.
      const bySessionProject = await snapshot({ since: 100, until: 120, projectID: "sessionProjectA" })
      expect(bySessionProject.projects.totals.calls).toBe(0)
      expect(bySessionProject.projects.totalProjects).toBe(0)
      // provider+model drilldown narrows to exactly the matching cohort.
      expect((await snapshot({ since: 100, until: 120, providerID: "q", modelID: "n", limit: 5 })).projects.totals.calls).toBe(1)
    } finally { db.close() }
  })

  test("missing settlement project attribution surfaces as honest 'unknown'", async () => {
    const { db, snapshot } = fixture(true, true)
    try {
      db.exec(`
        INSERT INTO native_tool_settlement VALUES
          ('a','s','projX','p','m','read','success',100,110,10),
          ('b','s',NULL,'p','m','read','success',100,111,10),
          ('c','s',NULL,'p','m','bash','success',100,112,10);
      `)
      const result = await snapshot({ since: 100, until: 120, providerID: "p", modelID: "m", limit: 5 })
      expect(result.projects.rows.map((row) => [row.project, row.calls])).toEqual([["unknown", 2], ["projX", 1]])
      expect(result.projects.totalProjects).toBe(2)
      expect(result.projects.omittedProjects).toBe(0)
      // The sentinel row keeps full composition and an explicit null name.
      expect(result.projects.rows[0]?.projectName).toBeNull()
      expect(result.projects.rows[0]?.topTools.map((tool) => tool.tool)).toEqual(["bash", "read"])
    } finally { db.close() }
  })

  test("generation projects rank settled model calls so tool-less models appear, with tokens and generation time", async () => {
    const { db, snapshot } = fixture(false)
    try {
      db.exec(`
        INSERT INTO session VALUES ('s1','projX'), ('s2','projY');
        INSERT INTO project VALUES ('projX','Alpha'), ('projY','Beta');
        INSERT INTO usage_record VALUES
          ('m1','s1','p','a','primary',NULL,100,120,140,200,300,10,5,0,20,0),
          ('m2','s1','p','a','primary',NULL,100,120,141,201,301,10,5,0,20,0),
          ('m3','s1','p','a','primary',NULL,100,120,142,202,302,10,5,0,20,0),
          ('m4','s2','p','b','primary',NULL,100,120,140,200,303,0,0,0,0,0),
          ('m5','s2','p','b','primary',NULL,100,120,141,201,304,0,0,0,0,0),
          ('m6','s2','p','b','primary',NULL,300,NULL,NULL,NULL,305,0,0,0,0,0);
      `)
      const result = await snapshot({ since: 300, until: 306, providerID: "p", limit: 2 })
      // No native tool settlements exist, so the tool-count projection is empty...
      expect(result.tools.provenance).toBe("unavailable")
      expect(result.projects.totals.calls).toBe(0)
      // ...but settled model calls still rank projects, tool-less or not.
      expect(result.generationProjects.provenance).toBe("producer-settlement")
      expect(result.generationProjects.totals.settlements).toBe(6)
      expect(result.generationProjects.totals.settlements).toBe(result.generation.settlements)
      expect(result.generationProjects.rows).toEqual([
        { project: "projX", projectName: "Alpha", providerID: "p", modelID: "a",
          settlements: 3, generationMs: 180, generationRecords: 3,
          tokens: { input: 30, cacheRead: 15, cacheWrite: 0, output: 60, reasoning: 0 },
          tokenRecords: 3 },
        { project: "projY", projectName: "Beta", providerID: "p", modelID: "b",
          settlements: 3, generationMs: 120, generationRecords: 2,
          tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
          tokenRecords: 0 },
      ])
      expect(result.generationProjects.totalProjects).toBe(2)
      expect(result.generationProjects.omittedProjects).toBe(0)
      expect(result.generationProjects.unattributed.settlements).toBe(0)
    } finally { db.close() }
  })

  test("generation projects honor live reassignment, usage_session tombstones, and an explicit unattributed cohort", async () => {
    const { db, snapshot } = fixture(false)
    try {
      db.exec(`
        INSERT INTO session VALUES ('live','new');
        INSERT INTO usage_session VALUES ('live','old','OldName'), ('deleted','old','OldName');
        INSERT INTO project VALUES ('new','NewName');
        INSERT INTO usage_record VALUES
          ('a','live','p','m','primary',NULL,100,110,120,150,200,1,0,0,0,0),
          ('b','deleted','p','m','primary',NULL,100,110,120,150,201,1,0,0,0,0),
          ('c','orphan','p','m','primary',NULL,100,110,120,150,202,1,0,0,0,0);
      `)
      const result = await snapshot({ since: 200, until: 203, providerID: "p", modelID: "m", limit: 10 })
      expect(result.generationProjects.rows.map((row) => [row.project, row.projectName, row.settlements])).toEqual([
        ["new", "NewName", 1],
        ["old", "OldName", 1],
      ])
      expect(result.generationProjects.unattributed).toEqual({
        settlements: 1, generationMs: 30, generationRecords: 1,
        tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        tokenRecords: 1,
      })
      expect(result.generationProjects.totals.settlements).toBe(3)
      expect(result.generationProjects.totalProjects).toBe(2)
      expect(result.generationProjects.omittedProjects).toBe(0)
    } finally { db.close() }
  })

  test("generation project rows stay distinct when two projects share a name", async () => {
    const { db, snapshot } = fixture(false)
    try {
      db.exec(`
        INSERT INTO session VALUES ('s1','pA'), ('s2','pB');
        INSERT INTO project VALUES ('pA','Shared'), ('pB','Shared');
        INSERT INTO usage_record VALUES
          ('m1','s1','p','m','primary',NULL,100,110,120,150,200,0,0,0,0,0),
          ('m2','s2','p','m','primary',NULL,100,110,120,150,201,0,0,0,0,0);
      `)
      const result = await snapshot({ since: 200, until: 202, providerID: "p", modelID: "m", limit: 10 })
      expect(result.generationProjects.rows.map((row) => [row.project, row.projectName, row.settlements])).toEqual([
        ["pA", "Shared", 1],
        ["pB", "Shared", 1],
      ])
      expect(result.generationProjects.totalProjects).toBe(2)
      expect(result.generationProjects.omittedProjects).toBe(0)
    } finally { db.close() }
  })

  test("generation projects top-N truncation never shrinks independent full-sum totals", async () => {
    const { db, snapshot } = fixture(false)
    try {
      db.exec(`
        INSERT INTO session VALUES ('s1','p1'),('s2','p2'),('s3','p3');
        INSERT INTO usage_record VALUES
          ('a','s1','p','m','primary',NULL,100,110,120,150,200,0,0,0,0,0),
          ('b','s1','p','m','primary',NULL,100,110,120,150,201,0,0,0,0,0),
          ('c','s1','p','m','primary',NULL,100,110,120,150,202,0,0,0,0,0),
          ('d','s2','p','m','primary',NULL,100,110,120,150,203,0,0,0,0,0),
          ('e','s2','p','m','primary',NULL,100,110,120,150,204,0,0,0,0,0),
          ('f','s3','p','m','primary',NULL,100,110,120,150,205,0,0,0,0,0);
      `)
      const result = await snapshot({ since: 200, until: 206, providerID: "p", modelID: "m", limit: 2 })
      expect(result.generationProjects.rows.map((row) => [row.project, row.settlements])).toEqual([["p1", 3], ["p2", 2]])
      expect(result.generationProjects.totalProjects).toBe(3)
      expect(result.generationProjects.omittedProjects).toBe(1)
      expect(result.generationProjects.totals.settlements).toBe(6)
    } finally { db.close() }
  })

  test("generation project aggregation uses the composite provider/model/completed index on a 20k-row workload", async () => {
    const { db, snapshot } = fixture(false)
    try {
      db.exec(`INSERT INTO session VALUES ('s','perf');`)
      const insert = db.prepare("INSERT INTO usage_record VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      db.transaction(() => {
        for (let i = 0; i < 20_000; i++) insert.run(`m${i}`, "s", `p${i % 4}`, `m${i % 6}`, "primary", null, 100, 110, 120, 150, 200 + i, 0, 0, 0, 0, 0)
      })()
      const request = { since: 9_000, until: 10_000, providerID: "p1", modelID: "m1", limit: 2 }
      const totalsPlan = dialect.sqlToQuery(generationProjectTotalsQuery(request))
      const rowsPlan = dialect.sqlToQuery(generationProjectRowsQuery(request, 2))
      const steps = [
        ...db.prepare(`EXPLAIN QUERY PLAN ${totalsPlan.sql}`).all(...(totalsPlan.params as number[])) as { detail: string }[],
        ...db.prepare(`EXPLAIN QUERY PLAN ${rowsPlan.sql}`).all(...(rowsPlan.params as number[])) as { detail: string }[],
      ]
      expect(steps.some((step) => step.detail.includes("usage_record_model_completed_idx"))).toBe(true)
      const result = await snapshot(request)
      expect(result.generationProjects.rows.length).toBeLessThanOrEqual(2)
      expect(result.generationProjects.totals.settlements).toBeGreaterThan(0)
      expect(result.generationProjects.totals.settlements).toBe(result.generation.settlements)
    } finally { db.close() }
  })

  test("project boards carry names, bounded composition and measurable-duration coverage", async () => {
    const { db, snapshot } = fixture()
    try {
      db.exec(`
        INSERT INTO project VALUES ('pA','Alpha'), ('pD',NULL);
        INSERT INTO usage_session (session_id, project_id, project_name) VALUES
          ('deleted','pB','Beta'), ('deleted2','pD','TombName');
        INSERT INTO native_tool_settlement VALUES
          ('a','s','pA','p','m','read','success',100,110,10),
          ('b','s','pA','p','m','read','success',100,120,20),
          ('c','s','pA','p','m','bash','error',100,130,30),
          ('d','s','pA','p','m','write','abort',130,120,0),
          ('e','s','pB','p','m','write','error',100,140,40),
          ('f','s','pB','p','m','write','error',100,150,50),
          ('g','s','pC','p','m','read','success',100,160,60),
          ('h','s','pD','p','m','read','success',100,165,5);
      `)
      const result = await snapshot({ since: 100, until: 170, providerID: "p", modelID: "m", limit: 1 })
      // Volume truncates to pA; failure and time leaders stay independently visible.
      expect(result.projects.rows.map((row) => row.project)).toEqual(["pA"])
      expect(result.projects.topFailingRows.map((row) => [row.project, row.error])).toEqual([["pB", 2]])
      expect(result.projects.topSlowRows.map((row) => [row.project, row.duration.sumMs])).toEqual([["pB", 90]])

      const alpha = result.projects.rows[0]
      expect(() => Schema.decodeUnknownSync(WorkloadSnapshot)(result)).not.toThrow()
      expect([alpha.projectName, alpha.calls, alpha.success, alpha.error, alpha.abort]).toEqual(["Alpha", 4, 2, 1, 1])
      // Invalid clocks count as calls but not as measured duration samples.
      expect(alpha.duration).toEqual({ samples: 3, sumMs: 60, p50Ms: 20, p95Ms: 30 })
      expect(alpha.topTools.map((tool) => [tool.tool, tool.calls, tool.duration.samples, tool.error])).toEqual([
        ["read", 2, 2, 0], ["bash", 1, 1, 1], ["write", 1, 0, 0],
      ])
      expect(alpha.topTools[0]?.duration).toEqual({ samples: 2, sumMs: 30, p50Ms: 10, p95Ms: 20 })
      expect(alpha.topTools[2]?.duration).toEqual({ samples: 0, sumMs: 0, p50Ms: null, p95Ms: null })

      const beta = result.projects.topFailingRows[0]
      expect([beta.projectName, beta.error, beta.duration.sumMs]).toEqual(["Beta", 2, 90])
      expect(beta.topTools.map((tool) => [tool.tool, tool.error, tool.duration.p50Ms, tool.duration.p95Ms])).toEqual([
        ["write", 2, 40, 50],
      ])

      const all = await snapshot({ since: 100, until: 170, providerID: "p", modelID: "m" })
      // A project with no durable name stays explicitly unnamed; a live project
      // row with a null name falls back to its retained tombstone name.
      expect(all.projects.rows.find((row) => row.project === "pC")?.projectName).toBeNull()
      expect(all.projects.rows.find((row) => row.project === "pD")?.projectName).toBe("TombName")
      expect(all.projects.rows.find((row) => row.project === "pD")?.topTools.map((tool) => tool.tool)).toEqual(["read"])
    } finally { db.close() }
  })
})
