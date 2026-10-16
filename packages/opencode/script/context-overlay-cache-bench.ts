/**
 * Isolated real SQLite WAL benchmark; never opens the user's configured DB.
 * Run from packages/opencode: bun script/context-overlay-cache-bench.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionContextStateTable, SessionTable } from "@opencode-ai/core/session/sql"
import { EffectiveContextCompiler } from "../src/session/context/compiler"

const folder = mkdtempSync(join(tmpdir(), "openfork-ctxcache-bench-"))
const filename = join(folder, "cache-bench.db")
const sessionID = SessionSchema.ID.make("ses_cache_bench")
const rounds = 6
const iterations = 100
const median = (list: number[]) => {
  const s = list.toSorted((a, b) => a - b)
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2
}
const report = await (async () => {
  try {
    return await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const database = yield* Database.Service
      if (resolve(database.filename) !== resolve(filename) || database.readDb === database.db) {
        return yield* Effect.die(new Error("Not isolated on a distinct WAL reader; refusing benchmark writes"))
      }
      const { db, readDb } = database
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/ctxcache-bench"), sandboxes: [] })
        .onConflictDoNothing().run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values({
        id: sessionID, project_id: Project.ID.global, slug: "ctxcache-bench",
        directory: "/ctxcache-bench", title: "Context cache benchmark", version: "test",
      }).run().pipe(Effect.orDie)
      const query = () => readDb.select({
        messageID: SessionContextStateTable.message_id,
        excluded: SessionContextStateTable.excluded,
        pinned: SessionContextStateTable.pinned,
        overrideData: SessionContextStateTable.override_data,
      }).from(SessionContextStateTable).where(eq(SessionContextStateTable.session_id, sessionID)).all()
      // Match the original compileForSession Effect.fn/return shape instead
      // of giving the baseline a cheaper bare query+number result.
      const baseline = Effect.fn("LegacyContextCompiler.compileForSession")(function* () {
        const rows = yield* query()
        if (rows.length === 0) {
          return { effective: [] as unknown[], excluded: [], pinned: [], warnings: [], hadOverlays: false }
        }
        const state = new Map(rows.map((row) => [row.messageID, {
          excluded: row.excluded, pinned: row.pinned, overrideData: row.overrideData ?? undefined,
        }]))
        return { ...EffectiveContextCompiler.compile({ messages: [], state }), hadOverlays: true }
      })
      const cached = () => EffectiveContextCompiler.compileForSession({ sessionID, messages: [] })
      const results: Array<{
        overlayRows: number
        baselineMedianMs: number
        cachedMedianMs: number
        ratio: number
        churnBaselineMedianMs: number
        churnCacheMedianMs: number
        churnRatio: number
      }> = []
      let inserted = 0
      for (const n of [0, 1, 20, 50]) {
        if (n > inserted) {
          yield* db.insert(SessionContextStateTable).values(Array.from({ length: n - inserted }, (_, index) => ({
            session_id: sessionID, message_id: `msg_cache_${index + inserted}` as any,
            excluded: false, pinned: true, modified_at: 1,
            override_data: { text: "overlay body ".repeat(20) },
          }))).run().pipe(Effect.orDie)
          inserted = n
        }
        // Keep steady-state measurements independent of the previous
        // scenario's deliberate write storm and 300ms churn-bypass window.
        yield* Effect.sleep(350)
        yield* cached()
        const old: number[] = [], next: number[] = []
        for (let r = 0; r < rounds; r++) {
          for (const mode of r % 2 === 0 ? ["old", "cache"] as const : ["cache", "old"] as const) {
            const started = performance.now()
            for (let i = 0; i < iterations; i++) {
              if (mode === "old") yield* baseline()
              else yield* cached()
            }
            const elapsed = (performance.now() - started) / iterations
            if (mode === "old") old.push(elapsed)
            else next.push(elapsed)
          }
        }
        const before = median(old), after = median(next)
        // Writer-heavy adversarial case: a different connection commits a
        // Session update before EACH projection, invalidating data_version.
        // Measure only projection time, never the writer's commit cost.
        const churnOld: number[] = [], churnCache: number[] = []
        for (let i = 0; i < 40; i++) {
          for (const mode of i % 2 === 0 ? ["old", "cache"] as const : ["cache", "old"] as const) {
            yield* db.update(SessionTable).set({ title: `churn-${n}-${i}-${mode}` })
              .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
            const started = performance.now()
            if (mode === "old") yield* baseline()
            else yield* cached()
            const elapsed = performance.now() - started
            if (mode === "old") churnOld.push(elapsed)
            else churnCache.push(elapsed)
          }
        }
        const churnBefore = median(churnOld), churnAfter = median(churnCache)
        results.push({
          overlayRows: n, baselineMedianMs: +before.toFixed(4),
          cachedMedianMs: +after.toFixed(4), ratio: +(before / after).toFixed(2),
          churnBaselineMedianMs: +churnBefore.toFixed(4),
          churnCacheMedianMs: +churnAfter.toFixed(4),
          churnRatio: +(churnBefore / churnAfter).toFixed(2),
        })
      }
      return results
    }).pipe(Effect.provide(Database.layerFromPath(filename)))))
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})()
console.log(JSON.stringify({ benchmark: "context-overlay-cached-vs-canonical-sql", rounds, iterations, report }, null, 2))