import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { Database as NativeSqlite } from "bun:sqlite"
import { Database } from "@opencode-ai/core/database/database"
import { sqliteFingerprint } from "@opencode-ai/core/database/sqlite-query-forensics"
import * as ZenFreeUsage from "@/usage/zen-free"

const dialect = new SQLiteSyncDialect()

describe("Zen free historical read contention (real service)", () => {
  test("20 concurrent snapshots use one indexed, scan-lane SQL pair with no startup DDL", async () => {
    const statements: string[] = []
    let scanned = 0
    let opened = 0
    const scan = {
      all(query: Parameters<SQLiteSyncDialect["sqlToQuery"]>[0]) {
        const rendered = dialect.sqlToQuery(query)
        return Effect.gen(function* () {
          statements.push(rendered.sql)
          // Ensure every caller reaches the first cache miss before the initial
          // SQL can complete. This catches a pre-permit cache check race.
          yield* Effect.sleep("15 millis")
          scanned++
          return []
        })
      },
    }
    const fixture = {
      db: {
        run: () => { throw new Error("ZenFree must never mutate the primary database during service startup") },
      },
      scanDb: () => Effect.sync(() => {
        opened++
        return scan
      }),
    }
    const implementation = ZenFreeUsage.node.implementation as Layer.Layer<
      ZenFreeUsage.Service,
      never,
      Database.Service
    >
    const layer = Layer.provide(implementation, Layer.succeed(Database.Service, fixture as never))
    const service = await Effect.runPromise(Effect.provide(ZenFreeUsage.Service, layer))
    const snapshots = await Effect.runPromise(
      Effect.forEach(Array.from({ length: 20 }), () => service.snapshot(), { concurrency: 20 }),
    )

    expect(snapshots).toHaveLength(20)
    expect(snapshots.every((snap) => snap === snapshots[0])).toBe(true)
    expect(opened).toBe(1)
    expect(scanned).toBe(2)
    expect(statements).toHaveLength(2)
    for (const statement of statements) {
      expect(statement).toContain("FROM usage_record u INDEXED BY usage_record_model_completed_idx")
      expect(statement).toContain("CROSS JOIN message m")
      expect(statement).toContain("u.provider_id = 'opencode'")
      expect(statement).toContain("u.route_kind = 'public'")
      // The previous slow startup query was fingerprinted e3be8ca2.
      // A runtime showing that fingerprint has not reached this new query.
      expect(sqliteFingerprint(statement)).not.toBe("e3be8ca2")
    }
    expect(statements[0]).toContain("CROSS JOIN part p")
    expect(statements[0]).toContain("p.message_id = m.id")
  })

  test("actual service SQL uses indexed provider settlement and excludes foreign/paid routes", async () => {
    const db = new NativeSqlite(":memory:")
    try {
      db.exec(`
        CREATE TABLE message(id TEXT PRIMARY KEY,time_created INTEGER,time_updated INTEGER,data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,time_created INTEGER,data TEXT);
        CREATE TABLE usage_record(message_id TEXT PRIMARY KEY,provider_id TEXT,model_id TEXT,route_kind TEXT,completed_at INTEGER);
        CREATE INDEX usage_record_model_completed_idx ON usage_record(provider_id,model_id,completed_at);
        CREATE INDEX part_message_id_id_idx ON part(message_id,id);
      `)
      const at = Date.now() - 20_000
      const msg = db.prepare("INSERT INTO message VALUES(?,?,?,?)")
      const part = db.prepare("INSERT INTO part VALUES(?,?,?,?)")
      const usage = db.prepare("INSERT INTO usage_record VALUES(?,?,?,?,?)")
      for (const [id, provider, route] of [
        ["good", "opencode", "public"],
        ["account", "opencode", "account"],
        // A corrupted/inconsistent settlement must not count as Public Zen
        // solely because mutable message metadata still says "opencode".
        ["foreign", "other", "public"],
      ] as const) {
        msg.run(id, at, at + 3000, JSON.stringify({
          role: "assistant", providerID: "opencode", modelID: "mimo-free",
          time: { completed: at + 3000 },
        }))
        part.run(id + "_1", id, at + 1000, '{"type":"step-finish"}')
        part.run(id + "_2", id, at + 2000, '{"type":"step-finish"}')
        usage.run(id, provider, "mimo-free", route, at + 3000)
      }
      const sqlQueries: Array<{ sql: string; params: unknown[] }> = []
      const connection = {
        all(query: Parameters<SQLiteSyncDialect["sqlToQuery"]>[0]) {
          const compiled = dialect.sqlToQuery(query)
          sqlQueries.push(compiled)
          return Effect.sync(() =>
            db.prepare(compiled.sql).all(...(compiled.params as Array<string | number | null>)))
        },
      }
      const fixture = { scanDb: () => Effect.succeed(connection) }
      const implementation = ZenFreeUsage.node.implementation as Layer.Layer<
        ZenFreeUsage.Service, never, Database.Service
      >
      const layer = Layer.provide(implementation, Layer.succeed(Database.Service, fixture as never))
      const service = await Effect.runPromise(Effect.provide(ZenFreeUsage.Service, layer))
      const result = await Effect.runPromise(service.snapshot())
      expect(result.currentRequests).toBe(2)
      expect(result.days.reduce((sum, row) => sum + row.requests, 0)).toBe(2)
      expect(sqlQueries).toHaveLength(2)
      for (const statement of sqlQueries) {
        const detail = db.prepare("EXPLAIN QUERY PLAN " + statement.sql)
          .all(...(statement.params as Array<string | number | null>))
          .map((row: any) => String(row.detail))
        expect(detail[0]).toMatch(/SEARCH u USING INDEX usage_record_model_completed_idx \(provider_id=\?\)/)
        expect(detail.some((line) => /SCAN p\b/.test(line))).toBe(false)
      }
    } finally {
      db.close()
    }
  })
})
