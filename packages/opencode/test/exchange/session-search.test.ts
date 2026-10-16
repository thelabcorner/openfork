import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSearch } from "@opencode-ai/core/session/search"
import { searchText } from "@opencode-ai/core/session/search-text"
import {
  PartSearchBackfillTable,
  SearchBackfillTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { ExchangeSessionSearch } from "@/exchange/session-search"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const model = { id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }

describe("ExchangeSessionSearch", () => {
  it.effect("projects directories after pre-ranked root scoping and revalidates before egress", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = SessionSchema.ID.make("ses_exchange_search")

      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/native/root"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "exchange-search",
          directory: "/native/root/project",
          title: "Needle exchange session",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const message = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_exchange_search"),
        type: "user",
        text: "needle content in the authorized session",
        time: { created: DateTime.makeUnsafe(1) },
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
          time_created: 1,
          data,
          search_text: searchText(message),
        })
        .run()
        .pipe(Effect.orDie)

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

      let revalidated = 0
      const result = yield* ExchangeSessionSearch.execute(
        db,
        {
          query: "needle",
          directoryPrefixes: ["/native/root"],
          includeArchived: false,
          scopeLabel: "root:test",
          limit: 10,
        },
        {
          revalidate: () => Effect.sync(() => {
            revalidated++
          }),
          projectDirectory: (directory) => {
            if (!directory.startsWith("/native/root")) throw new Error("outside root")
            return "/remote" + directory.slice("/native/root".length)
          },
        },
      )

      expect(revalidated).toBe(1)
      expect(result.mutation).toEqual({ attempted: false, committed: false })
      expect(result.metadata).toMatchObject({
        count: 1,
        titleHits: 1,
        contentHits: 1,
        partHits: 0,
        toolHits: 0,
      })
      expect(result.output).not.toContain("/native/root")
      expect(result.output).toContain("/remote/project")
      expect(result.structured).toMatchObject({
        scope: "root:test",
        temporal: {
          ranking: "recent",
          newestFirst: true,
          retrievedAt: expect.any(Number),
          retrievedAtIso: expect.any(String),
        },
        coverage: expect.any(Object),
        sessions: [
          {
            sessionId: "ses_exchange_search",
            directory: "/remote/project",
            matchedBy: ["title", "content"],
            latestAt: expect.any(Number),
            latestAtIso: expect.any(String),
          },
        ],
      })
    }),
  )

  it.effect("keeps exact tool evidence routable when another channel saturates the compact session limit", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/native/root"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)

      const titleOnly = SessionSchema.ID.make("ses_exchange_title_only")
      const toolSession = SessionSchema.ID.make("ses_exchange_tool")
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: titleOnly,
            project_id: ProjectV2.ID.global,
            slug: "title-only",
            directory: "/native/root/title",
            title: "Needle title only",
            version: "test",
            time_created: 200,
            time_updated: 200,
          },
          {
            id: toolSession,
            project_id: ProjectV2.ID.global,
            slug: "tool-session",
            directory: "/native/root/tool",
            title: "Tool session",
            version: "test",
            time_created: 100,
            time_updated: 100,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const message = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_exchange_tool"),
        type: "assistant",
        agent: "build",
        model,
        content: [{
          type: "tool",
          id: "tool_exchange_read",
          name: "read",
          state: {
            status: "completed",
            input: { path: "needle.txt" },
            content: [],
            structured: {},
          },
          time: { created: DateTime.makeUnsafe(100) },
        }],
        time: { created: DateTime.makeUnsafe(100) },
      })
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: toolSession,
          type,
          seq: 1,
          time_created: 100,
          data,
          search_text: searchText(message),
        })
        .run()
        .pipe(Effect.orDie)

      yield* db
        .insert(SearchBackfillTable)
        .values([
          { id: 1, watermark_rowid: 1, done: 1 },
          { id: 2, watermark_rowid: 1, done: 1 },
        ])
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartSearchBackfillTable)
        .values({ id: 1, watermark_rowid: -1, done: 1 })
        .onConflictDoUpdate({ target: PartSearchBackfillTable.id, set: { done: 1 } })
        .run()
        .pipe(Effect.orDie)

      // Direct fixture inserts intentionally bypass SessionProjector; converge
      // the exact-tool sidecar explicitly rather than relying on reader decode.
      yield* SessionSearch.repairChunk(db, { maxRows: 16 })

      const result = yield* ExchangeSessionSearch.execute(db, {
        query: "needle",
        tool: "read",
        ranking: "relevance",
        directoryPrefixes: ["/native/root"],
        includeArchived: false,
        limit: 1,
      })

      expect(result.structured).toMatchObject({
        sessions: [{
          sessionId: "ses_exchange_tool",
          matchedBy: expect.arrayContaining(["content", "tool"]),
        }],
      })
      expect(result.metadata.toolHits).toBe(1)
      expect(result.metadata.truncated).toBe(true)
    }),
  )

  it.effect("defaults recall routing to newest matching evidence and allows relevance override", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/native/root"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)

      yield* db.insert(SessionTable).values([
        {
          id: SessionSchema.ID.make("ses_temporal_old"),
          project_id: ProjectV2.ID.global,
          slug: "temporal-old",
          directory: "/native/root/old",
          title: "Needle old corroborated",
          version: "test",
          time_created: 100,
          // Simulate a much later metadata-only record touch; it must not
          // masquerade as fresh matching conversation evidence.
          time_updated: 10_000,
        },
        {
          id: SessionSchema.ID.make("ses_temporal_new"),
          project_id: ProjectV2.ID.global,
          slug: "temporal-new",
          directory: "/native/root/new",
          title: "New session",
          version: "test",
          time_created: 200,
          time_updated: 200,
        },
      ]).run().pipe(Effect.orDie)

      const oldMessage = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_temporal_old"),
        type: "user",
        text: "needle corroborating content",
        time: { created: DateTime.makeUnsafe(100) },
      })
      const encoded = encodeMessage(oldMessage)
      const { id, type, ...data } = encoded
      yield* db.insert(SessionMessageTable).values({
        id: SessionMessage.ID.make(id),
        session_id: SessionSchema.ID.make("ses_temporal_old"),
        type,
        seq: 1,
        time_created: 100,
        data,
        search_text: searchText(oldMessage),
      }).run().pipe(Effect.orDie)

      const newMessage = SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_temporal_new"),
        type: "user",
        text: "needle newer content",
        time: { created: DateTime.makeUnsafe(200) },
      })
      const encodedNew = encodeMessage(newMessage)
      const { id: newID, type: newType, ...newData } = encodedNew
      yield* db.insert(SessionMessageTable).values({
        id: SessionMessage.ID.make(newID),
        session_id: SessionSchema.ID.make("ses_temporal_new"),
        type: newType,
        seq: 1,
        time_created: 200,
        data: newData,
        search_text: searchText(newMessage),
      }).run().pipe(Effect.orDie)

      yield* db.insert(SearchBackfillTable)
        .values({ id: 1, watermark_rowid: -1, done: 1 })
        .onConflictDoUpdate({ target: SearchBackfillTable.id, set: { done: 1 } })
        .run().pipe(Effect.orDie)
      yield* db.insert(PartSearchBackfillTable)
        .values({ id: 1, watermark_rowid: -1, done: 1 })
        .onConflictDoUpdate({ target: PartSearchBackfillTable.id, set: { done: 1 } })
        .run().pipe(Effect.orDie)

      const recent = yield* ExchangeSessionSearch.execute(db, {
        query: "needle",
        directoryPrefixes: ["/native/root"],
        includeArchived: false,
        limit: 1,
      })
      expect(((recent.structured.hits as { content: Array<{ sessionId: string }> }).content)[0]?.sessionId)
        .toBe("ses_temporal_new")
      expect((recent.structured.sessions as Array<{ sessionId: string }>)[0]?.sessionId).toBe("ses_temporal_new")
      expect(recent.metadata.candidateLimit).toBe(1)
      expect((recent.structured.hits as { content: unknown[] }).content).toHaveLength(1)

      const relevance = yield* ExchangeSessionSearch.execute(db, {
        query: "needle",
        ranking: "relevance",
        directoryPrefixes: ["/native/root"],
        includeArchived: false,
        limit: 1,
      })
      expect((relevance.structured.sessions as Array<{ sessionId: string }>)[0]?.sessionId).toBe("ses_temporal_old")
    }),
  )
})

