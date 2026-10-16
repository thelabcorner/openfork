import { afterAll, describe, expect } from "bun:test"
import path from "path"
import { Worker } from "node:worker_threads"
import { sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Usage } from "@/usage/usage"
import { shouldIndexUsageProject } from "@/usage/project-read-plan"
import { usageSummaryDimensionsQuery, usageSummaryRawRowsQuery } from "@/usage/summary-row-query"
import { queryPortfolio, valuePortfolio } from "@/usage/portfolio-query"
import { buildRates } from "@/usage/valuation"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const BASE = 1_700_000_000_000

const CATALOG: Record<string, ModelsDev.Provider> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: [],
    models: {
      "claude-3.5": {
        id: "claude-3.5",
        name: "Claude 3.5",
        family: "claude",
        release_date: "2024-01-01",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 100000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: [],
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        family: "gpt",
        release_date: "2024-05-01",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 64000 },
        cost: { input: 2.5, output: 10, cache_read: 0.25, cache_write: 2.5 },
      },
    },
  },
}

let pricingCatalogReads = 0
const modelsDevStub = Layer.succeed(
  ModelsDev.Service,
  ModelsDev.Service.of({
    getCached: () => Effect.succeed({}),
    getForSelectedProvider: () => Effect.succeed(CATALOG),
    get: () => Effect.gen(function* () {
      pricingCatalogReads++
      return CATALOG
    }),
    getDecisionModels: () => Effect.succeed({}),
    refresh: () => Effect.void,
  }),
)

type SeedMessage = {
  id: string
  sessionID: string
  providerID: string
  modelID: string
  variant?: string
  created: number
  completed: number
  requestSentAt?: number
  firstTokenAt?: number
  streamedAt?: number
  cost?: number | null
  mode?: string
  agent?: string
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
}

const MESSAGES: SeedMessage[] = [
  {
    id: "m1",
    sessionID: "s1",
    providerID: "anthropic",
    modelID: "claude-3.5",
    created: BASE,
    completed: BASE + 10_000,
    requestSentAt: BASE,
    firstTokenAt: BASE + 400,
    streamedAt: BASE + 9_000,
    cost: 0.003,
    tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 50, reasoning: 0 },
  },
  {
    id: "m2",
    sessionID: "s1",
    providerID: "anthropic",
    modelID: "claude-3.5",
    variant: "high",
    created: BASE + 60_000,
    completed: BASE + 70_000,
    requestSentAt: BASE + 60_000,
    firstTokenAt: BASE + 60_300,
    streamedAt: BASE + 69_000,
    cost: 0.002,
    tokens: { input: 50, cacheRead: 150, cacheWrite: 30, output: 80, reasoning: 20 },
  },
  {
    id: "m3",
    sessionID: "s2",
    providerID: "openai",
    modelID: "gpt-4o",
    created: BASE + 3_600_000,
    completed: BASE + 3_601_000,
    cost: null,
    tokens: { input: 200, cacheRead: 100, cacheWrite: 0, output: 40, reasoning: 0 },
  },
  {
    id: "m4",
    sessionID: "s3",
    providerID: "openai",
    modelID: "gpt-4o",
    created: BASE + 7_200_000,
    completed: BASE + 7_201_000,
    cost: 0.0001,
    tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 },
  },
  {
    id: "m5",
    sessionID: "s3",
    providerID: "mystery",
    modelID: "unknown-model",
    created: BASE + 8_000_000,
    completed: BASE + 8_001_000,
    cost: null,
    tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 },
  },
  {
    id: "m6-compaction",
    sessionID: "s1",
    providerID: "anthropic",
    modelID: "claude-3.5",
    created: BASE + 90_000,
    completed: BASE + 92_000,
    cost: 0.001,
    mode: "compaction",
    agent: "compaction",
    tokens: { input: 80, cacheRead: 10, cacheWrite: 0, output: 10, reasoning: 0 },
  },
]

function seedMessage(db: Database.Interface["db"], message: SeedMessage) {
  const data = {
    role: "assistant",
    time: {
      created: message.created,
      completed: message.completed,
      ...(message.requestSentAt !== undefined ? { requestSentAt: message.requestSentAt } : {}),
      ...(message.firstTokenAt !== undefined ? { firstTokenAt: message.firstTokenAt } : {}),
      ...(message.streamedAt !== undefined ? { streamedAt: message.streamedAt } : {}),
    },
    modelID: message.modelID,
    providerID: message.providerID,
    ...(message.variant !== undefined ? { variant: message.variant } : {}),
    cost: message.cost ?? null,
    tokens: {
      input: message.tokens.input,
      output: message.tokens.output,
      reasoning: message.tokens.reasoning,
      cache: { read: message.tokens.cacheRead, write: message.tokens.cacheWrite },
    },
    parentID: `parent-${message.id}`,
    mode: message.mode ?? "primary",
    agent: message.agent ?? "build",
    path: { cwd: "/cwd", root: "/root" },
  }
  return db.run(
    sql`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (${message.id}, ${message.sessionID}, ${message.created}, ${message.completed}, ${JSON.stringify(data)})
    `,
  )
}

function seedUsageRecord(db: Database.Interface["db"], message: SeedMessage) {
  return db.run(sql`
    INSERT INTO usage_record (
      message_id, session_id, provider_id, model_id, variant, agent, mode,
      created_at, request_sent_at, first_token_at, streamed_at, completed_at,
      cost_usd, input_tokens, cache_read_tokens, cache_write_tokens,
      output_tokens, reasoning_tokens
    ) VALUES (
      ${message.id}, ${message.sessionID}, ${message.providerID}, ${message.modelID}, ${message.variant ?? null},
      ${message.agent ?? "build"}, ${message.mode ?? "primary"}, ${message.created},
      ${message.requestSentAt ?? null}, ${message.firstTokenAt ?? null}, ${message.streamedAt ?? null},
      ${message.completed}, ${message.cost ?? null}, ${message.tokens.input}, ${message.tokens.cacheRead},
      ${message.tokens.cacheWrite}, ${message.tokens.output}, ${message.tokens.reasoning}
    )
  `)
}

const seedDatabase = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`
    INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
    VALUES ('p1', '/proj/a', 'proj-a', '[]', ${BASE}, ${BASE}),
           ('p2', '/proj/b', 'proj-b', '[]', ${BASE}, ${BASE})
  `)
  yield* db.run(sql`
    INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
    VALUES ('s1', 'p1', '/proj/a', 's1', 'Session 1', '1', ${BASE}, ${BASE}),
           ('s2', 'p1', '/proj/a', 's2', 'Session 2', '1', ${BASE}, ${BASE}),
           ('s3', 'p2', '/proj/b', 's3', 'Session 3', '1', ${BASE}, ${BASE})
  `)
  yield* Effect.forEach(MESSAGES, (message) =>
    Effect.all([seedMessage(db, message), seedUsageRecord(db, message)], { discard: true }),
  )
  yield* db.run(sql`
    INSERT INTO maintenance_usage (
      agent, provider_id, model_id, variant, session_id, project_id, requests,
      cost_usd, cost_estimated, input_tokens, cache_read_tokens, cache_write_tokens,
      output_tokens, reasoning_tokens, total_tokens, time_started, time_completed
    ) VALUES
      ('title', 'anthropic', 'claude-3.5', NULL, 's1', 'p1', 1,
       0.0002, 0, 20, 0, 0, 5, 0, 25, ${BASE + 20_000}, ${BASE + 20_500}),
      ('prompt-revisor', 'openai', 'gpt-4o', NULL, 's3', 'p2', 1,
       0.0003, 1, 30, 0, 0, 10, 0, 40, ${BASE + 7_300_000}, ${BASE + 7_301_000})
  `)
})

