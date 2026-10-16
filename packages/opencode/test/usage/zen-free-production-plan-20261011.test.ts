import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { SQL } from "drizzle-orm"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import * as ZenFreeUsage from "@/usage/zen-free"

// Exercise the *actual* service SQL through its real Drizzle template and
// SQLite VM, not a hand-copied optimized query that could silently diverge.
describe("Zen free scanner's production SQL plan and bounded startup read", () => {
  test("starts from provider-scoped usage records, uses per-message part seeks, and preserves steps/errors", async () => {
    const native = new SQLite(":memory:")
    try {
      native.exec(`
        CREATE TABLE message (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
        CREATE INDEX part_message_id_id_idx ON part(message_id, id);
        CREATE TABLE usage_record (
          message_id TEXT PRIMARY KEY, provider_id TEXT, model_id TEXT,
          completed_at INTEGER, route_kind TEXT
        );
        CREATE INDEX usage_record_model_completed_idx
          ON usage_record(provider_id, model_id, completed_at);
      `)
      const now = Date.now()
      const start = ZenFreeUsage.zenUtcDayStart(now - ZenFreeUsage.ZEN_FREE_DAY_MS)
      const message = native.prepare("INSERT INTO message VALUES (?,?,?,?)")
      const part = native.prepare("INSERT INTO part VALUES (?,?,?,?)")
      const usage = native.prepare("INSERT INTO usage_record VALUES (?,?,?,?,?)")
      function insert(id: string, provider: string, model: string, route: string, at: number, type: string, error = false) {
        message.run(id, at, at + 100, JSON.stringify({
          role: "assistant", providerID: provider, modelID: model,
          time: { created: at, completed: at + 100 },
          ...(error ? { error: { name: "APIError", data: { responseBody: '{"name":"FreeUsageLimitError"}' } } } : {}),
        }))
        usage.run(id, provider, model, at + 100, route)
        if (!error) {
          part.run("p" + id, id, at + 50, JSON.stringify({ type }))
          part.run("t" + id, id, at + 60, '{"type":"text"}')
        }
      }
      native.exec("BEGIN")
      // Many unrelated historical rows represent the real startup workload.
      // Only two public/free successful steps should enter the quota learner.
      for (let i = 0; i < 2000; i++) {
        insert("noise" + i, i % 3 ? "other" : "opencode", i % 7 ? "paid" : "other-free",
          i % 3 ? "public" : "account", start + 1000 + i, "step-finish")
      }
      insert("good1", "opencode", "model-free", "public", start + 30_000, "step-finish")
      insert("good2", "opencode", "model-free", "public", start + 35_000, "step-finish")
      insert("ignored-account", "opencode", "model-free", "account", start + 38_000, "step-finish")
      insert("free-limit", "opencode", "model-free", "public", start + 40_000, "step-finish", true)
      native.exec("COMMIT")

      const dialect = new SQLiteSyncDialect()
      const statements: Array<{ sql: string; params: unknown[] }> = []
      let queryCount = 0
      const scan = {
        all<T>(_input: SQL) {
          const rendered = dialect.sqlToQuery(_input)
          return Effect.gen(function* () {
            // Keep the first call open long enough that other callers have
            // already missed the cache: they must not each rerun the scan.
            yield* Effect.sleep("5 millis")
            queryCount++
            statements.push(rendered)
            return native.prepare(rendered.sql).all(...rendered.params as Array<string | number | null>) as T[]
          })
        },
      }
      const database = { scanDb: () => Effect.succeed(scan) }
      const implementation = ZenFreeUsage.node.implementation as Layer.Layer<
        ZenFreeUsage.Service, never, Database.Service
      >
      const layer = Layer.provide(implementation, Layer.succeed(Database.Service, database as never))
      const service = await Effect.runPromise(Effect.provide(ZenFreeUsage.Service, layer))
      const snapshots = await Effect.runPromise(Effect.forEach(
        Array.from({ length: 20 }), () => service.snapshot(), { concurrency: 20 },
      ))
      expect(queryCount).toBe(2)
      expect(snapshots.every((value) => value === snapshots[0])).toBe(true)
      const daily = snapshots[0]!.days.find((day) => day.start === start)
      expect(daily?.requests).toBe(2)
      expect(snapshots[0]!.limitHits).toHaveLength(1)
      expect(snapshots[0]!.limitHits[0]?.requests).toBe(2)

      const requests = statements.find((q) => q.sql.includes("FROM usage_record") && q.sql.includes("part p"))
      const errors = statements.find((q) => q.sql.includes("FROM usage_record") && !q.sql.includes("part p"))
      expect(requests).toBeDefined()
      expect(errors).toBeDefined()
      for (const query of [requests!, errors!]) {
        const lines = native.prepare("EXPLAIN QUERY PLAN " + query.sql)
          .all(...query.params as Array<string | number | null>)
          .map((row: any) => String(row.detail))
        const usageSeek = lines.findIndex((line) => /SEARCH u .*usage_record_model_completed_idx/.test(line))
        expect(usageSeek).toBeGreaterThanOrEqual(0)
        // EXPLAIN may prefix CO-ROUTINE nodes on different SQLite versions:
        // require relative scan order, never a hard-coded first plan line.
        // This prevents the old 90-day Part-first loop from reappearing.
        expect(lines.some((line) => /SCAN p\\b|idx_part_time_created/.test(line))).toBe(false)
        if (query === requests) {
          const partSeek = lines.findIndex((line) => /SEARCH p .*part_message_id_id_idx/.test(line))
          expect(partSeek).toBeGreaterThan(usageSeek)
        }
      }
    } finally {
      native.close()
    }
  })
})
