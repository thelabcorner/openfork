import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import type { DatabaseShape } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { UsageHistoryWatermark } from "@opencode-ai/core/usage/history-watermark"
import { UsageRecord } from "@opencode-ai/core/usage/record"
import { UsageYield } from "@opencode-ai/core/usage/yield"
import { observeYieldStatistic, statisticalKeyID } from "@opencode-ai/core/usage/yield-statistics"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const tmp = await tmpdir()
const databasePath = path.join(tmp.path, "usage-history-watermark.sqlite")

// File-backed on purpose. Cross-process visibility is the whole point: an
// in-memory database has no second connection and therefore no external signal.
const graph = (filename: string) =>
  AppNodeBuilder.build(LayerNode.group([Database.node, UsageYield.node, UsageRecord.node]), [
    [Database.node, Database.layerFromPath(filename)],
  ])

const it = testEffect(graph(databasePath))

// The Usage service also runs inside ACP/Desktop hosts that share this exact
// database file, so keep the backing temporary database alive for the whole
// module rather than disposing it when test registration finishes. A failing test
// can leave native SQLite handles mapped past scope close, which makes the
// fixture's directory removal and lock release fail; cleanup must never turn
// that into a second, misleading failure on top of the real assertion.
afterAll(async () => {
  await tmp[Symbol.asyncDispose]().catch(() => {})
})

const key = { providerID: "opencode-go", baseModelID: "deepseek-v4.1-flash" } as const

