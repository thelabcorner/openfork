import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { readTotals } from "./totals"

describe("Context totals WAL revision fence", () => {
  test("a persistent scan reader invalidates cached totals after out-of-band primary writes without EventV2", async () => {
    const folder = mkdtempSync(join(tmpdir(), "openfork-ctx-wal-version-"))
    const file = join(folder, "context.db")
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const { db, scanDb } = yield* Database.Service
        yield* db.run(sql`
          INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
          VALUES ('p_ctx_wal', '/ctx-wal', 'ctx-wal', '[]', 1000, 1000)
        `)
        const session = "ses_ctx_wal_version"
        yield* db.run(sql`
          INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
          VALUES (${session}, 'p_ctx_wal', '/ctx-wal', 'ctx-wal', 'Context WAL', '1', 1000, 1000)
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('msg_wal_1', ${session}, 1000, 1000, ${JSON.stringify({role:"user",time:{created:1000}})})
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated,
            data, context_projection_version, context_kind, context_tokens, context_preview)
          VALUES ('prt_wal_1','msg_wal_1',${session},1000,1000,${JSON.stringify({type:"text",text:"first"})},
            1,'text',12,'first')
        `)
        const scan = yield* scanDb()
        const dv = yield* scan.get<{ data_version: number }>(sql`PRAGMA data_version`)
        expect(dv?.data_version).toBeNumber()
        const cold = yield* readTotals(session)
        expect(cold.totals).toEqual({
          messageCount:1,excludedCount:0,pinnedCount:0,editedCount:0,
          estimatedTokens:16,estimatedTokensExcluded:0,
        })
        expect((yield* readTotals(session)).totals).toEqual(cold.totals)
        const mutable = yield* readTotals(session)
        mutable.totals!.messageCount = 999
        expect((yield* readTotals(session)).totals?.messageCount).toBe(1)
        // This is intentionally NOT a durable EventV2 operation. Detect it via
        // the scan connection's native data_version; eventSeq remains -1.
        yield* db.run(sql`UPDATE part SET context_tokens = 22 WHERE id = 'prt_wal_1'`)
        const afterWriteVersion = yield* scan.get<{ data_version: number }>(sql`PRAGMA data_version`)
        expect(afterWriteVersion?.data_version).toBeGreaterThan(dv!.data_version)
        const changed = yield* readTotals(session)
        expect(changed.revision).toBe(cold.revision)
        expect(changed.totals?.estimatedTokens).toBe(26)
        expect((yield* readTotals(session)).totals?.estimatedTokens).toBe(26)
        yield* db.run(sql`
          INSERT INTO message (id,session_id,time_created,time_updated,data)
          VALUES ('msg_wal_2',${session},2000,2000,
            ${JSON.stringify({role:"assistant",time:{created:2000}})})
        `)
        expect((yield* readTotals(session)).totals).toMatchObject({
          messageCount:2,estimatedTokens:30,
        })
        yield* db.run(sql`UPDATE part SET context_projection_version = 0 WHERE id='prt_wal_1'`)
        expect((yield* readTotals(session)).totals).toBeUndefined()
        yield* db.run(sql`UPDATE part SET context_projection_version = 1 WHERE id='prt_wal_1'`)
        expect((yield* readTotals(session)).totals?.estimatedTokens).toBe(30)
      }).pipe(Effect.provide(Database.layerFromPath(file))))
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }, 30_000)
})
