/**
 * Benchmarks large message headers that Context must classify but must not
 * materialize whole. Uses a disposable SQLite database only.
 * bun script/benchmark-context-message-headers.ts 50 128
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, desc, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { MessageV2 } from "../src/session/message-v2"
import { SessionID } from "../src/session/schema"

const count = Math.max(1, Math.min(200, Number(process.argv[2] ?? 50) || 50))
const kib = Math.max(1, Math.min(1024, Number(process.argv[3] ?? 128) || 128))
const folder = mkdtempSync(join(tmpdir(), "openfork-context-headers-"))
const filename = join(folder, "bench.db")
const sessionID = SessionID.make("ses_bench_header_projection")
const median = (items: number[]) => [...items].sort((a, b) => a - b)[Math.floor(items.length / 2)]!

try {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
      VALUES ('proj_context_headers', '/headers', 'headers', '[]', 1000, 1000)
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
      VALUES (${sessionID}, 'proj_context_headers', '/headers', 'headers', 'headers', '1', 1000, 1000)
    `)
    const ballast = "x".repeat(kib * 1024)
    for (let i = 0; i < count; i++) {
      const id = `msg_bench_header_${String(i).padStart(5, "0")}`
      const time = 1000 + i
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (${id}, ${sessionID}, ${time}, ${time},
          ${JSON.stringify({
            role: "user", time: { created: time },
            provenance: { owner: "user", source: "prompt" },
            irrelevantProviderMetadata: ballast,
          })})
      `)
    }
    const original = () => readDb.select().from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .orderBy(desc(MessageTable.time_created))
      .limit(50).all().pipe(Effect.orDie)
    const narrow = () => readDb.select({
      id: MessageTable.id,
      sessionID: MessageTable.session_id,
      timeCreated: sql<number>`json_extract(${MessageTable.data}, '$.time.created')`,
      role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
      provenance: sql<string>`json_extract(${MessageTable.data}, '$.provenance')`,
      physicalTime: MessageTable.time_created,
    }).from(MessageTable).where(eq(MessageTable.session_id, sessionID))
      .orderBy(desc(MessageTable.time_created)).limit(50).all().pipe(Effect.orDie)
    const fast = () => MessageV2.pageContextFactsOn({ sessionID, limit: 50 }, readDb)
    const all = yield* original()
    const reduced = yield* narrow()
    const projected = yield* fast()
    if (!projected || all.length !== reduced.length || projected.items.length !== reduced.length)
      throw new Error("Missing projected page")
    for (let i = 0; i < all.length; i++) {
      const reference = all[i]!
      const scalar = reduced.find((item) => item.id === reference.id)
      const info = projected.items.find((item) => item.info.id === reference.id)
      if (!scalar || !info || info.info.role !== reference.data.role ||
        JSON.stringify((info.info as { provenance?: unknown }).provenance) !==
          JSON.stringify((reference.data as { provenance?: unknown }).provenance))
        throw new Error("Header projection drift")
    }
    const samples = { original: [] as number[], scalar: [] as number[], fullPage: [] as number[] }
    for (let i = 0; i < 9; i++) {
      for (const mode of i % 2
        ? ["fullPage", "scalar", "original"] as const
        : ["original", "scalar", "fullPage"] as const) {
        const start = performance.now()
        if (mode === "original") yield* original()
        else if (mode === "scalar") yield* narrow()
        else yield* fast()
        samples[mode].push(performance.now() - start)
      }
    }
    const before = median(samples.original), after = median(samples.scalar)
    return {
      rows: count, metadataKiBPerMessage: kib,
      fullHydrationMedianMs: Number(before.toFixed(3)),
      scalarHeaderMedianMs: Number(after.toFixed(3)),
      fullFactsPageMedianMs: Number(median(samples.fullPage).toFixed(3)),
      scalarSpeedup: Number((before / after).toFixed(2)),
      samples,
    }
  }).pipe(Effect.provide(Database.layerFromPath(filename))))
  console.log(JSON.stringify(result, null, 2))
} finally {
  rmSync(folder, { recursive: true, force: true })
}