const stateFor = (input: number) =>
  JSON.stringify(
    observeYieldStatistic(undefined, {
      sessionID: "ses-watermark",
      completedAt: 1_000,
      tokens: { input, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    }),
  )

/**
 * A commit made by some OTHER connection to the same database file.
 *
 * This is exactly what SQLite's cross-connection commit counter reports and
 * what a second OpenFork host (Desktop sidecar plus ACP) produces. It is routed
 * through a raw connection rather than `UsageRecord`/`UsageYield` on purpose:
 * the external writer must move only SQLite's commit counter and leave this
 * process's own usage revision untouched.
 */
const commitExternally = (statKey: string, input: number) =>
  Database.withBackfillDb(databasePath, (conn) =>
    conn
      .run(sql`
        INSERT OR REPLACE INTO usage_yield_stat
          (stat_key, provider_id, base_model_id, account_id, state, updated_at)
        VALUES (${statKey}, ${key.providerID}, ${key.baseModelID}, NULL, ${stateFor(input)}, ${1_000})
      `)
      .pipe(Effect.orDie),
  ).pipe(Effect.orDie)

describe("UsageHistoryWatermark", () => {
  it.live("treats an unchanged watermark as 'no local settlement and no other connection's commit'", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const watermark = UsageHistoryWatermark.make(database.db)

      const first = yield* watermark
      const second = yield* watermark

      expect(UsageHistoryWatermark.same(first, second)).toBe(true)
      expect(UsageHistoryWatermark.same(first, { ...first, localRevision: first.localRevision + 1 })).toBe(false)
      expect(
        UsageHistoryWatermark.same(first, {
          ...first,
          externalDataVersion: first.externalDataVersion + 1,
        }),
      ).toBe(false)
    }),
  )

  it.live("keeps the external signal fixed across this connection's own commit", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const before = yield* UsageHistoryWatermark.make(database.db)

      yield* database.db
        .run(sql`INSERT OR REPLACE INTO usage_yield_meta (id, version, rebuilt_at, source_rows) VALUES ('probe', 1, 0, 0)`)
        .pipe(Effect.orDie)
      yield* database.db.run(sql`DELETE FROM usage_yield_meta WHERE id = 'probe'`).pipe(Effect.orDie)

      const after = yield* UsageHistoryWatermark.make(database.db)
      // PRAGMA data_version deliberately ignores this connection's own commits,
      // which is why the local revision exists rather than being redundant.
      expect(after.externalDataVersion).toBe(before.externalDataVersion)
    }),
  )

  it.live("advances the local revision for a settled generation recorded in this process", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service
      const before = yield* UsageHistoryWatermark.make(database.db)

      yield* usage.record({
        messageID: "msg_watermark_local",
        sessionID: "ses_watermark",
        providerID: key.providerID,
        modelID: key.baseModelID,
        completedAt: 1_000,
        tokens: { input: 400, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      })

      const after = yield* UsageHistoryWatermark.make(database.db)
      expect(after.localRevision).toBeGreaterThan(before.localRevision)
    }),
  )

  it.live("advances the local revision when UsageYield rewrites its projection", () =>
    Effect.gen(function* () {
      const usageYield = yield* UsageYield.Service
      const database = yield* Database.Service
      const before = yield* UsageHistoryWatermark.make(database.db)

      yield* usageYield.rebuild()

      const after = yield* UsageHistoryWatermark.make(database.db)
      expect(after.localRevision).toBeGreaterThan(before.localRevision)
    }),
  )

  it.live("re-reads the memoized projection after another connection commits", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const usageYield = yield* UsageYield.Service
      const cached = UsageHistoryWatermark.cached(
        Effect.suspend(() => usageYield.list()),
        UsageHistoryWatermark.make(database.db),
      )

      const before = yield* cached()
      const statKey = statisticalKeyID(key)

      // No writer, so the memo is served without touching durable state. Object
      // identity is the proof: a recompute would allocate a new memo.
      expect(yield* cached()).toBe(before)

      // A different connection commits while this process is idle. There is no
      // local settlement, no local revision change, and no in-process event.
      yield* commitExternally(statKey, 400)

      const after = yield* cached()
      expect(after).not.toBe(before)
      expect(UsageHistoryWatermark.same(after.watermark, before.watermark)).toBe(false)
      expect(after.value.map((entry) => entry.key.baseModelID)).toContain(key.baseModelID)
      expect(after.watermark.externalDataVersion).toBeGreaterThan(before.watermark.externalDataVersion)
    }),
  )

  it.live("keeps serving the memo while no other connection has committed", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const usageYield = yield* UsageYield.Service
      const cached = UsageHistoryWatermark.cached(
        Effect.suspend(() => usageYield.list()),
        UsageHistoryWatermark.make(database.db),
      )

      const first = yield* cached()
      const second = yield* cached()
      const third = yield* cached()

      expect(second).toBe(first)
      expect(third).toBe(first)
    }),
  )

  it.live("collapses concurrent cold and invalidated reads into one projection read", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      let reads = 0
      const cached = UsageHistoryWatermark.cached(
        Effect.suspend(() =>
          Effect.flatMap(Effect.sleep("5 millis"), () =>
            Effect.sync(() => {
              reads += 1
              return { reads }
            }),
          ),
        ),
        UsageHistoryWatermark.make(database.db),
      )

      // Eight consumers land together on a cold watermark, then eight more on a
      // just-invalidated one. That is the shape that turns one commit into an
      // N-way full projection scan.
      const cold = yield* Effect.all(Array.from({ length: 8 }, () => cached()), { concurrency: "unbounded" })
      expect(reads).toBe(1)
      for (const memo of cold) expect(memo).toBe(cold[0])

      yield* commitExternally(statisticalKeyID(key), 700)
      const warm = yield* Effect.all(Array.from({ length: 8 }, () => cached()), { concurrency: "unbounded" })
      expect(reads).toBe(2)
      for (const memo of warm) expect(memo).toBe(warm[0])

      // Still one read each afterwards, and reuse resumes.
      expect(yield* cached()).toBe(warm[0])
      expect(reads).toBe(2)
    }),
  )
})

