import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageID, PartID } from "@opencode-ai/core/v1/session"
import { SessionLegacyToolIndex } from "@opencode-ai/core/session/legacy-tool-index"
import { MessageTable, PartTable, SessionTable, SessionV1ToolCallTable, SessionV1ToolCallBackfillTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))

const SID = SessionSchema.ID.make("ses_tool_index_fixture")
const MID = MessageID.make("msg_tool_index_fixture")

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({
    id: Project.ID.global, worktree: AbsolutePath.make("/tool-index"), sandboxes: [],
  }).onConflictDoNothing().run()
  yield* db.insert(SessionTable).values({
    id: SID, project_id: Project.ID.global, directory: "/tool-index",
    slug: "tool-index", title: "tool-index", version: "test",
  }).run()
  yield* db.insert(MessageTable).values({
    id: MID, session_id: SID, data: { role: "assistant" } as never,
  }).run()
  return db
})

describe("V1 indexed tool-call identity migration", () => {
  it.effect("backfills in bounded batches, preserves exact identity and avoids JSON after certification", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const historical = PartID.make("prt_legacy_tool_running")
      const completed = PartID.make("prt_legacy_tool_completed")
      const text = PartID.make("prt_legacy_non_tool")
      const largeText = PartID.make("prt_legacy_non_tool_large")
      const insert = (id: PartID, data: object) =>
        db.insert(PartTable).values({
          id, message_id: MID, session_id: SID, data: data as never,
          context_projection_version: 0,
        }).run()
      yield* insert(historical, {
        type: "tool", tool: "bash", callID: "call_exact_running",
        state: { status: "running", input: {}, time: { start: 1 } },
      })
      yield* insert(completed, {
        type: "tool", tool: "bash", callID: "call_exact_completed",
        state: { status: "completed", input: {}, output: "done", time: { start: 1, end: 2 } },
      })
      yield* insert(text, { type: "text", text: "ordinary" })
      yield* insert(largeText, { type: "text", text: "x".repeat(24 * 1024) })

      expect(yield* SessionLegacyToolIndex.exists(db, {
        sessionID: SID, messageID: MID, callID: "call_exact_running", unsettled: true,
      })).toBe(true)
      expect(yield* SessionLegacyToolIndex.hasUnsettled(db, SID)).toBe(true)
      expect(yield* SessionLegacyToolIndex.repairChunk(db, 1)).toEqual({
        scanned: 1, indexed: 1, done: false,
      })
      expect((yield* db.select().from(PartTable)
        .where(eq(PartTable.id, completed)).get())?.tool_identity_version).toBe(0)
      expect(yield* SessionLegacyToolIndex.repairChunk(db, 1)).toEqual({
        scanned: 1, indexed: 1, done: false,
      })
      expect(yield* SessionLegacyToolIndex.repairChunk(db, 1)).toEqual({
        scanned: 1, indexed: 1, done: false,
      })
      expect(yield* SessionLegacyToolIndex.repairChunk(db, 1)).toEqual({
        scanned: 1, indexed: 0, done: false,
      })
      expect(yield* SessionLegacyToolIndex.repairChunk(db, 1)).toEqual({
        scanned: 0, indexed: 0, done: true,
      })
      expect((yield* db.select({ version: PartTable.tool_identity_version })
        .from(PartTable).where(eq(PartTable.id, largeText)).get())?.version).toBe(0)
      // The intentionally unindexed large non-tool must still short-circuit
      // callID JSON extraction when OPCL replaces its payload. Its producer
      // verified Context kind is independent of the deferred identity index.
      // Unverified malformed v0 JSON remains fail-closed (tested below).
      yield* db.update(PartTable).set({
        context_projection_version: 1, context_kind: "text",
      }).where(eq(PartTable.id, largeText)).run()
      yield* db.run(sql`UPDATE part SET data = 'not-json' WHERE id = ${largeText}`)
      expect(yield* SessionLegacyToolIndex.exists(db, {
        sessionID: SID, messageID: MID, callID: "call_not_present",
      })).toBe(false)
      // Restore canonical content so subsequent hazard checks can still
      // conservatively inspect the unindexed historical row if necessary.
      yield* db.update(PartTable).set({
        data: { type: "text", text: "x".repeat(24 * 1024) } as never,
      }).where(eq(PartTable.id, largeText)).run()
      expect(yield* SessionLegacyToolIndex.repairChunk(db, 1)).toEqual({
        scanned: 0, indexed: 0, done: true,
      })
      expect((yield* db.select().from(SessionV1ToolCallTable).all())
        .map((row) => [row.part_id, row.call_id, row.status]).sort())
        .toEqual([
          [completed, "call_exact_completed", "completed"],
          [historical, "call_exact_running", "running"],
        ].sort())
      const callPlan = yield* db.all<{ detail: string }>(sql`
        EXPLAIN QUERY PLAN SELECT part_id FROM session_v1_tool_call
        WHERE session_id = ${SID} AND call_id = 'call_exact_running' AND status = 'running'
      `)
      expect(callPlan.some((row) =>
        row.detail.includes("session_v1_tool_call_session_call_idx"))).toBe(true)
      const hazardPlan = yield* db.all<{ detail: string }>(sql`
        EXPLAIN QUERY PLAN SELECT part_id FROM session_v1_tool_call
        WHERE session_id = ${SID} AND status IN ('pending','running')
      `)
      expect(hazardPlan.some((row) =>
        row.detail.includes("session_v1_tool_call_session_status_idx"))).toBe(true)
      expect((yield* SessionLegacyToolIndex.unsettledParts(db, SID)).map((row) => row.id)).toEqual([historical])

      // A certified projection is a complete structural proof; no raw JSON
      // is needed for indexed lookups, even if OPCL externalizes the body.
      yield* db.run(sql`UPDATE part SET data = 'not-json' WHERE id = ${historical}`)
      expect(yield* SessionLegacyToolIndex.exists(db, {
        sessionID: SID, messageID: MID, callID: "call_exact_running", unsettled: true,
      })).toBe(true)
      expect(yield* SessionLegacyToolIndex.exists(db, {
        sessionID: SID, messageID: MID, callID: "call_exact_completed", unsettled: true,
      })).toBe(false)
      expect(yield* SessionLegacyToolIndex.hasUnsettled(db, SID)).toBe(true)
      expect([...yield* SessionLegacyToolIndex.unsettledSessions(db, [SID])]).toEqual([SID])
      // Actual repair needs the payload. Corrupt JSON must fail closed rather
      // than fabricate a completed result from the tiny indexed status row.
      expect(Exit.isFailure(yield* SessionLegacyToolIndex.unsettledParts(db, SID).pipe(Effect.exit))).toBe(true)

      yield* db.delete(PartTable).where(eq(PartTable.id, historical)).run()
      expect(yield* SessionLegacyToolIndex.hasUnsettled(db, SID)).toBe(false)
      expect(yield* SessionLegacyToolIndex.exists(db, {
        sessionID: SID, messageID: MID, callID: "call_exact_running",
      })).toBe(false)
      expect((yield* db.select().from(SessionV1ToolCallTable).all()).length).toBe(1)
      expect((yield* db.select().from(SessionV1ToolCallBackfillTable).get())?.done).toBe(1)
    }),
  )

  it.effect("never treats a malformed unverified historical identity as safely absent", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const id = PartID.make("prt_malformed_legacy_tool")
      yield* db.insert(PartTable).values({
        id, session_id: SID, message_id: MID,
        data: { type: "tool", callID: "call_bad", state: { status: "pending" } } as never,
      }).run()
      yield* db.run(sql`UPDATE part SET data = 'not-json' WHERE id = ${id}`)
      expect(Exit.isFailure(yield* SessionLegacyToolIndex.hasUnsettled(db, SID).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* SessionLegacyToolIndex.repairChunk(db, 1).pipe(Effect.exit))).toBe(true)
      expect((yield* db.select({ version: PartTable.tool_identity_version })
        .from(PartTable).where(eq(PartTable.id, id)).get())?.version).toBe(0)
    }),
  )
})