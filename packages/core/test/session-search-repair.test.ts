/** Hermetic repair/recall fidelity tests: no access to the user's live database. */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime, Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionRecall } from "@opencode-ai/core/session/recall"
import { SessionSearch } from "@opencode-ai/core/session/search"
import {
  MessageTable, PartSearchBackfillTable, PartTable, SearchBackfillTable,
  SessionMessageTable, SessionTable,
} from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

describe("bounded historical-index repair and recall", () => {
  it.effect("a legacy backfill marker cannot claim current V2 extractor coverage", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.insert(SearchBackfillTable)
        .values({ id: 1, watermark_rowid: 0, done: 1 })
        .onConflictDoUpdate({ target: SearchBackfillTable.id, set: { done: 1 } })
        .run().pipe(Effect.orDie)
      yield* db.insert(PartSearchBackfillTable)
        .values({ id: 2, watermark_rowid: 0, done: 1 })
        .onConflictDoUpdate({ target: PartSearchBackfillTable.id, set: { done: 1 } })
        .run().pipe(Effect.orDie)
      const coverage = yield* SessionSearch.indexCoverage(db)
      expect(coverage.v1PartIndexReady).toBe(true)
      expect(coverage.v2MessageIndexReady).toBe(true)
      expect(coverage.v2ToolIndexReady).toBe(false)
      const recall = yield* SessionRecall.recall(db, { query: "legacytoolmarker" })
      expect(recall.coverage.complete).toBe(false)
      expect(recall.messageMatches).toEqual([])
    }),
  )

  test("dedicated maintenance connection repairs a temporary file while its live reader remains open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openfork-recall-repair-"))
    const filename = join(dir, "fixture.db")
    try {
      const layer = AppNodeBuilder.build(
        LayerNode.group([Database.node]),
        [[Database.node, Database.layerFromPath(filename)]],
      )
      await Effect.runPromise(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.insert(ProjectTable).values({
          id: ProjectV2.ID.global, worktree: AbsolutePath.make("/example"), sandboxes: [],
        }).run().pipe(Effect.orDie)
        const sid = SessionSchema.ID.make("ses_ownconnection_repair")
        yield* db.insert(SessionTable).values({
          id: sid, project_id: ProjectV2.ID.global, slug: "ownconnection",
          directory: "/example/work", title: "Project session", version: "test",
        }).run().pipe(Effect.orDie)
        const message = SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_ownconnection_repair"),
          type: "user", text: "silverrosette unique persisted historical statement",
          time: { created: DateTime.makeUnsafe(100) },
        })
        const { id, type, ...data } = encodeMessage(message)
        yield* db.insert(SessionMessageTable).values({
          id: SessionMessage.ID.make(id), session_id: sid,
          type, seq: 1, data, time_created: 100, search_text: "",
        }).run().pipe(Effect.orDie)
        expect((yield* SessionSearch.search(db, { query: "silverrosette" })).messageMatches).toHaveLength(0)

        let progress = yield* SessionSearch.repairOnOwnConnection(filename, {
          maxRows: 1, timeoutMs: 3_000,
        })
        expect(progress.timedOut).toBe(false)
        expect(progress.sessionMessages.processed).toBeLessThanOrEqual(1)
        // A single row exactly fills the first chunk, so completion must wait
        // for the next empty read; a bounded call cannot infer end-of-table.
        expect(progress.sessionMessages.done).toBe(false)
        progress = yield* SessionSearch.repairOnOwnConnection(filename, {
          maxRows: 1, timeoutMs: 3_000,
        })
        expect(progress.timedOut).toBe(false)
        expect(progress.sessionMessages.done).toBe(true)
        expect(Object.values(yield* SessionSearch.indexCoverage(db)).every(Boolean)).toBe(true)
        const recall = yield* SessionRecall.recall(db, {
          query: "silverrosette", directoryPrefixes: ["/example"], limit: 5,
        })
        expect(recall.coverage.complete).toBe(true)
        expect(recall.messageMatches.map((item) => item.messageID)).toContain(message.id)
      }).pipe(Effect.scoped, Effect.provide(layer)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.effect("read-only, resumable, index-complete across V1/V2, scoped and idempotent", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.insert(ProjectTable).values({
        id: ProjectV2.ID.global, worktree: AbsolutePath.make("/allowed"), sandboxes: [],
      }).run().pipe(Effect.orDie)
      const sessions = [
        { id: "ses_repair_allow_v2", dir: "/allowed/a", time: 100 },
        { id: "ses_repair_deny_v2", dir: "/denied/b", time: 400 },
        { id: "ses_repair_allow_v1", dir: "/allowed/c", time: 200 },
      ] as const
      for (const item of sessions) {
        yield* db.insert(SessionTable).values({
          id: SessionSchema.ID.make(item.id), project_id: ProjectV2.ID.global,
          slug: item.id, directory: item.dir, title: "Generic imported session",
          version: "test", time_created: item.time, time_updated: item.time,
        }).run().pipe(Effect.orDie)
      }
      for (const item of sessions.slice(0, 2)) {
        const message = SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_" + item.id), type: "user",
          text: "seahorseverified heritage retrieval phrase",
          time: { created: DateTime.makeUnsafe(item.time) },
        })
        const { id, type, ...data } = encodeMessage(message)
        yield* db.insert(SessionMessageTable).values({
          id: SessionMessage.ID.make(id), session_id: SessionSchema.ID.make(item.id),
          type, seq: 1, data, time_created: item.time, search_text: "",
        }).run().pipe(Effect.orDie)
      }
      const v1session = sessions[2]!
      const v1mid = "msg_repair_v1"
      yield* db.insert(MessageTable).values({
        id: v1mid as typeof MessageTable.$inferInsert.id,
        session_id: SessionSchema.ID.make(v1session.id),
        data: {
          role: "user", time: { created: v1session.time }, agent: "build",
          model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("sonnet") },
        } as never,
        time_created: v1session.time,
      }).run().pipe(Effect.orDie)
      yield* db.insert(PartTable).values({
        id: "prt_repair_v1" as typeof PartTable.$inferInsert.id,
        message_id: v1mid as typeof PartTable.$inferInsert.message_id,
        session_id: SessionSchema.ID.make(v1session.id),
        time_created: v1session.time,
        data: { type: "text", text: "seahorseverified legacy version", time: { start: 0 } } as never,
        search_text: "",
      }).run().pipe(Effect.orDie)

      const input = { query: "seahorseverified", ranking: "relevance" as const,
        directoryPrefixes: ["/allowed"], limit: 5 }
      const originalCoverage = yield* SessionSearch.indexCoverage(db)
      expect(Object.values(originalCoverage).every((value) => value === false)).toBe(true)
      const before = yield* SessionRecall.recall(db, input)
      expect(before.coverage.complete).toBe(false)
      expect(before.messageMatches).toHaveLength(0)
      expect(before.partMatches).toHaveLength(0)

      const history = []
      for (let step = 0; step < 8; step++) {
        const progress = yield* SessionSearch.repairChunk(db, { maxRows: 1 })
        history.push(progress)
        for (const status of [progress.sessionMessages, progress.parts, progress.toolRecallV1, progress.toolRecallV2]) {
          expect(status.processed).toBeLessThanOrEqual(1)
        }
        if (progress.sessionMessages.done && progress.parts.done &&
          progress.toolRecallV1.done && progress.toolRecallV2.done) break
      }
      expect(history.length).toBeGreaterThan(1)
      const finalProgress = history.at(-1)!
      expect(Object.values(finalProgress).every((status) => status.done)).toBe(true)
      const finalCoverage = yield* SessionSearch.indexCoverage(db)
      expect(Object.values(finalCoverage).every((value) => value === true)).toBe(true)

      const after = yield* SessionRecall.recall(db, input)
      expect(after.coverage.complete).toBe(true)
      expect(new Set(after.messageMatches.map((item) => String(item.sessionID)))).toEqual(
        new Set(["ses_repair_allow_v1", "ses_repair_allow_v2"]),
      )
      expect(after.partMatches.map((item) => item.partID)).toContain("prt_repair_v1")
      expect(JSON.stringify(after)).not.toContain("ses_repair_deny_v2")
      expect(after.messageMatches.some((item) => item.messageID === "msg_ses_repair_allow_v2")).toBe(true)

      // Once complete, further bounded maintenance passes are no-ops.
      const noOp = yield* SessionSearch.repairChunk(db, { maxRows: 1 })
      expect(Object.values(noOp).every((status) => status.processed === 0 && status.done)).toBe(true)
    }),
  )
})