const tmp = await tmpdir()
const dbPath = path.join(tmp.path, "openfork.db")
const usageLayer = LayerNode.compile(Usage.node, [
  [Database.node, Database.layerFromPath(dbPath)],
  [ModelsDev.node, modelsDevStub],
])
const leasedUsageLayer = LayerNode.compile(Usage.node, [
  [Database.node, Database.layerFromPath(dbPath, { scanReaders: 2 })],
  [ModelsDev.node, modelsDevStub],
])
await Effect.runPromise(seedDatabase.pipe(Effect.provide(Database.layerFromPath(dbPath))))

const it = testEffect(usageLayer)

// Usage summaries intentionally scan from a dedicated read connection. Keep
// the backing temp database alive through the test bodies instead of disposing
// it immediately after module-level test registration completes.
afterAll(async () => {
  await tmp[Symbol.asyncDispose]()
})

describe("usage summary aggregation", () => {
  it.live("experimental worker reuses the exact rich accumulator with full response parity", () =>
    Effect.gen(function* () {
      const usage=yield* Usage.Service
      const worker=new Worker(new URL("../../script/bench-usage-rich-worker.ts",import.meta.url),{
        workerData:{filename:dbPath,catalog:CATALOG},
      })
      try {
        yield* Effect.promise(()=>new Promise<void>((resolve,reject)=>{
          worker.once("message",(message)=>message?.kind==="ready"
            ? resolve() : reject(Error("Worker did not initialize")))
          worker.once("error",reject)
        }))
        const requests: Usage.UsageSummaryRequest[]=[
          {since:BASE,until:BASE+8_002_000,projectID:null,resolution:"hour" as const},
          {since:BASE,until:BASE+8_002_000,projectID:"p1",resolution:"day" as const},
          {since:BASE,until:BASE+8_002_000,projectID:"p2",resolution:"hour" as const},
          {since:BASE,until:BASE+8_002_000,projectID:"__historical__",resolution:"day" as const},
        ]
        // Deterministic differential fuzzing: unaligned times, empty windows,
        // project attribution, and both chart resolutions. Each is checked
        // against the production reader in BOTH worker hydration modes.
        let seed = 0x5f1d48a3
        const next = () => (seed = (Math.imul(seed,1664525)+1013904223)>>>0)
        const scopes = [null,"p1","p2","__historical__"] as const
        for(let sample=0;sample<24;sample++){
          const start=BASE+(next()%9_000_000)
          const duration=next()%7_900_000
          requests.push({
            since:start,
            until:start+duration,
            projectID:scopes[next()%scopes.length]!,
            resolution:next()%2===0?"hour":"day",
          })
        }
        for(let i=0;i<requests.length;i++){
          Usage.resetUsageSummaryCache()
          const expected=yield* usage.summary(requests[i]!)
          for (const streamRows of [false, true]) {
            const result=yield* Effect.promise(()=>new Promise<{summary:Usage.UsageSummary}>((resolve,reject)=>{
              worker.once("message",(message)=>message.kind==="error"
                ? reject(Error(String(message.error))) : resolve(message))
              worker.postMessage({kind:"summary",id:i,request:requests[i],streamRows})
            }))
            expect(Schema.is(Usage.UsageSummary)(result.summary)).toBe(true)
            expect(result.summary).toEqual(expected)
          }
        }
        // Shared cancellation is checked from the native cursor even when
        // the worker cannot process new postMessage requests mid-fold. The
        // rollback must leave the connection usable for the next summary.
        const flag = new SharedArrayBuffer(4)
        Atomics.store(new Int32Array(flag),0,1)
        const stopped=yield* Effect.promise(()=>new Promise<{kind:string;cancelled?:boolean}>((resolve,reject)=>{
          worker.once("message",resolve)
          worker.once("error",reject)
          worker.postMessage({kind:"summary",id:12345,request:requests[0],streamRows:true,cancelFlag:flag})
        }))
        expect(stopped.kind).toBe("error")
        expect(stopped.cancelled).toBe(true)
        const recovered=yield* Effect.promise(()=>new Promise<{summary:Usage.UsageSummary}>((resolve,reject)=>{
          worker.once("message",(message)=>message.kind==="error"
            ? reject(Error(String(message.error))) : resolve(message))
          worker.once("error",reject)
          worker.postMessage({kind:"summary",id:12346,request:requests[0],streamRows:true})
        }))
        Usage.resetUsageSummaryCache()
        expect(recovered.summary).toEqual(yield* usage.summary(requests[0]!))
      }finally{
        yield* Effect.promise(async()=>{
          try{
            const closed=new Promise<void>((resolve,reject)=>{
              worker.once("message",(message)=>message?.kind==="closed"
                ? resolve() : reject(Error("Worker did not close cleanly")))
              worker.once("error",reject)
            })
            worker.postMessage({kind:"close"})
            await closed
          }finally{await worker.terminate()}
        })
      }
    }),
  )

  it.live("worker cancels a running SQL cursor without waiting for its message loop", () =>
    Effect.gen(function* () {
      const database = Database.layerFromPath(dbPath)
      const update = (statement: ReturnType<typeof sql>) => Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(statement).pipe(Effect.orDie)
      }).pipe(Effect.provide(database))
      const count = 25_000
      const since = BASE + 20_000_000
      const request = {since,until:since+count*1000+1000,resolution:"hour" as const,projectID:null}
      yield* update(sql`
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ${count-1})
        INSERT INTO usage_record (
          message_id, session_id, provider_id, model_id, variant, agent, mode,
          created_at, completed_at, cost_usd, input_tokens, cache_read_tokens,
          cache_write_tokens, output_tokens, reasoning_tokens
        ) SELECT 'worker-cancel-' || i, 's1', 'anthropic', 'claude-3.5',
          NULL, 'build', 'primary', ${since} + i*1000,
          ${since} + i*1000+100, 0.0001, 100, 20, 0, 40, 2 FROM n
      `)
      const worker = new Worker(new URL("../../script/bench-usage-rich-worker.ts",import.meta.url),{
        workerData:{filename:dbPath,catalog:CATALOG},
      })
      try {
        yield* Effect.promise(()=>new Promise<void>((resolve,reject)=>{
          worker.once("message",(message)=>message?.kind==="ready"
            ? resolve():reject(Error("Worker did not initialize")))
          worker.once("error",reject)
        }))
        const cancelFlag = new SharedArrayBuffer(4)
        const stopped = yield* Effect.promise(()=>new Promise<{
          kind:string; cancelled?:boolean; rowCount?:number
        }>((resolve,reject)=>{
          const onMessage = (message:any) => {
            if(message.id!==125)return
            if(message.kind==="progress"){
              Atomics.store(new Int32Array(cancelFlag),0,1)
              return
            }
            worker.off("message",onMessage)
            resolve(message)
          }
          worker.on("message",onMessage)
          worker.once("error",reject)
          worker.postMessage({kind:"summary",id:125,request,streamRows:true,
            reportProgressEvery:1000,cancelFlag})
        }))
        expect(stopped.kind).toBe("error")
        expect(stopped.cancelled).toBe(true)
        expect(stopped.rowCount).toBeGreaterThanOrEqual(1000)
        expect(stopped.rowCount).toBeLessThan(count)
        const healthy=yield* Effect.promise(()=>new Promise<{kind:string;summary:Usage.UsageSummary}>((resolve,reject)=>{
          worker.once("message",(message)=>message.kind==="error"
            ?reject(Error(String(message.error))):resolve(message))
          worker.once("error",reject)
          worker.postMessage({kind:"summary",id:126,request,streamRows:true})
        }))
        expect(healthy.kind).toBe("summary")
        expect(healthy.summary.totals.messages).toBe(count)
        expect(Schema.is(Usage.UsageSummary)(healthy.summary)).toBe(true)
      }finally{
        yield* Effect.promise(async()=>{
          try{
            const closed=new Promise<void>((resolve,reject)=>{
              worker.once("message",(message)=>message?.kind==="closed"
                ?resolve():reject(Error("Worker did not close")))
              worker.once("error",reject)
            })
            worker.postMessage({kind:"close"})
            await closed
          }finally{await worker.terminate()}
        })
        yield* update(sql`DELETE FROM usage_record WHERE message_id LIKE 'worker-cancel-%'`)
        Usage.resetUsageSummaryCache()
      }
    }),
  )

  it.live("distinguishes null and empty-string maintenance variants without changing request totals", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const range = { since: BASE + 9_000_000, until: BASE + 9_005_000, resolution: "hour" as const, projectID: "p1" }
      const query = (querySql: ReturnType<typeof sql>) => Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(querySql).pipe(Effect.orDie)
      }).pipe(Effect.provide(Database.layerFromPath(dbPath)))
      try {
        yield* query(sql`
          INSERT INTO maintenance_usage (
            agent, provider_id, model_id, variant, session_id, project_id,
            requests, cost_usd, cost_estimated, input_tokens, cache_read_tokens,
            cache_write_tokens, output_tokens, reasoning_tokens, total_tokens,
            time_started, time_completed
          ) VALUES
          ('title','anthropic','claude-3.5',NULL,'s1','p1',1,0.001,0,10,0,0,2,0,12,${BASE+9_000_001},${BASE+9_000_100}),
          ('title','anthropic','claude-3.5','','s1','p1',1,0.002,0,10,0,0,2,0,12,${BASE+9_000_101},${BASE+9_000_200})
        `)
        Usage.resetUsageSummaryCache()
        const result = yield* usage.summary(range)
        expect(result.maintenance.totals.requests).toBe(2)
        expect(result.maintenance.models).toHaveLength(2)
        // Maintenance models are ordered by spend, not by variant identity.
        expect(new Set(result.maintenance.models.map((model) => model.variant))).toEqual(new Set([null, ""]))
        expect(result.maintenance.models.map((model) => model.requests)).toEqual([1, 1])
      } finally {
        yield* query(sql`DELETE FROM maintenance_usage WHERE time_completed BETWEEN ${BASE+9_000_100} AND ${BASE+9_000_200}`)
        Usage.resetUsageSummaryCache()
      }
    }),
  )

  it.live("opt-in two-reader service has complete rich-schema parity across concurrent scopes", () =>
    Effect.gen(function* () {
      const ordinary = yield* Usage.Service
      const requests = [
        { since: BASE, until: BASE + 8_002_000, resolution: "hour" as const, projectID: null },
        { since: BASE, until: BASE + 8_002_000, resolution: "day" as const, projectID: "p1" },
        { since: BASE, until: BASE + 8_002_000, resolution: "hour" as const, projectID: "p2" },
        { since: BASE, until: BASE + 8_002_000, resolution: "day" as const, projectID: "__historical__" },
        { since: BASE + 12_345, until: BASE + 40_000, resolution: "hour" as const, projectID: null },
        { since: 0, until: BASE + 8_002_000, resolution: "day" as const, projectID: null },
      ]
      Usage.resetUsageSummaryCache()
      const authoritative = yield* Effect.forEach(requests, (request) => ordinary.summary(request))
      Usage.resetUsageSummaryCache()
      const parallel = yield* Effect.gen(function* () {
        const usage = yield* Usage.Service
        return yield* Effect.all(requests.map((request) => usage.summary(request)), { concurrency: "unbounded" })
      }).pipe(Effect.provide(leasedUsageLayer))
      expect(parallel).toEqual(authoritative)
      for (const result of parallel) {
        expect(Schema.is(Usage.UsageSummary)(result)).toBe(true)
      }
      Usage.resetUsageSummaryCache()
    }),
  )

  it.live("rich response obeys the public schema and cross-dimensional accounting invariants", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const range = { since: BASE, until: BASE + 8_002_000, resolution: "hour" as const }
      for (const projectID of [null, "p1", "p2", "__historical__"]) {
        const value = yield* usage.summary({ ...range, projectID })
        expect(Schema.is(Usage.UsageSummary)(value)).toBe(true)
        const count = (rows: readonly { messages: number }[]) => rows.reduce((sum, row) => sum + row.messages, 0)
        for (const rows of [value.providers, value.models, value.variants, value.projects, value.periods,
                            value.dow, value.hours, value.punchcard]) {
          expect(count(rows)).toBe(value.totals.messages)
        }
        const expenditure = value.totals.cost + value.totals.estimatedCost
        expect(value.providers.reduce((sum, row) => sum + row.cost + row.estimatedCost, 0))
          .toBeCloseTo(expenditure, 8)
        expect(value.models.reduce((sum, row) => sum + row.cost + row.estimatedCost, 0))
          .toBeCloseTo(expenditure, 8)
        expect(value.periods.reduce((sum, row) => sum + row.cost, 0))
          .toBeCloseTo(expenditure, 8)
        const tokens = value.totals.tokens
        for (const field of ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const) {
          expect(value.models.reduce((sum, row) => sum + row.tokens[field], 0)).toBe(tokens[field])
          expect(value.providers.reduce((sum, row) => sum + row.tokens[field], 0)).toBe(tokens[field])
        }
        expect(value.projects.reduce((sum, row) => sum + row.sessions, 0)).toBe(value.totals.sessions)
        expect(value.activity.activeDays).toBe(value.days.length)
      }
    }),
  )

  it.live("SQL portfolio projection matches rich provider, model, variant and distinct-session facts", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const rates = buildRates(CATALOG)
      for (const projectID of [null, "p1", "p2", "__historical__"]) {
        const request = { since: BASE, until: BASE + 8_002_000, resolution: "hour" as const, projectID }
        const full = yield* usage.summary(request)
        const { groups, providerSessions } = yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db.transaction((tx) => queryPortfolio(tx, request, false), { behavior: "deferred" }).pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.layerFromPath(dbPath)))
        const compact = valuePortfolio(groups, providerSessions, rates)
        if (projectID === "p1" || projectID === "p2") {
          const alternative = yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            return yield* db.transaction((tx) => queryPortfolio(tx, request, true), { behavior: "deferred" }).pipe(Effect.orDie)
          }).pipe(Effect.provide(Database.layerFromPath(dbPath)))
          expect(valuePortfolio(alternative.groups, alternative.providerSessions, rates)).toEqual(compact)
        }
        for (const field of ["providers", "models", "variants"] as const) {
          const expected = full[field]
          const actual = compact[field]
          expect(actual.length).toBe(expected.length)
          const comparable = (item: (typeof actual)[number]) => JSON.stringify(
            "providerID" in item ? {
              providerID: item.providerID,
              ...("modelID" in item ? { modelID: item.modelID, variant: item.variant } : {}),
            } : { variant: item.variant },
          )
          const lookup = new Map(actual.map(item => [comparable(item), item]))
          for (const row of expected) {
            const matched = lookup.get(comparable(row))
            expect(matched).toBeDefined()
            if (!matched) continue
            for (const [key, value] of Object.entries(row)) {
              const other = (matched as Record<string, unknown>)[key]
              if (typeof value === "number") expect(other as number).toBeCloseTo(value, 8)
              else if (key === "tokens") expect(other).toEqual(value)
              else expect(other).toEqual(value)
            }
          }
        }
      }
    }),
  )
  it.live("does not reuse a historical snapshot for a disjoint equal-length interval", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const first = yield* usage.summary({
        since: BASE,
        until: BASE + 3_600_000,
        resolution: "hour",
        projectID: null,
      })
      const second = yield* usage.summary({
        since: BASE + 3_600_000,
        until: BASE + 7_200_000,
        resolution: "hour",
        projectID: null,
      })
      expect(first.totals.messages).toBe(2)
      expect(second.totals.messages).toBe(1)
      expect(first.since).toBe(BASE)
      expect(second.since).toBe(BASE + 3_600_000)
    }),
  )

  it.live("shares a single cold scan among concurrent requests for the same range", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const beforeCatalogReads = pricingCatalogReads
      const request = {
        since: BASE + 1_234,
        until: BASE + 8_002_345,
        resolution: "hour" as const,
        projectID: null,
      }
      const summaries = yield* Effect.all(
        Array.from({ length: 12 }, () => usage.summary(request)),
        { concurrency: "unbounded" },
      )
      expect(summaries).toHaveLength(12)
      expect(summaries.every((value) => value === summaries[0])).toBe(true)
      expect(summaries[0]?.totals.messages).toBe(5)
      // Catalog reads are scheduled outside the SQLite permit: a cold model
      // download must never monopolize the modelProfile read lane.
      const catalogReads = pricingCatalogReads - beforeCatalogReads
      expect(catalogReads).toBeGreaterThanOrEqual(1)
      expect(catalogReads).toBeLessThanOrEqual(12)
      const cached = yield* usage.summary(request)
      expect(cached).toBe(summaries[0])
      expect(pricingCatalogReads - beforeCatalogReads).toBe(catalogReads)
    }),
  )

  it.live("evicts one cold summary at a time while retaining recently revisited windows", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      Usage.resetUsageSummaryCache()
      const request = (index: number) => {
        const since = BASE + 11_000_000 + index * 300
        return { since, until: since + 100, resolution: "hour" as const, projectID: "p1" }
      }
      const hot = yield* usage.summary(request(0))
      for (let index = 1; index < 100; index++) {
        yield* usage.summary(request(index))
      }
      // Explicitly promote the first entry before growing beyond capacity.
      expect(yield* usage.summary(request(0))).toBe(hot)
      for (let index = 100; index < 105; index++) {
        yield* usage.summary(request(index))
      }
      const catalogBefore = pricingCatalogReads
      expect(yield* usage.summary(request(0))).toBe(hot)
      expect(pricingCatalogReads).toBe(catalogBefore)
    }),
  )


  it.live("aggregates global totals, rates, and cost provenance", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day",
        projectID: null,
      })

      expect(summary.totals.messages).toBe(5)
      expect(summary.totals.sessions).toBe(3)
      expect(summary.totals.cost).toBeCloseTo(0.0051, 6)
      expect(summary.totals.estimatedCost).toBeCloseTo(0.000925, 6)
      expect(summary.totals.pricedRecords).toBe(4)
      expect(summary.totals.unpricedRecords).toBe(1)

      // Host-owned model work is accounted independently and must never alter
      // ordinary conversation totals, rates, portfolio, or activity buckets.
      expect(summary.maintenance.totals.requests).toBe(3)
      expect(summary.maintenance.totals.sessions).toBe(2)
      expect(summary.maintenance.totals.cost).toBeCloseTo(0.0012, 6)
      expect(summary.maintenance.totals.estimatedCost).toBeCloseTo(0.0003, 6)
      expect(summary.maintenance.totals.totalTokens).toBe(165)
      expect(summary.maintenance.agents.map((item) => item.agent).sort()).toEqual([
        "compaction",
        "prompt-revisor",
        "title",
      ])

      const tokens = summary.totals.tokens
      expect(tokens.input).toBe(370)
      expect(tokens.cacheRead).toBe(250)
      expect(tokens.cacheWrite).toBe(30)
      expect(tokens.output).toBe(180)
      expect(tokens.reasoning).toBe(20)

      expect(summary.totals.durationMs).toBe(23_000)
      expect(summary.totals.durationRecords).toBe(5)
      expect(summary.totals.ttftMs).toBe(700)
      expect(summary.totals.ttftRecords).toBe(2)

      // Throughput uses provider generation time (first token -> stream end)
      // when available, and only falls back to wall time for historical rows
      // that predate the streamedAt projection.
      expect(summary.rates.tokensPerSecond).toBeCloseTo(200 / 20.3, 4)
      expect(summary.rates.avgTokensPerTurn).toBeCloseTo(850 / 5, 4)
      expect(summary.rates.avgCostPerTurn).toBeCloseTo(0.006025 / 5, 6)
      expect(summary.rates.cacheHitRate).toBeCloseTo(250 / 620, 4)
      expect(summary.rates.cacheSavings).toBeCloseTo(0.00063, 6)
      expect(summary.rates.cacheSavingsCoverage).toBeCloseTo(4 / 5, 4)

      expect(summary.pricing.mode).toBe("mixed")
      expect(summary.pricing.coverage).toBeCloseTo(4 / 5, 4)

      expect(summary.mostUsedModel?.providerID).toBe("anthropic")
      expect(summary.mostUsedModel?.modelID).toBe("claude-3.5")
      expect(summary.mostUsedModel?.messages).toBe(2)
      expect(summary.mostUsedModel?.share).toBeCloseTo(0.4, 4)

      const anthropic = summary.providers.find((p) => p.providerID === "anthropic")
      expect(anthropic?.messages).toBe(2)
      expect(anthropic?.sessions).toBe(1)
      expect(anthropic?.cost).toBeCloseTo(0.005, 6)
      expect(anthropic?.tokens.input).toBe(150)
      expect(anthropic?.generationMs).toBe(17_300)
      expect(anthropic?.generationRecords).toBe(2)

      const openai = summary.providers.find((p) => p.providerID === "openai")
      expect(openai?.sessions).toBe(2)
      expect(openai?.estimatedCost).toBeCloseTo(0.000925, 6)
      expect(openai?.generationMs).toBe(2_000)
      expect(openai?.generationRecords).toBe(2)

      const mystery = summary.providers.find((p) => p.providerID === "mystery")
      expect(mystery?.unpricedRecords).toBe(1)

      const claudeDefault = summary.models.find((m) => m.modelID === "claude-3.5" && m.variant === null)
      expect(claudeDefault?.messages).toBe(1)
      const claudeHigh = summary.models.find((m) => m.modelID === "claude-3.5" && m.variant === "high")
      expect(claudeHigh?.messages).toBe(1)
      expect(claudeHigh?.cacheSavings).toBeCloseTo(0.000405, 6)
      expect(claudeHigh?.generationMs).toBe(8_700)
      expect(claudeHigh?.generationRecords).toBe(1)

      const defaultVariant = summary.variants.find((v) => v.variant === null)
      expect(defaultVariant?.messages).toBe(4)
      expect(defaultVariant?.share).toBeCloseTo(0.8, 4)
      const highVariant = summary.variants.find((v) => v.variant === "high")
      expect(highVariant?.share).toBeCloseTo(0.2, 4)

      const projA = summary.projects.find((p) => p.projectID === "p1")
      expect(projA?.name).toBe("proj-a")
      expect(projA?.sessions).toBe(2)
      expect(projA?.messages).toBe(3)
      expect(projA?.tokens).toBe(820)
      const projB = summary.projects.find((p) => p.projectID === "p2")
      expect(projB?.sessions).toBe(1)
      expect(projB?.tokens).toBe(30)
    }),
  )

  it.live("attributes messages to completion-time periods", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day",
        projectID: null,
      })
      const utcDayStart = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000
      const period1 = summary.periods.find((p) => p.start === utcDayStart(BASE))
      expect(period1?.messages).toBe(3)
      const period2 = summary.periods.find((p) => p.start === utcDayStart(BASE + 7_201_000))
      expect(period2?.messages).toBe(2)
    }),
  )

  it.live("filters by project", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day",
        projectID: "p1",
      })
      expect(summary.totals.messages).toBe(3)
      expect(summary.totals.sessions).toBe(2)
      expect(summary.projects.every((p) => p.projectID === "p1")).toBe(true)
      expect(summary.maintenance.totals.requests).toBe(2)
      expect(summary.maintenance.agents.some((item) => item.agent === "prompt-revisor")).toBe(false)
    }),
  )

  it.live("project-scoped history honors live Session reassignment over a stale tombstone", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const run = (statement: ReturnType<typeof sql>) =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.run(statement).pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.layerFromPath(dbPath)))
      try {
        yield* run(sql`UPDATE session SET project_id = 'p2' WHERE id = 's1'`)
        yield* run(sql`UPDATE usage_session SET project_id = 'p1' WHERE session_id = 's1'`)
        Usage.resetUsageSummaryCache()
        const range = { since: BASE, until: BASE + 8_002_000, resolution: "hour" as const }
        const p1 = yield* usage.summary({ ...range, projectID: "p1" })
        const p2 = yield* usage.summary({ ...range, projectID: "p2" })
        const i1 = yield* usage.inspect({ action: "totals", ...range, projectID: "p1" })
        const i2 = yield* usage.inspect({ action: "totals", ...range, projectID: "p2" })
        expect(p1.totals.messages).toBe(1)
        expect(p2.totals.messages).toBe(4)
        expect(i1.action).toBe("totals")
        expect(i2.action).toBe("totals")
        if (i1.action === "totals" && i2.action === "totals") {
          expect(i1.totals.messages).toBe(p1.totals.messages)
          expect(i2.totals.messages).toBe(p2.totals.messages)
          expect(i2.totals.sessions).toBe(p2.totals.sessions)
        }
        expect(p2.sessions.some((row) => row.sessionID === "s1")).toBe(true)
        expect(p1.sessions.some((row) => row.sessionID === "s1")).toBe(false)
      } finally {
        yield* run(sql`UPDATE session SET project_id = 'p1' WHERE id = 's1'`)
        yield* run(sql`UPDATE usage_session SET project_id = 'p1' WHERE session_id = 's1'`)
        Usage.resetUsageSummaryCache()
      }
    }),
  )

  it.live("selects the indexed project plan only for genuinely narrow ownership", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const database = Database.layerFromPath(dbPath)
      const run = (statement: ReturnType<typeof sql>) =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.run(statement).pipe(Effect.orDie)
        }).pipe(Effect.provide(database))
      const prefersIndexed = (projectID: string) =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* shouldIndexUsageProject(db, projectID)
        }).pipe(Effect.provide(database))
      expect(yield* prefersIndexed("p1")).toBe(false)
      try {
        yield* run(sql`
          WITH RECURSIVE numbers(n) AS (
            SELECT 1
            UNION ALL
            SELECT n + 1 FROM numbers WHERE n < 50
          )
          INSERT INTO usage_session (
            session_id, project_id, directory, title, project_name,
            session_created_at, session_updated_at, last_usage_at
          )
          SELECT 'usage-plan-probe-' || n, 'p-other', '/other', 'probe',
                 'Other', ${BASE}, ${BASE}, ${BASE}
          FROM numbers
        `)
        expect(yield* prefersIndexed("p1")).toBe(true)
        Usage.resetUsageSummaryCache()
        const request = { since: BASE, until: BASE + 8_002_000, projectID: "p1" }
        const summary = yield* usage.summary({ ...request, resolution: "hour" })
        const inspect = yield* usage.inspect({ ...request, action: "totals" })
        expect(inspect.action).toBe("totals")
        if (inspect.action === "totals") {
          expect(inspect.totals.messages).toBe(summary.totals.messages)
          expect(inspect.totals.sessions).toBe(summary.totals.sessions)
          expect(inspect.totals.cost).toBeCloseTo(summary.totals.cost, 8)
        }
      } finally {
        yield* run(sql`DELETE FROM usage_session WHERE session_id LIKE 'usage-plan-probe-%'`)
        Usage.resetUsageSummaryCache()
      }
      expect(yield* prefersIndexed("p1")).toBe(false)
    }),
  )

  it.live("dimension and record projection keeps one WAL snapshot across concurrent metadata edits", () =>
    Effect.gen(function* () {
      const database = Database.layerFromPath(dbPath)
      yield* Effect.gen(function* () {
        const { db, scanDb } = yield* Database.Service
        const reader = yield* scanDb()
        const request = { since: BASE, until: BASE + 8_002_000 }
        let initial = ""
        try {
          yield* reader.transaction((tx) => Effect.gen(function* () {
            const before = yield* tx.all<{ session_id: string; session_title: string }>(
              usageSummaryDimensionsQuery(request),
            ).pipe(Effect.orDie)
            initial = before.find((row) => row.session_id === "s1")?.session_title ?? ""
            expect(initial).toBe("Session 1")
            yield* db.run(sql`UPDATE session SET title = 'Concurrent rename' WHERE id = 's1'`).pipe(Effect.orDie)
            const during = yield* tx.all<{ session_id: string; session_title: string }>(
              usageSummaryDimensionsQuery(request),
            ).pipe(Effect.orDie)
            expect(during.find((row) => row.session_id === "s1")?.session_title).toBe(initial)
          }), { behavior: "deferred" }).pipe(Effect.orDie)
          const after = yield* reader.all<{ session_id: string; session_title: string }>(
            usageSummaryDimensionsQuery(request),
          ).pipe(Effect.orDie)
          expect(after.find((row) => row.session_id === "s1")?.session_title).toBe("Concurrent rename")
        } finally {
          yield* db.run(sql`UPDATE session SET title = 'Session 1' WHERE id = 's1'`).pipe(Effect.orDie)
          Usage.resetUsageSummaryCache()
        }
      }).pipe(Effect.provide(database))
    }),
  )

  it.live("compact inspection matches rich accounting without hydrating generation rows", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const range = {
        since: BASE,
        until: BASE + 8_002_000,
        projectID: null,
      }
      const summary = yield* usage.summary({ ...range, resolution: "day" })
      const totals = yield* usage.inspect({ action: "totals", ...range })

      expect(totals.action).toBe("totals")
      if (totals.action !== "totals") return
      expect(totals.totals).toEqual(summary.totals)
      expect(totals.rates.tokensPerSecond).toBeCloseTo(summary.rates.tokensPerSecond, 8)
      expect(totals.rates.avgTokensPerTurn).toBeCloseTo(summary.rates.avgTokensPerTurn, 8)
      expect(totals.rates.avgCostPerTurn).toBeCloseTo(summary.rates.avgCostPerTurn, 8)
      expect(totals.rates.cacheHitRate).toBeCloseTo(summary.rates.cacheHitRate, 8)
      expect(totals.rates.cacheSavings).toBeCloseTo(summary.rates.cacheSavings, 8)
      expect(totals.rates.cacheSavingsCoverage).toBeCloseTo(summary.rates.cacheSavingsCoverage, 8)
      expect(totals.pricing).toEqual(summary.pricing)
      expect(totals.mostUsedModel?.providerID).toBe(summary.mostUsedModel?.providerID)
      expect(totals.mostUsedModel?.modelID).toBe(summary.mostUsedModel?.modelID)
      expect(totals.mostUsedModel?.messages).toBe(summary.mostUsedModel?.messages)
      expect(totals.mostUsedModel?.cost).toBeCloseTo(summary.mostUsedModel?.cost ?? 0, 8)
      expect(totals.mostUsedModel?.share).toBeCloseTo(summary.mostUsedModel?.share ?? 0, 8)

      const models = yield* usage.inspect({
        action: "breakdown",
        ...range,
        dimension: "model",
        limit: 10,
        sort: "cost",
      })
      expect(models.action).toBe("breakdown")
      if (models.action !== "breakdown") return
      expect(models.totalRows).toBe(3)
      expect(models.truncated).toBe(false)
      const claude = models.rows.find((row) => row.key === "anthropic/claude-3.5")
      expect(claude?.messages).toBe(2)
      expect(claude?.sessions).toBe(1)
      expect(claude?.cost).toBeCloseTo(0.005, 8)
      expect(claude?.tokens).toBe(480)

      const maintenance = yield* usage.inspect({
        action: "maintenance",
        ...range,
        dimension: "agent",
        limit: 10,
      })
      expect(maintenance.action).toBe("maintenance")
      if (maintenance.action !== "maintenance") return
      expect(maintenance.totals.requests).toBe(summary.maintenance.totals.requests)
      expect(maintenance.totals.sessions).toBe(summary.maintenance.totals.sessions)
      expect(maintenance.totals.cost).toBeCloseTo(summary.maintenance.totals.cost, 8)
      expect(maintenance.totals.estimatedCost).toBeCloseTo(summary.maintenance.totals.estimatedCost, 8)
      expect(maintenance.totals.totalTokens).toBe(summary.maintenance.totals.totalTokens)
      expect(maintenance.rows.map((row) => row.key).sort()).toEqual(["compaction", "prompt-revisor", "title"])
      expect(maintenance.rows.every((row) => row.sessions === 1)).toBe(true)
    }),
  )

  it.live("compact inspection preserves project filters and bounded timelines", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const projectSummary = yield* usage.summary({
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day",
        projectID: "p1",
      })
      const projectMaintenance = yield* usage.inspect({
        action: "maintenance",
        since: BASE,
        until: BASE + 8_002_000,
        projectID: "p1",
        dimension: "agent",
        limit: 10,
      })
      expect(projectMaintenance.action).toBe("maintenance")
      if (projectMaintenance.action !== "maintenance") return
      expect(projectMaintenance.totals.requests).toBe(projectSummary.maintenance.totals.requests)
      expect(projectMaintenance.totals.sessions).toBe(projectSummary.maintenance.totals.sessions)
      expect(projectMaintenance.rows.map((row) => row.key).sort()).toEqual(["compaction", "title"])
      const filtered = yield* usage.inspect({
        action: "totals",
        since: BASE,
        until: BASE + 8_002_000,
        projectID: "p1",
      })
      expect(filtered.action).toBe("totals")
      if (filtered.action !== "totals") return
      expect(filtered.totals.messages).toBe(3)
      expect(filtered.totals.sessions).toBe(2)

      const timeline = yield* usage.inspect({
        action: "timeline",
        since: BASE,
        until: BASE + 8_002_000,
        projectID: null,
        resolution: "hour",
        metric: "messages",
        maxPoints: 2,
      })
      expect(timeline.action).toBe("timeline")
      if (timeline.action !== "timeline") return
      expect(timeline.sourcePoints).toBeGreaterThan(2)
      expect(timeline.points.length).toBeLessThanOrEqual(2)
      expect(timeline.truncated).toBe(true)
      expect(timeline.points[0]?.start).toBeLessThan(timeline.points.at(-1)?.start ?? Infinity)
    }),
  )

  it.live("compact SQL timeline preserves rich summary totals across attribution scopes", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      for (const projectID of [null, "p1", "p2"]) {
        const range = { since: BASE, until: BASE + 8_002_000, projectID }
        const rich = yield* usage.summary({ ...range, resolution: "hour" })
        const compact = yield* usage.inspect({
          action: "timeline", ...range, resolution: "hour", metric: "cost", maxPoints: 400,
        })
        expect(compact.action).toBe("timeline")
        if (compact.action !== "timeline") continue
        const points = compact.points
        expect(compact.truncated).toBe(false)
        expect(points.map((row) => row.start)).toEqual(rich.periods.map((row) => row.start))
        const sum = (get: (row: (typeof points)[number]) => number) =>
          points.reduce((total, row) => total + get(row), 0)
        expect(sum((row) => row.messages)).toBe(rich.totals.messages)
        expect(sum((row) => row.cost)).toBeCloseTo(rich.totals.cost, 8)
        expect(sum((row) => row.estimatedCost)).toBeCloseTo(rich.totals.estimatedCost, 8)
        const tokens = rich.totals.tokens
        expect(sum((row) => row.tokens))
          .toBe(tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning)
      }
    }),
  )

  it.live("excludes messages outside the window", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE + 3_000_000,
        until: BASE + 3_700_000,
        resolution: "hour",
        projectID: null,
      })
      expect(summary.totals.messages).toBe(1)
      expect(summary.totals.estimatedCost).toBeCloseTo(0.000925, 6)
    }),
  )

  it.live("dow and hours total the window messages", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day",
        projectID: null,
      })
      const dowMessages = summary.dow.reduce((total, bucket) => total + bucket.messages, 0)
      const hourMessages = summary.hours.reduce((total, bucket) => total + bucket.messages, 0)
      expect(dowMessages).toBe(5)
      expect(hourMessages).toBe(5)
      expect(summary.dow.length).toBe(7)
      expect(summary.hours.length).toBe(24)
    }),
  )

  it.live("keeps the complete Usage projection unchanged after a live Session is deleted", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const request = {
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day" as const,
        projectID: null,
      }

      // Metadata may change after the final model response. The live Usage
      // projection should see it now, and the delete trigger must preserve the
      // exact same attribution once the Session row is gone.
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(sql`
          UPDATE session
          SET title = 'Session 1 renamed', time_updated = ${BASE + 9_000_000}
          WHERE id = 's1'
        `).pipe(Effect.orDie)
        yield* db.run(sql`UPDATE project SET name = 'proj-a-renamed' WHERE id = 'p1'`).pipe(Effect.orDie)
      }).pipe(Effect.provide(Database.layerFromPath(dbPath)))
      Usage.resetUsageSummaryCache()

      const before = yield* usage.summary(request)
      const scopedBefore = yield* usage.summary({ ...request, projectID: "p1" })
      const compactBefore = yield* usage.inspect({ action: "totals", since: request.since, until: request.until, projectID: "p1" })
      const rowsBefore = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db
          .all<{ count: number }>(sql`SELECT COUNT(*) AS count FROM usage_record WHERE session_id = 's1'`)
          .pipe(Effect.orDie)
      }).pipe(Effect.provide(Database.layerFromPath(dbPath)))

      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(sql`DELETE FROM session WHERE id = 's1'`).pipe(Effect.orDie)
      }).pipe(Effect.provide(Database.layerFromPath(dbPath)))
      Usage.resetUsageSummaryCache()

      const after = yield* usage.summary(request)
      const scopedAfter = yield* usage.summary({ ...request, projectID: "p1" })
      const compactAfter = yield* usage.inspect({ action: "totals", since: request.since, until: request.until, projectID: "p1" })
      const postDelete = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const rows = yield* db
          .all<{ count: number }>(sql`SELECT COUNT(*) AS count FROM usage_record WHERE session_id = 's1'`)
          .pipe(Effect.orDie)
        const dimension = yield* db
          .all<{
            projectID: string
            title: string
            projectName: string | null
            lastUsageAt: number
          }>(sql`
            SELECT
              project_id AS projectID,
              title,
              project_name AS projectName,
              last_usage_at AS lastUsageAt
            FROM usage_session
            WHERE session_id = 's1'
          `)
          .pipe(Effect.orDie)
        return { rows, dimension }
      }).pipe(Effect.provide(Database.layerFromPath(dbPath)))

      expect(rowsBefore[0]?.count).toBeGreaterThan(0)
      expect(postDelete.rows).toEqual(rowsBefore)
      expect(postDelete.dimension).toEqual([
        {
          projectID: "p1",
          title: "Session 1 renamed",
          projectName: "proj-a-renamed",
          lastUsageAt: BASE + 92_000,
        },
      ])
      expect(after).toEqual(before)
      expect(scopedAfter).toEqual(scopedBefore)
      expect(compactAfter).toEqual(compactBefore)
    }),
  )

  it.live("counts pre-migration orphaned Usage rows through the historical fallback", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const orphan: SeedMessage = {
        id: "m-pre-migration-orphan",
        sessionID: "s-pre-migration-deleted",
        providerID: "openai",
        modelID: "gpt-4o",
        created: BASE + 8_001_200,
        completed: BASE + 8_001_500,
        cost: 0.0002,
        tokens: { input: 7, cacheRead: 0, cacheWrite: 0, output: 3, reasoning: 0 },
      }

      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedUsageRecord(db, orphan)
      }).pipe(Effect.provide(Database.layerFromPath(dbPath)))
      Usage.resetUsageSummaryCache()

      const summary = yield* usage.summary({
        since: BASE + 8_001_100,
        until: BASE + 8_001_900,
        resolution: "hour",
        projectID: null,
      })

      expect(summary.totals.messages).toBe(1)
      expect(summary.totals.sessions).toBe(1)
      expect(summary.projects).toEqual([
        {
          projectID: "__historical__",
          name: "Historical usage",
          sessions: 1,
          messages: 1,
          cost: 0.0002,
          tokens: 10,
        },
      ])
    }),
  )

  it.live("keeps nullable and empty-string model variants distinct in the rich and SQL portfolio", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const start = BASE + 20_000_000
      const database = Database.layerFromPath(dbPath)
      const run = (statement: ReturnType<typeof sql>) => Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(statement).pipe(Effect.orDie)
      }).pipe(Effect.provide(database))
      try {
        yield* run(sql`
          INSERT INTO usage_record (
            message_id, session_id, provider_id, model_id, variant, agent,
            mode, created_at, completed_at, cost_usd, input_tokens,
            cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
          ) VALUES
          ('variant-identity-null','s1','anthropic','claude-3.5',NULL,'build','primary',
           ${start},${start + 100},0,10,0,0,2,0),
          ('variant-identity-empty','s1','anthropic','claude-3.5','','build','primary',
           ${start},${start + 200},0,10,0,0,2,0)
        `)
        Usage.resetUsageSummaryCache()
        const request = { since: start, until: start + 1_000, resolution: "hour" as const, projectID: "p1" }
        const rich = yield* usage.summary(request)
        expect(rich.totals.messages).toBe(2)
        expect(rich.models).toHaveLength(2)
        expect(rich.models.map(model => model.variant)).toEqual([null, ""])
        expect(rich.variants.map(variant => variant.variant)).toEqual([null, ""])
        expect(rich.modelSeries[0]?.messages.reduce((sum, count) => sum + count, 0)).toBe(2)
        const projected = yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db.transaction((tx) => queryPortfolio(tx, request, false), { behavior: "deferred" }).pipe(Effect.orDie)
        }).pipe(Effect.provide(database))
        const portfolio = valuePortfolio(projected.groups, projected.providerSessions, buildRates(CATALOG))
        expect(portfolio.models.map(model => model.variant)).toEqual(rich.models.map(model => model.variant))
        expect(portfolio.models.map(model => model.messages)).toEqual([1, 1])
      } finally {
        yield* run(sql`DELETE FROM usage_record WHERE message_id LIKE 'variant-identity-%'`)
        Usage.resetUsageSummaryCache()
      }
    }),
  )

  it.live("returns exact all-window activity when the heatmap is capped to 500 days", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const origin = 1_600_000_000_000
      const dayMS = 86_400_000
      const database = Database.layerFromPath(dbPath)
      const run = (statement: ReturnType<typeof sql>) => Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(statement).pipe(Effect.orDie)
      }).pipe(Effect.provide(database))
      try {
        yield* run(sql`
          WITH RECURSIVE dates(n) AS (
            SELECT 0 UNION ALL SELECT n+1 FROM dates WHERE n < 619
          )
          INSERT INTO usage_record (
            message_id, session_id, provider_id, model_id, variant, agent,
            mode, created_at, completed_at, cost_usd,
            input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
          )
          SELECT 'activity-window-' || n, 's1', 'anthropic', 'claude-3.5',
                 NULL, 'build', 'primary',
                 ${origin} + n*${dayMS}, ${origin} + n*${dayMS} + 1000,
                 0, 1, 0, 0, 1, 0
          FROM dates
        `)
        yield* run(sql`
          INSERT INTO usage_record (
            message_id, session_id, provider_id, model_id, variant, agent,
            mode, created_at, completed_at, cost_usd,
            input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
          ) VALUES
          ('activity-peak-extra-a', 's1', 'anthropic', 'claude-3.5', NULL, 'build',
            'primary', ${origin + 40 * dayMS}, ${origin + 40 * dayMS + 1500}, 0, 1, 0, 0, 1, 0),
          ('activity-peak-extra-b', 's1', 'anthropic', 'claude-3.5', NULL, 'build',
            'primary', ${origin + 40 * dayMS}, ${origin + 40 * dayMS + 2000}, 0, 1, 0, 0, 1, 0)
        `)
        Usage.resetUsageSummaryCache()
        const summary = yield* usage.summary({
          since: origin - 1000, until: origin + 620 * dayMS, resolution: "day", projectID: "p1",
        })
        expect(summary.days).toHaveLength(500)
        expect(summary.totals.messages).toBe(622)
        expect(summary.activity.activeDays).toBe(620)
        expect(summary.activity.longestStreak).toBe(620)
        expect(summary.activity.busiestDay?.messages).toBe(3)
        expect(summary.activity.busiestDay?.start).toBeLessThan(summary.days[0]!.start)
      } finally {
        yield* run(sql`DELETE FROM usage_record WHERE message_id LIKE 'activity-window-%' OR message_id LIKE 'activity-peak-extra-%'`)
        Usage.resetUsageSummaryCache()
      }
    }),
  )

  it.live("global dimension projection and keyset pages preserve duplicate timestamp boundaries", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const database = Database.layerFromPath(dbPath)
      const run = (statement: ReturnType<typeof sql>) => Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(statement).pipe(Effect.orDie)
      }).pipe(Effect.provide(database))
      try {
        // All 4,105 rows share the exact completion millisecond. Paging by
        // completed_at alone would lose everything after the 4,096th row.
        yield* run(sql`
          WITH RECURSIVE n(i) AS (
            SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4105
          )
          INSERT INTO usage_record (
            message_id, session_id, provider_id, model_id, variant, agent,
            mode, created_at, completed_at, cost_usd,
            input_tokens, cache_read_tokens, cache_write_tokens,
            output_tokens, reasoning_tokens
          )
          SELECT 'paging-parity-' || i, 's1', 'anthropic', 'claude-3.5',
                 CASE WHEN i % 2 = 0 THEN 'high' ELSE NULL END, 'build',
                 'primary', ${BASE + 8_000_000}, ${BASE + 8_000_900},
                 CASE WHEN i % 3 = 0 THEN NULL ELSE 0.00002 END,
                  11, 3, 2, 5, 1 FROM n
        `)
        const collected = yield* Effect.gen(function* () {
          const { readDb, db } = yield* Database.Service
          const range = { since: BASE, until: BASE + 8_002_000 }
          const pages = yield* readDb.transaction((tx) => Effect.gen(function* () {
            const ids: string[] = []
            let after: { completedAt: number; rowID: number } | null = null
            for (;;) {
              const rows: Array<{ id: string; completed_ms: number; cursor_id: number }> = yield* tx.all<{ id: string; completed_ms: number; cursor_id: number }>(
                usageSummaryRawRowsQuery(range, { limit: 4096, after }),
              ).pipe(Effect.orDie)
              ids.push(...rows.map((row) => row.id))
              if (rows.length < 4096) break
              const last = rows.at(-1)!
              after = { completedAt: last.completed_ms, rowID: last.cursor_id }
            }
            return ids
          }), { behavior: "deferred" }).pipe(Effect.orDie)
          const reference = yield* db.all<{ id: string }>(sql`
            SELECT message_id AS id FROM usage_record
            WHERE completed_at >= ${BASE} AND completed_at < ${BASE + 8_002_000}
            ORDER BY completed_at ASC, rowid ASC
          `).pipe(Effect.orDie)
          return { pages, reference }
        }).pipe(Effect.provide(database))
        expect(collected.pages).toEqual(collected.reference.map((row) => row.id))
        Usage.resetUsageSummaryCache()
        for (const projectID of [null, "p1"]) {
          const range = { until: BASE + 8_002_000, resolution: "hour" as const, projectID }
          // Exact full-response parity between all-time and fixed-window
          // dimension projections, independent of keyset pagination above.
          const paged = yield* usage.summary({ ...range, since: 0 })
          const single = yield* usage.summary({ ...range, since: BASE })
          expect(paged.totals.messages).toBeGreaterThan(4096)
          expect({ ...paged, since: BASE }).toEqual(single)
          const projection = yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            return yield* db.transaction((tx) => queryPortfolio(tx, { ...range, since: BASE }, false), { behavior: "deferred" }).pipe(Effect.orDie)
          }).pipe(Effect.provide(database))
          const sqlPortfolio = valuePortfolio(projection.groups, projection.providerSessions, buildRates(CATALOG))
          for (const [i, item] of single.models.entries()) {
            const matched = sqlPortfolio.models.find(row => row.modelID === item.modelID && row.providerID === item.providerID && row.variant === item.variant)
            expect(matched).toBeDefined()
            expect(matched?.messages).toBe(item.messages)
            expect(matched?.unpricedRecords).toBe(item.unpricedRecords)
            expect(matched?.cost).toBeCloseTo(item.cost, 7)
            expect(matched?.estimatedCost).toBeCloseTo(item.estimatedCost, 7)
          }
        }
      } finally {
        yield* run(sql`DELETE FROM usage_record WHERE message_id LIKE 'paging-parity-%'`)
        Usage.resetUsageSummaryCache()
      }
    }),
  )
})
