import { describe, expect, test } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { Deferred, Effect, Fiber, Layer, Semaphore } from "effect"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Database, checkpointWal, optimizePlannerStats } from "../../src/database/database"
import { makeLeasedReaderPool } from "../../src/database/scan-read-pool"
import { SqliteScanProcessClient } from "../../src/database/sqlite-scan-process"
import { makeSqlitePermitTracker } from "../../src/database/sqlite-permit-tracker"
import { sqliteQueryOrigin } from "../../src/database/sqlite-query-origin"
import { sqliteFingerprint, sqlitePlanProbeFingerprint } from "../../src/database/sqlite-query-forensics"
import { layer as scanWorkerLayer } from "../../src/database/sqlite.bun-worker"
import { layer as sqliteNodeLayer } from "../../src/database/sqlite.node"
import { SessionSearch } from "../../src/session/search"
import { SessionRecall } from "../../src/session/recall"

/**
 * Lane D read-side attribution evidence, 2026-10-11.
 *
 * Historical fingerprints c2b111a6 (len 1065) and 0bbba6a9 (len 1001) are
 * correlation hints, never authenticated SQL. Nothing here fabricates a query
 * and labels it with a historical hash: the plan-probe protocol test uses its
 * own synthetic tag, and the production-SQL test proves only that current read
 * statements are NOT those two templates (candidate matching, not reversal).
 */

// A real, fully-native recursive ladder. Only a number is interpolated; this is
// a test-owned workload, not a reproduction of any incident SQL.
const ladder = (n: number) =>
  `WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r WHERE x < ${n}) SELECT sum(x) AS total FROM r`

const fixture = async (label: string) => {
  const dir = await mkdtemp(join(tmpdir(), `openfork-lane-d-${label}-`))
  return { dir, file: join(dir, "probe.sqlite") }
}

const cleanup = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 70 })

const waitUntil = (predicate: () => boolean, timeoutMs: number) =>
  Effect.gen(function* () {
    const started = Date.now()
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) return yield* Effect.die(new Error("condition was not observed before timeout"))
      yield* Effect.sleep("20 millis")
    }
  })

const request = (client: SqliteScanProcessClient, text: string) =>
  client.request({ kind: "query", query: text, params: [], arrays: false, safeIntegers: false }) as Promise<
    Array<Record<string, number>>
  >