describe("UsageHistoryWatermark probe failures", () => {
  /**
   * A connection whose PRAGMA probe cannot be read.
   *
   * A cache reader must fail OPEN here: it cannot prove anything about other
   * writers, so it must invalidate. Crashing the Capacity request, or handing
   * back a counter that compares equal to the previous sample, are both worse
   * than a redundant re-read of an already-materialized projection.
   */
  const unhealthy = (probe: Effect.Effect<unknown, unknown>) =>
    UsageHistoryWatermark.make({
      get: () => probe,
    } as unknown as DatabaseShape)

  test("resolves an unreadable probe instead of dying", async () => {
    const defect = await Effect.runPromise(unhealthy(Effect.die(new Error("pragma exploded"))).pipe(Effect.exit))
    const failure = await Effect.runPromise(unhealthy(Effect.fail(new Error("busy"))).pipe(Effect.exit))

    expect(defect._tag).toBe("Success")
    expect(failure._tag).toBe("Success")
  })

  test("never compares equal to a previous sample or to a healthy reading", async () => {
    const defect = await Effect.runPromise(unhealthy(Effect.die(new Error("pragma exploded"))))
    const failure = await Effect.runPromise(unhealthy(Effect.fail(new Error("busy"))))
    const missing = await Effect.runPromise(
      UsageHistoryWatermark.make({ get: () => Effect.succeed(undefined) } as unknown as DatabaseShape),
    )
    const healthy = await Effect.runPromise(
      UsageHistoryWatermark.make({
        get: () => Effect.succeed({ data_version: 4 }),
      } as unknown as DatabaseShape),
    )

    // Not equal to itself: the memo can never be reused across two unhealthy
    // samples, so an unobservable probe can never be read as "unchanged".
    expect(UsageHistoryWatermark.same(defect, defect)).toBe(false)
    expect(UsageHistoryWatermark.same(defect, failure)).toBe(false)
    expect(UsageHistoryWatermark.same(defect, missing)).toBe(false)
    expect(UsageHistoryWatermark.same(defect, healthy)).toBe(false)
    expect(UsageHistoryWatermark.same(healthy, healthy)).toBe(true)
  })

  test("re-reads durable state on every call while the probe stays unhealthy", async () => {
    let reads = 0
    const cached = UsageHistoryWatermark.cached(
      Effect.suspend(() =>
        Effect.sync(() => {
          reads += 1
          return { reads }
        }),
      ),
      unhealthy(Effect.die(new Error("pragma exploded"))),
    )

    const first = await Effect.runPromise(cached())
    const second = await Effect.runPromise(cached())
    const third = await Effect.runPromise(cached())

    expect(first.value.reads).toBe(1)
    expect(second.value.reads).toBe(2)
    expect(third.value.reads).toBe(3)
    expect(reads).toBe(3)
  })

  test("resumes normal reuse once the probe recovers", async () => {
    let healthy = false
    let reads = 0
    const cached = UsageHistoryWatermark.cached(
      Effect.suspend(() =>
        Effect.sync(() => {
          reads += 1
          return { reads }
        }),
      ),
      // Exactly what `make` emits: an unobservable probe yields the
      // self-invalidating NaN signal rather than a crash.
      Effect.suspend(() =>
        Effect.succeed({
          localRevision: 0,
          externalDataVersion: healthy ? 7 : Number.NaN,
        }),
      ),
    )

    expect((await Effect.runPromise(cached())).value.reads).toBe(1)
    expect((await Effect.runPromise(cached())).value.reads).toBe(2)

    healthy = true
    expect((await Effect.runPromise(cached())).value.reads).toBe(3)
    const settled = await Effect.runPromise(cached())
    expect(await Effect.runPromise(cached())).toBe(settled)
    expect(reads).toBe(3)
  })
})

describe("UsageHistoryWatermark in-memory databases", () => {
  const memory = testEffect(graph(":memory:"))

  memory.live("keeps in-process correctness with no external signal available", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const usage = yield* UsageRecord.Service
      const usageYield = yield* UsageYield.Service
      const cached = UsageHistoryWatermark.cached(
        Effect.suspend(() => usageYield.list()),
        UsageHistoryWatermark.make(database.db),
      )

      const empty = yield* cached()
      expect(empty.value).toEqual([])

      // `:memory:` has no other connection, so data_version can never move. The
      // local revision is therefore the only complete signal and must not be
      // treated as redundant.
      yield* usage.record({
        messageID: "msg_watermark_memory",
        sessionID: "ses_watermark",
        providerID: key.providerID,
        modelID: key.baseModelID,
        completedAt: 1_000,
        tokens: { input: 400, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      })

      const filled = yield* cached()
      expect(filled).not.toBe(empty)
      expect(filled.watermark.externalDataVersion).toBe(empty.watermark.externalDataVersion)
      expect(filled.watermark.localRevision).toBeGreaterThan(empty.watermark.localRevision)
      expect(filled.value.map((entry) => entry.key.baseModelID)).toContain(key.baseModelID)
    }),
  )
})
