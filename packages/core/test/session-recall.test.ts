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
import { SessionToolRecall } from "@opencode-ai/core/session/tool-recall"
import {
  MessageTable,
  PartSearchBackfillTable,
  PartTable,
  SearchBackfillTable,
  SessionMessageTable,
  SessionTable,
  SessionToolRecallBackfillTable,
  SessionToolRecallTable,
} from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const model = { id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))

describe("SessionRecall", () => {
  test("uses the exact producer-owned sidecar without hydrating wide tool payloads", async () => {
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

        const repaired = yield* SessionSearch.repairChunk(db, { maxRows: 32 })
        expect(repaired.toolRecallV1).toEqual({ processed: 2, projected: 1, done: true })
        expect(repaired.toolRecallV2).toEqual({ processed: 2, projected: 1, done: true })

        // Poison the wide structural payloads after the exact sidecar is built.
        // A regression that reintroduces tool verification by decoding part or
        // assistant JSON will now lose these matches; sidecar-only recall must
        // remain correct because search_text + exact tool identity are durable.
        yield* db
          .update(PartTable)
          .set({ data: { type: "text", text: "not a tool" } as never })
          .where(sql`${PartTable.id} = ${SessionV1.PartID.make("prt_real_tool")}`)
          .run()
          .pipe(Effect.orDie)
        const encodedFake = encodeMessage(fakeV2)
        const { id: _fakeID, type: _fakeType, ...fakeData } = encodedFake
        yield* db
          .update(SessionMessageTable)
          .set({ data: fakeData })
          .where(sql`${SessionMessageTable.id} = ${SessionMessage.ID.make("msg_v2_real_tool")}`)
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
        expect(result.toolMatches.every((hit) => !hit.snippet.includes("tool:read"))).toBe(true)
        expect(result.coverage).toEqual({
          v1PartIndexReady: true,
          v2MessageIndexReady: true,
          v2ToolIndexReady: true,
          v1ToolRecallReady: true,
          v2ToolRecallReady: true,
          toolResultsTruncated: false,
          complete: true,
        })

        const toolOnlyPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT t.id
          FROM session_tool_recall t INDEXED BY session_tool_recall_tool_time_idx
          JOIN session s ON s.id = t.session_id
          WHERE t.tool = 'read'
          ORDER BY t.time_created DESC, t.id DESC
          LIMIT 11
        `)
        const toolOnlyDetail = toolOnlyPlan.map((row) => row.detail).join("\n")
        expect(toolOnlyDetail).toContain("session_tool_recall_tool_time_idx")
        expect(toolOnlyDetail).not.toContain("USE TEMP B-TREE")
        expect(toolOnlyDetail).not.toContain("session_message")

        const scopedToolOnlyPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT t.id
          FROM session s
          CROSS JOIN session_tool_recall t INDEXED BY session_tool_recall_session_tool_time_idx
          WHERE t.session_id = s.id
            AND t.tool = 'read'
            AND s.directory = '/project'
          ORDER BY t.time_created DESC, t.id DESC
          LIMIT 11
        `)
        const scopedToolOnlyDetail = scopedToolOnlyPlan.map((row) => row.detail).join("\\n")
        expect(scopedToolOnlyDetail).toContain("session_directory_idx")
        expect(scopedToolOnlyDetail).toContain("session_tool_recall_session_tool_time_idx")
        expect(scopedToolOnlyDetail).not.toContain("session_message")

        const combinedPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT t.id
          FROM session_tool_recall_fts
          JOIN session_tool_recall t ON t.id = session_tool_recall_fts.rowid
          JOIN session s ON s.id = t.session_id
          WHERE session_tool_recall_fts MATCH 'AGENTS*'
            AND t.tool = 'read'
          ORDER BY rank
          LIMIT 11
        `)
        const combinedDetail = combinedPlan.map((row) => row.detail).join("\n")
        expect(combinedDetail).toContain("session_tool_recall_fts")
        expect(combinedDetail).toContain("VIRTUAL TABLE")
        expect(combinedDetail).not.toContain("session_message")
        expect(combinedDetail).not.toContain("part_fts")

        yield* db.delete(PartTable).where(sql`${PartTable.id} = ${SessionV1.PartID.make("prt_real_tool")}`).run()
        yield* db
          .delete(SessionMessageTable)
          .where(sql`${SessionMessageTable.id} = ${SessionMessage.ID.make("msg_v2_real_tool")}`)
          .run()
        const remaining = yield* db
          .select({ partID: SessionToolRecallTable.part_id })
          .from(SessionToolRecallTable)
          .all()
        expect(remaining.map((row) => row.partID)).not.toContain("prt_real_tool")
        expect(remaining.map((row) => row.partID)).not.toContain("tool_real")
        // Parent-delete triggers must remove the external-content FTS posting
        // as well as the compact relational row. No query-time orphan scan.
        const deleted = yield* SessionRecall.recall(db, { tool: "read", query: "AGENTS", limit: 10 })
        expect(deleted.toolMatches).toEqual([])
        expect(deleted.coverage.complete).toBe(true)
      }),
    )
  })


  test("honors recent versus relevance ordering for exact tool recall", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_recall_tool_ranking")

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
            slug: "recall-tool-ranking",
            directory: "/project",
            title: "Recall tool ranking",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        const makeToolMessage = (id: string, created: number, path: string) =>
          SessionMessage.Assistant.make({
            id: SessionMessage.ID.make(id),
            type: "assistant",
            agent: "build",
            model,
            content: [{
              type: "tool",
              id: `tool_${id}`,
              name: "read",
              state: {
                status: "completed",
                input: { path },
                content: [],
                structured: {},
              },
              time: { created: DateTime.makeUnsafe(created) },
            }],
            time: { created: DateTime.makeUnsafe(created) },
          })

        const olderRelevant = makeToolMessage("msg_tool_rank_old", 100, "needle")
        const newerVerbose = makeToolMessage(
          "msg_tool_rank_new",
          200,
          `needle ${"filler ".repeat(80)}`,
        )
        for (const [seq, message] of [olderRelevant, newerVerbose].entries()) {
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

        const sidecarRepair = yield* SessionSearch.repairChunk(db, { maxRows: 8 })
        expect(sidecarRepair.toolRecallV2).toEqual({ processed: 2, projected: 2, done: true })

        const recent = yield* SessionRecall.recall(db, {
          query: "needle",
          tool: "read",
          ranking: "recent",
          limit: 2,
        })
        expect(recent.toolMatches.map((hit) => hit.messageID)).toEqual([
          "msg_tool_rank_new",
          "msg_tool_rank_old",
        ])

        const relevance = yield* SessionRecall.recall(db, {
          query: "needle",
          tool: "read",
          ranking: "relevance",
          limit: 2,
        })
        expect(relevance.toolMatches.map((hit) => hit.messageID)).toEqual([
          "msg_tool_rank_old",
          "msg_tool_rank_new",
        ])
      }),
    )
  })

  test("keeps producer-projected truth authoritative over stale historical repair rows", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_tool_recall_race")
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
            slug: "tool-recall-race",
            directory: "/project",
            title: "Tool recall race",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        const identity = {
          source: "v2_message" as const,
          session_id: sessionID,
          message_id: "msg_race",
          part_id: "tool_race",
        }
        yield* SessionToolRecall.upsert(db, {
          ...identity,
          tool: "read",
          time_created: 200,
          search_text: "producer fresh needle",
        })
        yield* SessionToolRecall.insertHistoricalRowsIfAbsent(db, [{
          ...identity,
          tool: "write",
          time_created: 100,
          search_text: "stale repair payload",
        }])

        const row = yield* db
          .select()
          .from(SessionToolRecallTable)
          .where(sql`${SessionToolRecallTable.part_id} = ${identity.part_id}`)
          .get()
          .pipe(Effect.orDie)
        expect(row).toMatchObject({
          tool: "read",
          time_created: 200,
          search_text: "producer fresh needle",
        })
        const ftsFresh = yield* db.get<{ count: number }>(sql`
          SELECT count(*) AS count
          FROM session_tool_recall_fts
          WHERE session_tool_recall_fts MATCH 'producer*'
        `)
        const ftsStale = yield* db.get<{ count: number }>(sql`
          SELECT count(*) AS count
          FROM session_tool_recall_fts
          WHERE session_tool_recall_fts MATCH 'stale*'
        `)
        expect(ftsFresh).toEqual({ count: 1 })
        expect(ftsStale).toEqual({ count: 0 })
      }),
    )
  })

  test("does not resurrect deleted or type-replaced tool sources during historical repair", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_tool_recall_source_race")
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
            slug: "tool-recall-source-race",
            directory: "/project",
            title: "Tool recall source race",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        const v1MessageID = SessionV1.MessageID.make("msg_source_race_v1")
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
        const v1PartID = SessionV1.PartID.make("prt_source_race_v1")
        yield* db
          .insert(PartTable)
          .values({
            id: v1PartID,
            message_id: v1MessageID,
            session_id: sessionID,
            time_created: 10,
            data: { type: "tool", tool: "read", state: { input: { path: "old" } } } as never,
            search_text: "tool:read {path:old}",
          })
          .run()
          .pipe(Effect.orDie)
        const staleV1: SessionToolRecall.Row = {
          source: "v1_part",
          session_id: sessionID,
          message_id: String(v1MessageID),
          part_id: String(v1PartID),
          tool: "read",
          time_created: 10,
          search_text: "path old",
        }
        yield* db
          .update(PartTable)
          .set({ data: { type: "text", text: "replaced" } as never, search_text: "replaced" })
          .where(sql`${PartTable.id} = ${v1PartID}`)
          .run()
          .pipe(Effect.orDie)
        yield* SessionToolRecall.insertHistoricalRowsIfAbsent(db, [staleV1])

        const v2Message = SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_source_race_v2"),
          type: "assistant",
          agent: "build",
          model,
          content: [{
            type: "tool",
            id: "tool_source_race_v2",
            name: "read",
            state: { status: "completed", input: { path: "old" }, content: [], structured: {} },
            time: { created: DateTime.makeUnsafe(20) },
          }],
          time: { created: DateTime.makeUnsafe(20) },
        })
        const encodedV2 = encodeMessage(v2Message)
        const { id: v2ID, type: v2Type, ...v2Data } = encodedV2
        yield* db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make(v2ID),
            session_id: sessionID,
            type: v2Type,
            seq: 1,
            time_created: 20,
            data: v2Data,
            search_text: searchText(v2Message),
          })
          .run()
          .pipe(Effect.orDie)
        const staleV2 = SessionToolRecall.fromV2Message(sessionID, v2Message)
        yield* db
          .delete(SessionMessageTable)
          .where(sql`${SessionMessageTable.id} = ${v2Message.id}`)
          .run()
          .pipe(Effect.orDie)
        yield* SessionToolRecall.insertHistoricalRowsIfAbsent(db, staleV2)

        expect(yield* db.select().from(SessionToolRecallTable).all()).toEqual([])
      }),
    )
  })

  test("keeps exact punctuated tool identity outside FTS tokenization", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_tool_recall_punctuation")
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
            slug: "tool-recall-punctuation",
            directory: "/project",
            title: "Tool recall punctuation",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        const tool = "mcp.foo/bar:v2"
        yield* SessionToolRecall.upsert(db, {
          source: "v2_message",
          session_id: sessionID,
          message_id: "msg_punctuation",
          part_id: "tool_punctuation",
          tool,
          time_created: 10,
          search_text: "bounded needle payload",
        })
        for (const source of ["v1_part", "v2_message"] as const) {
          yield* db
            .insert(SessionToolRecallBackfillTable)
            .values({ source, watermark_rowid: 0, done: 1 })
            .onConflictDoUpdate({
              target: SessionToolRecallBackfillTable.source,
              set: { done: 1 },
            })
            .run()
            .pipe(Effect.orDie)
        }

        const combined = yield* SessionRecall.recall(db, { tool, query: "needle", limit: 5 })
        expect(combined.toolMatches).toMatchObject([{ tool, partID: "tool_punctuation" }])

        const identityOnlyQuery = yield* SessionRecall.recall(db, { tool, query: "mcp", limit: 5 })
        expect(identityOnlyQuery.toolMatches).toEqual([])

        const exactOnly = yield* SessionRecall.recall(db, { tool, limit: 5 })
        expect(exactOnly.toolMatches).toMatchObject([{ tool, partID: "tool_punctuation" }])

        const symbolOnly = yield* SessionRecall.recall(db, { tool, query: "%%%", limit: 5 })
        expect(symbolOnly.toolMatches).toEqual([])
      }),
    )
  })

  test("keeps tool-only recall index-streamed and reports exact sidecar truncation", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_recall_tool_index")
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
            slug: "recall-tool-index",
            directory: "/project",
            title: "Recall tool index",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        yield* db
          .insert(SessionToolRecallTable)
          .values([1, 2, 3].map((time) => ({
            source: "v2_message" as const,
            session_id: sessionID,
            message_id: `msg_sidecar_${time}`,
            part_id: `tool_sidecar_${time}`,
            tool: "read",
            time_created: time,
            search_text: `needle sidecar ${time}`,
          })))
          .run()
          .pipe(Effect.orDie)
        for (const source of ["v1_part", "v2_message"] as const) {
          yield* db
            .insert(SessionToolRecallBackfillTable)
            .values({ source, watermark_rowid: 3, done: 1 })
            .onConflictDoUpdate({
              target: SessionToolRecallBackfillTable.source,
              set: { watermark_rowid: 3, done: 1 },
            })
            .run()
            .pipe(Effect.orDie)
        }

        const result = yield* SessionRecall.recall(db, { tool: "read", limit: 1 })
        expect(result.toolMatches.map((hit) => hit.partID)).toEqual(["tool_sidecar_3"])
        expect(result.coverage.toolResultsTruncated).toBe(true)
        expect(result.coverage.complete).toBe(true)

        const plan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT t.id
          FROM session_tool_recall t INDEXED BY session_tool_recall_tool_time_idx
          JOIN session s ON s.id = t.session_id
          WHERE t.tool = 'read'
          ORDER BY t.time_created DESC, t.id DESC
          LIMIT 2
        `)
        expect(plan.some((row) => row.detail.includes("session_tool_recall_tool_time_idx"))).toBe(true)
        expect(plan.some((row) => row.detail.includes("USE TEMP B-TREE"))).toBe(false)

        const queryPlan = yield* db.all<{ detail: string }>(sql`
          EXPLAIN QUERY PLAN
          SELECT t.id
          FROM session_tool_recall_fts
          CROSS JOIN session_tool_recall t NOT INDEXED
            ON t.id = session_tool_recall_fts.rowid
          JOIN session s ON s.id = t.session_id
          WHERE session_tool_recall_fts MATCH 'needle*'
            AND t.tool = 'read'
          ORDER BY t.time_created DESC, t.id DESC
          LIMIT 2
        `)
        expect(queryPlan.some((row) => row.detail.includes("session_tool_recall_fts VIRTUAL TABLE"))).toBe(true)
        expect(queryPlan.some((row) => row.detail.includes("INTEGER PRIMARY KEY"))).toBe(true)
        expect(queryPlan.some((row) => row.detail.includes("session_tool_recall_tool_time_idx"))).toBe(false)
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

        yield* SessionSearch.repairChunk(db, { maxRows: 8 })

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
          // Tool-recall cursors advance over bounded physical rows. Wide JSON is
          // loaded only for plausible tool-bearing rows inside that bounded page.
          toolRecallV1: { processed: 1, projected: 0, done: true },
          toolRecallV2: { processed: 1, projected: 0, done: true },
        })
        const repaired = yield* SessionRecall.recall(db, { query: "needle", limit: 10 })
        expect(repaired.messageMatches).toHaveLength(2)
        expect(repaired.partMatches).toMatchObject([{ partID: "prt_repair_chunk", partType: "text" }])
        expect(repaired.coverage.complete).toBe(true)
        expect(repaired.coverage.v2ToolIndexReady).toBe(true)
      }),
    )
  })

  test("bounds exact-tool historical repair by physical rows even when tools are sparse", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessionID = SessionSchema.ID.make("ses_sparse_tool_repair")
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
            slug: "sparse-tool-repair",
            directory: "/project",
            title: "Sparse tool repair",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        const v1MessageID = SessionV1.MessageID.make("msg_sparse_v1")
        yield* db
          .insert(MessageTable)
          .values({
            id: v1MessageID,
            session_id: sessionID,
            time_created: 1,
            data: { role: "assistant", time: { created: 1 } } as never,
          })
          .run()
          .pipe(Effect.orDie)

        for (let index = 1; index <= 8; index++) {
          const part = SessionV1.TextPart.make({
            id: SessionV1.PartID.make(`prt_sparse_${index}`),
            sessionID,
            messageID: v1MessageID,
            type: "text",
            text: `ordinary text ${index}`,
            time: { start: index },
          })
          const { id, messageID, sessionID: _, ...data } = part
          yield* db
            .insert(PartTable)
            .values({
              id,
              message_id: messageID,
              session_id: sessionID,
              time_created: index,
              data: data as never,
              search_text: partSearchText(part),
            })
            .run()
            .pipe(Effect.orDie)

          const message = SessionMessage.User.make({
            id: SessionMessage.ID.make(`msg_sparse_v2_${index}`),
            type: "user",
            text: `ordinary user message ${index}`,
            time: { created: DateTime.makeUnsafe(index) },
          })
          const encoded = encodeMessage(message)
          const { id: messageIDV2, type, ...messageData } = encoded
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make(messageIDV2),
              session_id: sessionID,
              type,
              seq: index,
              time_created: index,
              data: messageData,
              search_text: searchText(message),
            })
            .run()
            .pipe(Effect.orDie)
        }

        const first = yield* SessionSearch.repairChunk(db, { maxRows: 3 })
        expect(first.toolRecallV1).toEqual({ processed: 3, projected: 0, done: false })
        expect(first.toolRecallV2).toEqual({ processed: 3, projected: 0, done: false })
        const second = yield* SessionSearch.repairChunk(db, { maxRows: 3 })
        expect(second.toolRecallV1).toEqual({ processed: 3, projected: 0, done: false })
        expect(second.toolRecallV2).toEqual({ processed: 3, projected: 0, done: false })
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
          .values({ id: 2, watermark_rowid: -1, done: 1 })
          .onConflictDoUpdate({ target: PartSearchBackfillTable.id, set: { done: 1 } })
          .run()
          .pipe(Effect.orDie)

        const before = yield* SessionRecall.recall(db, { tool: "read", limit: 5 })
        expect(before.toolMatches).toEqual([])
        expect(before.coverage.v2MessageIndexReady).toBe(true)
        expect(before.coverage.v2ToolIndexReady).toBe(false)
        expect(before.coverage.v2ToolRecallReady).toBe(false)
        // Ordinary recall never decodes historical message JSON to compensate
        // for an incomplete exact-tool projection. Explicit repair owns it.
        expect(before.coverage.complete).toBe(false)

        const progress = yield* SessionSearch.repairChunk(db, { maxRows: 8 })
        expect(progress.sessionMessages).toEqual({ processed: 1, done: true })
        expect(progress.toolRecallV2).toEqual({ processed: 1, projected: 1, done: true })

        const row = yield* db
          .select({ searchText: SessionMessageTable.search_text })
          .from(SessionMessageTable)
          .where(sql`${SessionMessageTable.id} = ${SessionMessage.ID.make("msg_tool_marker_upgrade")}`)
          .get()
        expect(row?.searchText).toContain("tool:read")

        const after = yield* SessionRecall.recall(db, { tool: "read", limit: 5 })
        expect(after.toolMatches).toMatchObject([{ source: "v2_message", partID: "tool_marker_upgrade" }])
        expect(after.coverage.v2ToolIndexReady).toBe(true)
        expect(after.coverage.v1ToolRecallReady).toBe(true)
        expect(after.coverage.v2ToolRecallReady).toBe(true)
        expect(after.coverage.complete).toBe(true)
      }),
    )
  })

  test("keeps marker-like historical parts off the hot path until exact sidecar repair", async () => {
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
        expect(result.coverage.toolResultsTruncated).toBe(false)
        expect(result.coverage.v1ToolRecallReady).toBe(false)
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