describe("lane D: real-worker read attribution", () => {
  test("a real scan worker records fiber origin, shape and hash for a slow statement, never SQL text", async () => {
    const { dir, file } = await fixture("attribution")
    const seed = new BunSqlite(file)
    seed.exec("CREATE TABLE slow_probe(secret_value INTEGER NOT NULL); INSERT INTO slow_probe VALUES (7)")
    seed.close()
    const slowWarnings: string[] = []
    const contentions: string[] = []
    const client = new SqliteScanProcessClient({
      filename: file,
      permitLane: "scan-pool",
      readonly: true,
      checkpointOnClose: false,
      disableWAL: true,
      queryTimeoutMs: 5_000,
    })
    try {
      await client.ready
      const ladderQuery = ladder(2_000_000)
      await Effect.runPromise(Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(1)
        const tracker = makeSqlitePermitTracker(semaphore, 30_000, "scan-pool", {
          worker: () => client.activitySnapshot(),
          slowWarningMs: 50,
          slowWarn: (snapshot) => Effect.sync(() => { slowWarnings.push(snapshot) }),
          firstWarningMs: 40,
          warn: (snapshot) => Effect.sync(() => { contentions.push(snapshot) }),
        })
        const read = (text: string) =>
          Effect.fn("Search.sessions")(function* () {
            return yield* Effect.withFiber<Array<Record<string, unknown>>, Error>((fiber) => {
              const end = tracker.statement(text, sqliteQueryOrigin(fiber.context))
              return Effect.tryPromise({
                try: () =>
                  client.request({ kind: "query", query: text, params: [], arrays: false, safeIntegers: false }) as Promise<
                    Array<Record<string, unknown>>
                  >,
                catch: (cause) => cause as Error,
              }).pipe(Effect.ensuring(Effect.sync(end)))
            })
          })()

        // Owner holds the connection permit while the real native statement is
        // executing in the isolated scanner process.
        const owner = yield* Effect.acquireUseRelease(
          tracker.take,
          () => read(ladderQuery),
          () => tracker.release,
        ).pipe(Effect.forkChild)
        yield* waitUntil(() => client.activitySnapshot().includes("processStage=executing"), 3_000)
        const queued = yield* tracker.take.pipe(Effect.forkChild)
        // Let the contention watcher publish while the slow statement still runs.
        yield* Effect.sleep("160 millis")
        yield* Fiber.interrupt(queued)
        const rows = yield* Fiber.join(owner)
        expect(Number(rows[0]?.total)).toBe((2_000_000 * 2_000_001) / 2)

        const contention = contentions.join("\n")
        expect(contention).toContain("pending=1")
        expect(contention).toContain("sqlOrigin=Search.sessions")
        expect(contention).toContain(`sqlHash=${sqliteFingerprint(ladderQuery)}`)
        expect(contention).toContain(`sqlLen=${ladderQuery.length}`)
        expect(contention).toContain("processStage=executing")

        yield* waitUntil(() => slowWarnings.length > 0, 3_000)
        const slow = slowWarnings.join("\n")
        expect(slow).toContain("sqlOrigin=Search.sessions")
        expect(slow).toContain(`sqlHash=${sqliteFingerprint(ladderQuery)}`)
        expect(slow).toContain(`sqlLen=${ladderQuery.length}`)
        expect(slow).toContain("sqlShape=")
        // Attribution must never carry SQL text, table names, or values.
        expect(slow).not.toContain("RECURSIVE")
        expect(slow).not.toContain("slow_probe")
        expect(slow).not.toContain("secret_value")
      }))
    } finally {
      await client.close()
      await cleanup(dir)
    }
  }, 25_000)

  test("a safe plan summary uses its own synthetic tag and drops identifiers and literals", async () => {
    const { dir, file } = await fixture("plan-probe")
    const seed = new BunSqlite(file)
    seed.exec("CREATE TABLE private_probe_table(secret_value TEXT NOT NULL)")
    seed.exec("CREATE INDEX private_probe_index ON private_probe_table(secret_value)")
    seed.exec("INSERT INTO private_probe_table VALUES ('classified-literal')")
    seed.close()
    const diagnostics: unknown[] = []
    const client = new SqliteScanProcessClient(
      { filename: file, permitLane: "scan", readonly: true, checkpointOnClose: false, disableWAL: true, queryTimeoutMs: 3_000 },
      (plan) => diagnostics.push(plan),
    )
    try {
      await client.ready
      const tag = "synthetic-lane-d-plan-tag"
      const sql = "SELECT secret_value FROM private_probe_table WHERE secret_value = ?"
      const first = await client.request({
        kind: "query",
        query: sql,
        params: ["classified-literal"],
        arrays: false,
        safeIntegers: false,
        diagnosePlan: tag,
      })
      expect(first).toEqual([{ secret_value: "classified-literal" }])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({ hash: tag, status: "ok", searches: 1 })
      // Repeating the shape must not spam diagnostics.
      await client.request({
        kind: "query",
        query: sql,
        params: ["classified-literal"],
        arrays: false,
        safeIntegers: false,
        diagnosePlan: tag,
      })
      expect(diagnostics).toHaveLength(1)
      const serialized = JSON.stringify(diagnostics)
      expect(serialized).not.toContain("private_probe_table")
      expect(serialized).not.toContain("private_probe_index")
      expect(serialized).not.toContain("secret_value")
      expect(serialized).not.toContain("classified-literal")
    } finally {
      await client.close()
      await cleanup(dir)
    }
  }, 20_000)
})

describe("lane D: production read SQL is not an incident template", () => {
  test("every rendered SessionSearch/SessionRecall read statement is distinct from both fingerprint templates", async () => {
    const dialect = new SQLiteSyncDialect()
    const captured: Array<{ sql: string; params: unknown[] }> = []
    const chain = {
      from: () => chain,
      where: () => chain,
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed([]),
    }
    const db = {
      all(command: Parameters<typeof dialect.sqlToQuery>[0]) {
        captured.push(dialect.sqlToQuery(command))
        return Effect.succeed([])
      },
      select: () => chain,
    }
    for (const ranking of ["recent", "relevance"] as const) {
      await Effect.runPromise(SessionSearch.search(db as never, {
        query: "needle",
        directoryPrefixes: ["/approved/one", "/approved/two"],
        includeArchived: false,
        ranking,
        limit: 10,
      }))
      await Effect.runPromise(SessionRecall.recall(db as never, {
        query: "needle",
        tool: "read",
        directoryPrefixes: ["/approved/one", "/approved/two"],
        includeArchived: false,
        ranking,
        limit: 10,
      }))
      await Effect.runPromise(SessionRecall.recall(db as never, {
        tool: "read",
        directory: "/approved/one",
        ranking,
        limit: 10,
      }))
      await Effect.runPromise(SessionRecall.recall(db as never, { tool: "read", ranking, limit: 10 }))
    }
    expect(captured.length).toBeGreaterThanOrEqual(12)
    for (const statement of captured) {
      // Candidate matching only: a length+hash match would identify a real
      // recurrence. No synthetic query is ever tagged as a historical hash.
      expect(sqlitePlanProbeFingerprint(statement.sql)).toBeUndefined()
    }
  }, 15_000)
})

