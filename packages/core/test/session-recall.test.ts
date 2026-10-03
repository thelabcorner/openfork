import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionRecall } from "@opencode-ai/core/session/recall"
import { SessionSearch } from "@opencode-ai/core/session/search"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { partSearchText, searchText } from "@opencode-ai/core/session/search-text"
import {
  MessageTable,
  PartSearchBackfillTable,
  PartTable,
  SearchBackfillTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const model = { id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))

describe("SessionRecall", () => {
  test("structurally verifies tool calls after FTS narrowing in both stores", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_recall_tools")

        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: "recall-tools",
            directory: "/project",
            title: "Recall tool calls",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        const v1MessageID = SessionV1.MessageID.make("msg_v1_recall")
        yield* db
          .insert(MessageTable)
          .values({
            id: v1MessageID,
            session_id: sessionID,
            time_created: 10,
            data: { role: "assistant", time: { created: 10 } } as never,
          })
          .run()
          .pipe(Effect.orDie)

        const fakeText = SessionV1.TextPart.make({
          id: SessionV1.PartID.make("prt_fake_tool_text"),
          sessionID,
          messageID: v1MessageID,
          type: "text",
          text: 'tool:read {"path":"AGENTS.md"}',
          time: { start: 10 },
        })
        const realTool = SessionV1.ToolPart.make({
          id: SessionV1.PartID.make("prt_real_tool"),
          sessionID,
          messageID: v1MessageID,
          type: "tool",
          callID: "call_read",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "AGENTS.md" },
            output: "ok",
            title: "read",
            metadata: {},
            time: { start: 10, end: 11 },
          },
        })

        for (const part of [fakeText, realTool] as SessionV1.Part[]) {
          const { id, messageID, sessionID: _, ...data } = part
          yield* db
            .insert(PartTable)
            .values({
              id,
              message_id: messageID,
              session_id: sessionID,
              time_created: 10,
              data: data as never,
              search_text: partSearchText(part),
            })
            .run()
            .pipe(Effect.orDie)
        }

        const fakeV2 = SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_v2_fake_tool"),
          type: "assistant",
          agent: "build",
          model,
          content: [{ type: "text", id: "txt_fake", text: 'tool:read {"path":"AGENTS.md"}' }],
          time: { created: DateTime.makeUnsafe(20) },
        })
        const realV2 = SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_v2_real_tool"),
          type: "assistant",
          agent: "build",
          model,
          content: [
            {
              type: "tool",
              id: "tool_real",
              name: "read",
              state: {
                status: "completed",
                input: { path: "AGENTS.md" },
                content: [],
                structured: {},
              },
              time: { created: DateTime.makeUnsafe(21) },
            },
          ],
          time: { created: DateTime.makeUnsafe(21) },
        })

        for (const [seq, message] of [fakeV2, realV2].entries()) {
          const encoded = encodeMessage(message)
          const { id, type, ...data } = encoded
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make(id),
              session_id: sessionID,
              type,
              seq: seq + 1,
              time_created: DateTime.toEpochMillis(message.time.created),
              data,
              search_text: searchText(message),
            })
            .run()
            .pipe(Effect.orDie)
        }

        yield* db
          .insert(PartSearchBackfillTable)
          .values({ id: 1, watermark_rowid: -1, done: 1 })
          .onConflictDoUpdate({ target: PartSearchBackfillTable.id, set: { done: 1 } })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SearchBackfillTable)
          .values({ id: 1, watermark_rowid: -1, done: 1 })
          .onConflictDoUpdate({ target: SearchBackfillTable.id, set: { done: 1 } })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SearchBackfillTable)
          .values({ id: SessionSearch.CurrentSearchProjectionVersion, watermark_rowid: -1, done: 1 })
          .onConflictDoUpdate({ target: SearchBackfillTable.id, set: { done: 1 } })
          .run()
          .pipe(Effect.orDie)

        const broad = yield* SessionSearch.search(db, { query: "AGENTS", limit: 10 })
        expect(broad.messageMatches.length).toBeGreaterThanOrEqual(2)

        const result = yield* SessionRecall.recall(db, {
          query: "AGENTS",
          tool: "read",
          includeArchived: false,
          limit: 10,
        })

        expect(result.toolMatches).toHaveLength(2)
        expect(result.toolMatches.map((hit) => hit.partID).sort()).toEqual(["prt_real_tool", "tool_real"].sort())
        expect(result.toolMatches.map((hit) => hit.source).toSorted()).toEqual(
          ["v1_part", "v2_message"] as Array<"v1_part" | "v2_message">,
        )
        expect(result.toolMatches.every((hit) => hit.tool === "read")).toBe(true)
        expect(result.coverage).toEqual({
          v1PartIndexReady: true,
          v2MessageIndexReady: true,
          v2ToolIndexReady: true,
          v1ToolCandidatesTruncated: false,
          v2ToolCandidatesTruncated: false,
          complete: true,
        })
      }),
    )
  })

  test("applies authorized directory prefixes before title and FTS ranking", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/allowed"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        const sessions = [
          { id: SessionSchema.ID.make("ses_inside_scope"), directory: "/allowed/project" },
          { id: SessionSchema.ID.make("ses_outside_scope"), directory: "/elsewhere/project" },
        ] as const
        for (const session of sessions) {
          yield* db
            .insert(SessionTable)
            .values({
              id: session.id,
              project_id: ProjectV2.ID.global,
              slug: String(session.id),
              directory: session.directory,
              title: "needle title",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          const message = SessionMessage.User.make({
            id: SessionMessage.ID.make(`msg_${String(session.id)}`),
            type: "user",
            text: "needle content",
            time: { created: DateTime.makeUnsafe(1) },
          })
          const encoded = encodeMessage(message)
          const { id, type, ...data } = encoded
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make(id),
              session_id: session.id,
              type,
              seq: 1,
              time_created: 1,
              data,
              search_text: searchText(message),
            })
            .run()
            .pipe(Effect.orDie)
        }

        yield* db
          .insert(SearchBackfillTable)
          .values({ id: 1, watermark_rowid: -1, done: 1 })
          .onConflictDoUpdate({ target: SearchBackfillTable.id, set: { done: 1 } })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(PartSearchBackfillTable)
          .values({ id: 1, watermark_rowid: -1, done: 1 })
          .onConflictDoUpdate({ target: PartSearchBackfillTable.id, set: { done: 1 } })
          .run()
          .pipe(Effect.orDie)

        const result = yield* SessionRecall.recall(db, {
          query: "needle",
          directoryPrefixes: ["/allowed"],
          limit: 10,
        })
        expect(result.titleMatches.map((hit) => String(hit.id))).toEqual(["ses_inside_scope"])
        expect(result.messageMatches.map((hit) => String(hit.sessionID))).toEqual(["ses_inside_scope"])
        expect(result.coverage.complete).toBe(true)
      }),
    )
  })

  test("repairs one bounded historical index chunk without full-startup backfill", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_repair_chunk")
        const v1MessageID = SessionV1.MessageID.make("msg_repair_v1")

        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: "repair-chunk",
            directory: "/project",
            title: "Repair chunk",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(MessageTable)
          .values({
            id: v1MessageID,
            session_id: sessionID,
            time_created: 1,
            data: { role: "user", time: { created: 1 } } as never,
          })
          .run()
          .pipe(Effect.orDie)

        const part = SessionV1.TextPart.make({
          id: SessionV1.PartID.make("prt_repair_chunk"),
          sessionID,
          messageID: v1MessageID,
          type: "text",
          text: "historical repair needle",
          time: { start: 1 },
        })
        const { id: partID, messageID, sessionID: _, ...partData } = part
        yield* db
          .insert(PartTable)
          .values({
            id: partID,
            message_id: messageID,
            session_id: sessionID,
            time_created: 1,
            data: partData as never,
            search_text: "",
          })
          .run()
          .pipe(Effect.orDie)

        const message = SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_repair_v2"),
          type: "user",
          text: "historical repair needle",
          time: { created: DateTime.makeUnsafe(2) },
        })
        const encoded = encodeMessage(message)
        const { id, type, ...data } = encoded
        yield* db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make(id),
            session_id: sessionID,
            type,
            seq: 1,
            time_created: 2,
            data,
            search_text: "",
          })
          .run()
          .pipe(Effect.orDie)

        expect((yield* SessionSearch.search(db, { query: "needle" })).messageMatches).toEqual([])
        const progress = yield* SessionSearch.repairChunk(db, { maxRows: 2 })
        expect(progress).toEqual({
          sessionMessages: { processed: 1, done: true },
          parts: { processed: 1, done: true },
        })
        const repaired = yield* SessionRecall.recall(db, { query: "needle", limit: 10 })
        expect(repaired.messageMatches).toHaveLength(2)
        expect(repaired.partMatches).toMatchObject([{ partID: "prt_repair_chunk", partType: "text" }])
        expect(repaired.coverage.complete).toBe(true)
        expect(repaired.coverage.v2ToolIndexReady).toBe(true)
      }),
    )
  })

  test("reprojects historical V2 tool markers even when the original content cursor is already complete", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_tool_marker_upgrade")
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: "tool-marker-upgrade",
            directory: "/project",
            title: "Tool marker upgrade",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        const message = SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_tool_marker_upgrade"),
          type: "assistant",
          agent: "build",
          model,
          content: [{
            type: "tool",
            id: "tool_marker_upgrade",
            name: "read",
            state: {
              status: "completed",
              input: { path: "legacy.txt" },
              content: [],
              structured: {},
            },
            time: { created: DateTime.makeUnsafe(10) },
          }],
          time: { created: DateTime.makeUnsafe(10) },
        })
        const encoded = encodeMessage(message)
        const { id, type, ...data } = encoded
        yield* db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make(id),
            session_id: sessionID,
            type,
            seq: 1,
            time_created: 10,
            data,
            // Pre-upgrade V2 extractor indexed tool input but not tool name.
            search_text: JSON.stringify({ path: "legacy.txt" }),
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SearchBackfillTable)
          .values({ id: 1, watermark_rowid: 1, done: 1 })
          .onConflictDoUpdate({ target: SearchBackfillTable.id, set: { watermark_rowid: 1, done: 1 } })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(PartSearchBackfillTable)
          .values({ id: 1, watermark_rowid: -1, done: 1 })
          .onConflictDoUpdate({ target: PartSearchBackfillTable.id, set: { done: 1 } })
          .run()
          .pipe(Effect.orDie)

        const before = yield* SessionRecall.recall(db, { tool: "read", limit: 5 })
        expect(before.toolMatches).toMatchObject([{ source: "v2_message", partID: "tool_marker_upgrade" }])
        expect(before.coverage.v2MessageIndexReady).toBe(true)
        expect(before.coverage.v2ToolIndexReady).toBe(false)
        // The bounded compatibility scan can still prove this tiny fixture.
        expect(before.coverage.complete).toBe(true)

        const progress = yield* SessionSearch.repairChunk(db, { maxRows: 8 })
        expect(progress.sessionMessages).toEqual({ processed: 1, done: true })

        const row = yield* db
          .select({ searchText: SessionMessageTable.search_text })
          .from(SessionMessageTable)
          .where(sql`${SessionMessageTable.id} = ${SessionMessage.ID.make("msg_tool_marker_upgrade")}`)
          .get()
        expect(row?.searchText).toContain("tool:read")

        const after = yield* SessionRecall.recall(db, { tool: "read", limit: 5 })
        expect(after.toolMatches).toMatchObject([{ source: "v2_message", partID: "tool_marker_upgrade" }])
        expect(after.coverage.v2ToolIndexReady).toBe(true)
        expect(after.coverage.complete).toBe(true)
      }),
    )
  })

  test("bounds structural verification and marks saturated candidate windows incomplete", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_recall_bound")
        const messageID = SessionV1.MessageID.make("msg_recall_bound")

        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: "recall-bound",
            directory: "/project",
            title: "Recall bound",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(MessageTable)
          .values({
            id: messageID,
            session_id: sessionID,
            time_created: 1,
            data: { role: "assistant", time: { created: 1 } } as never,
          })
          .run()
          .pipe(Effect.orDie)

        for (let index = 0; index < 65; index++) {
          const part = SessionV1.TextPart.make({
            id: SessionV1.PartID.make(`prt_recall_bound_${index}`),
            sessionID,
            messageID,
            type: "text",
            text: `tool:read needle fake candidate ${index}`,
            time: { start: index },
          })
          const { id, messageID: parent, sessionID: _, ...data } = part
          yield* db
            .insert(PartTable)
            .values({
              id,
              message_id: parent,
              session_id: sessionID,
              time_created: index,
              data: data as never,
              search_text: partSearchText(part),
            })
            .run()
            .pipe(Effect.orDie)
        }

        yield* db
          .insert(PartSearchBackfillTable)
          .values({ id: 1, watermark_rowid: -1, done: 1 })
          .onConflictDoUpdate({ target: PartSearchBackfillTable.id, set: { done: 1 } })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SearchBackfillTable)
          .values({ id: 1, watermark_rowid: -1, done: 1 })
          .onConflictDoUpdate({ target: SearchBackfillTable.id, set: { done: 1 } })
          .run()
          .pipe(Effect.orDie)

        const result = yield* SessionRecall.recall(db, {
          query: "needle",
          tool: "read",
          limit: 1,
        })
        expect(result.toolMatches).toEqual([])
        expect(result.coverage.v1ToolCandidatesTruncated).toBe(true)
        expect(result.coverage.complete).toBe(false)
      }),
    )
  })

  test("reports incomplete coverage instead of proving a negative when historical indexes are unfinished", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const result = yield* SessionRecall.recall(db, { query: "missing", limit: 5 })
        expect(result.messageMatches).toEqual([])
        expect(result.coverage.complete).toBe(false)
        expect(result.coverage.v1PartIndexReady).toBe(false)
        expect(result.coverage.v2MessageIndexReady).toBe(false)
        expect(result.coverage.v2ToolIndexReady).toBe(false)
      }),
    )
  })
})