describe("lane D: legitimate large reads and the killable deadline", () => {
  test("a paged real read outlives the per-statement deadline, two readers stay independent, admission stays bounded, and a runaway recovers", async () => {
    const { dir, file } = await fixture("pool")
    const seed = new BunSqlite(file)
    seed.exec("CREATE TABLE pooled_probe(v INTEGER NOT NULL); INSERT INTO pooled_probe VALUES (11); PRAGMA journal_mode=WAL")
    seed.close()
    try {
      await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          // The connection lifetime must outlive each individual open call, as
          // in database.ts: attaching Layer.build to the enclosing test scope
          // (not the open callback) is what keeps a warmed reader usable.
          const lifetime = yield* Effect.scope
          const openLease = (slot: number) =>
            Effect.gen(function* () {
              const context = yield* Layer.buildWithScope(
                scanWorkerLayer({
                  filename: file,
                  permitLane: "scan-pool",
                  readonly: true,
                  disableWAL: true,
                  checkpointOnClose: false,
                  queryTimeoutMs: 800,
                }),
                lifetime,
              )
              const reader = yield* EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.provide(context))
              return { slot, reader }
            })
          const pool = yield* makeLeasedReaderPool(2, openLease, 120)
          // Five paged statements separated by explicit gaps. The callback
          // deterministically outlives one statement budget because the gaps
          // are scheduled (a floor, not CPU-speed dependent); every individual
          // statement stays inside the same 800ms budget.
          const perStatementBudgetMs = 800
          const pageGapMs = 250
          const pagedStarted = performance.now()
          const paged = yield* pool.withLease((lease) =>
            Effect.gen(function* () {
              let total = 0
              for (let page = 0; page < 5; page++) {
                if (page > 0) yield* Effect.sleep(`${pageGapMs} millis`)
                const row = yield* lease.reader.get<{ total: number }>(ladder(1_000_000)).pipe(Effect.orDie)
                total += Number(row?.total ?? 0)
              }
              return total
            }),
          )
          const pagedMs = performance.now() - pagedStarted
          expect(paged).toBe((5 * (1_000_000 * 1_000_001)) / 2)
          expect(4 * pageGapMs).toBeGreaterThanOrEqual(perStatementBudgetMs)
          expect(pagedMs).toBeGreaterThanOrEqual(4 * pageGapMs)

          // Two real readers: a pinned long read on one slot must not block a
          // second lease, and a third queued admission must fail bounded rather
          // than accumulate behind two genuinely held leases.
          const pinnedStarted = yield* Deferred.make<void>()
          const releasePinned = yield* Deferred.make<void>()
          const pinned = yield* pool.withLease((lease) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(pinnedStarted, undefined)
              const row = yield* lease.reader.get<{ total: number }>(ladder(3_000_000)).pipe(Effect.orDie)
              // Keep the lease, not just the statement: slot fairness is what
              // the third admission exercises.
              yield* Deferred.await(releasePinned)
              return Number(row?.total ?? 0)
            }),
          ).pipe(Effect.forkChild)
          yield* Deferred.await(pinnedStarted)
          yield* Effect.sleep("50 millis")
          const secondStarted = performance.now()
          const second = yield* pool.withLease((lease) =>
            lease.reader.get<{ v: number }>("SELECT v FROM pooled_probe").pipe(Effect.orDie),
          )
          expect(second).toEqual({ v: 11 })
          expect(performance.now() - secondStarted).toBeLessThan(600)
          const secondPinnedStarted = yield* Deferred.make<void>()
          const releaseSecondPinned = yield* Deferred.make<void>()
          const secondPinned = yield* pool.withLease((lease) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(secondPinnedStarted, undefined)
              yield* Deferred.await(releaseSecondPinned)
              return lease.slot
            }),
          ).pipe(Effect.forkChild)
          yield* Deferred.await(secondPinnedStarted)
          const thirdStarted = performance.now()
          const third = yield* pool.withLease((lease) =>
            lease.reader.get<{ v: number }>("SELECT v FROM pooled_probe").pipe(Effect.orDie),
          ).pipe(Effect.exit)
          expect(third._tag).toBe("Failure")
          expect(performance.now() - thirdStarted).toBeLessThan(1_500)
          yield* Deferred.succeed(releasePinned, undefined)
          yield* Deferred.succeed(releaseSecondPinned, undefined)
          expect(yield* Fiber.join(pinned)).toBe((3_000_000 * 3_000_001) / 2)
          expect(yield* Fiber.join(secondPinned)).toBeGreaterThanOrEqual(0)

          // A runaway statement is killed at its own deadline; the same pool
          // recovers on the next lease instead of leaking the locked slot.
          const runaway = yield* pool.withLease((lease) =>
            lease.reader.get(ladder(20_000_000)).pipe(Effect.orDie),
          ).pipe(Effect.exit)
          expect(runaway._tag).toBe("Failure")
          const recovered = yield* pool.withLease((lease) =>
            lease.reader.get<{ v: number }>("SELECT v FROM pooled_probe").pipe(Effect.orDie),
          )
          expect(recovered).toEqual({ v: 11 })
        }),
      ))
    } finally {
      await cleanup(dir)
    }
  }, 40_000)

  test("planner/checkpoint maintenance stays bounded and never blocks behind a held foreground writer", async () => {
    const { dir, file } = await fixture("maintenance")
    try {
      await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.run("CREATE TABLE maintenance_probe(v INTEGER NOT NULL)").pipe(Effect.orDie)
          // The writer reservation is released by a finalizer even when an
          // assertion fails, so no leaked transaction can outlive the test.
          let committed = false
          yield* Effect.acquireUseRelease(
            db.run("BEGIN IMMEDIATE").pipe(Effect.orDie),
            () => Effect.gen(function* () {
              yield* db.run("INSERT INTO maintenance_probe VALUES (1)").pipe(Effect.orDie)
              const started = performance.now()
              yield* optimizePlannerStats(file).pipe(Effect.exit)
              const optimizeMs = performance.now() - started
              yield* checkpointWal(file).pipe(Effect.exit)
              const checkpointMs = performance.now() - started - optimizeMs
              // Neither call may queue on the foreground connection permit
              // while the primary transaction is open.
              expect(optimizeMs).toBeLessThan(3_000)
              expect(checkpointMs).toBeLessThan(3_000)
              yield* db.run("COMMIT").pipe(Effect.orDie)
              committed = true
            }),
            () => committed ? Effect.void : db.run("ROLLBACK").pipe(Effect.ignore),
          )
          const row = yield* db.get<{ n: number }>("SELECT count(*) AS n FROM maintenance_probe").pipe(Effect.orDie)
          expect(Number(row?.n)).toBe(1)
          // After the writer releases, the same maintenance call still works.
          yield* optimizePlannerStats(file).pipe(Effect.orDie)
        }),
      ).pipe(Effect.provide(Database.layerFromPath(file))))
    } finally {
      await cleanup(dir)
    }
  }, 30_000)

  test("Node source adapter: a real runaway read is killed at its deadline and the next read recovers", async () => {
    const { dir, file } = await fixture("node-scan")
    const seed = new BunSqlite(file)
    seed.exec("CREATE TABLE witness(value INTEGER NOT NULL); INSERT INTO witness VALUES (42)")
    seed.close()
    try {
      await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* EffectDrizzleSqlite.makeWithDefaults()
          expect(yield* reader.get<{ value: number }>("SELECT value FROM witness")).toEqual({ value: 42 })
          const started = performance.now()
          const timed = yield* Effect.exit(reader.get(ladder(20_000_000)))
          expect(timed._tag).toBe("Failure")
          expect(performance.now() - started).toBeLessThan(2_500)
          expect(yield* reader.get<{ value: number }>("SELECT value FROM witness")).toEqual({ value: 42 })
        }).pipe(
          // The layer must own the whole scoped fixture; providing it to the
          // service constructor alone would close the connection immediately.
          Effect.provide(sqliteNodeLayer({
            filename: file,
            readonly: true,
            permitLane: "scan",
            disableWAL: true,
            checkpointOnClose: false,
            queryTimeoutMs: 400,
          })),
        ),
      ))
    } finally {
      await cleanup(dir)
    }
  }, 20_000)
})
