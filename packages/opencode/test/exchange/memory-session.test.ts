import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { searchText } from "@opencode-ai/core/session/search-text"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ExchangeMemorySession } from "@/exchange/memory-session"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

describe("ExchangeMemorySession indexed evidence", () => {
  test("diversifies Sessions without fabricating rankings or repeating title-only evidence", () => {
    const hit = (sessionId: string, age: number, source: "conversation" | "title" = "conversation") => ({
      source, sessionId,
      ...(source === "conversation" ? { messageId: `msg_${sessionId}_${age}` } : {}),
      title: `Session ${sessionId}`, snippet: "test", occurredAt: age,
      occurredAtIso: new Date(age).toISOString(),
      timeBasis: source === "conversation" ? "message_created" as const : "session_record_updated" as const,
    })
    const candidates = [
      hit("a", 500), hit("a", 490), hit("a", 480), hit("b", 470),
      hit("a", 460, "title"), hit("c", 450), hit("b", 440, "title"),
    ]
    expect(ExchangeMemorySession.selectDiverse(candidates, 3).map((x) => x.sessionId))
      .toEqual(["a", "b", "c"])
    expect(ExchangeMemorySession.selectDiverse(candidates, 4).map((x) => x.sessionId))
      .toEqual(["a", "a", "b", "c"])
    expect(ExchangeMemorySession.selectDiverse(candidates, 10).every((x) => x.source === "conversation"))
      .toBe(true)
  })
  it.effect("scopes before recency ranking and returns compact, limited hits", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.insert(ProjectTable).values({
        id: ProjectV2.ID.global,
        worktree: AbsolutePath.make("/approved"),
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      const fixtures = [
        { id: "ses_memory_old", dir: "/approved/old", at: 100 },
        { id: "ses_memory_new", dir: "/approved/new", at: 200 },
        { id: "ses_memory_forbidden", dir: "/different/place", at: 999 },
      ] as const
      for (const fixture of fixtures) {
        yield* db.insert(SessionTable).values({
          id: SessionSchema.ID.make(fixture.id),
          project_id: ProjectV2.ID.global,
          slug: fixture.id,
          directory: fixture.dir,
          title: "Unrelated session title",
          version: "test",
          time_created: fixture.at,
          time_updated: fixture.at,
        }).run().pipe(Effect.orDie)
        const message = SessionMessage.User.make({
          id: SessionMessage.ID.make(`msg_${fixture.id}`),
          type: "user",
          text: `needle from ${fixture.id}`,
          time: { created: DateTime.makeUnsafe(fixture.at) },
        })
        const { id, type, ...data } = encodeMessage(message)
        yield* db.insert(SessionMessageTable).values({
          id: SessionMessage.ID.make(id),
          session_id: SessionSchema.ID.make(fixture.id),
          type,
          seq: 1,
          time_created: fixture.at,
          data,
          search_text: searchText(message),
        }).run().pipe(Effect.orDie)
      }
      const limited = yield* ExchangeMemorySession.search(db, {
        query: "needle",
        limit: 1,
        directoryPrefixes: ["/approved"],
      })
      expect(limited.hits).toHaveLength(1)
      expect(limited.hits[0]).toMatchObject({
        sessionId: "ses_memory_new",
        source: "conversation",
        occurredAt: 200,
        timeBasis: "message_created",
      })
      const all = yield* ExchangeMemorySession.search(db, {
        query: "needle",
        limit: 3,
        directoryPrefixes: ["/approved"],
      })
      expect(all.hits.map((hit) => hit.sessionId)).toEqual(["ses_memory_new", "ses_memory_old"])
      expect(JSON.stringify(all)).not.toContain("ses_memory_forbidden")
      expect(JSON.stringify(all)).not.toContain("/approved")
      expect(typeof all.indexCoverage?.v1PartIndexReady).toBe("boolean")
      expect(typeof all.indexCoverage?.v2MessageIndexReady).toBe("boolean")
    }),
  )
  it.effect("oversamples bounded candidates to surface an older independent Session", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.insert(ProjectTable).values({
        id: ProjectV2.ID.global,
        worktree: AbsolutePath.make("/approved"),
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      for (const [id, at] of [["ses_dense", 600], ["ses_independent", 100]] as const) {
        yield* db.insert(SessionTable).values({
          id: SessionSchema.ID.make(id),
          project_id: ProjectV2.ID.global,
          slug: id,
          directory: "/approved/workspace",
          title: "Unrelated session title",
          version: "test",
          time_created: at,
          time_updated: at,
        }).run().pipe(Effect.orDie)
      }
      for (const fixture of [
        { session: "ses_dense", at: 600, seq: 4 },
        { session: "ses_dense", at: 500, seq: 3 },
        { session: "ses_dense", at: 400, seq: 2 },
        { session: "ses_dense", at: 300, seq: 1 },
        { session: "ses_independent", at: 100, seq: 1 },
      ]) {
        const message = SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_" + fixture.session + "_" + fixture.seq),
          type: "user",
          text: "vectorization evidence " + fixture.session + " " + fixture.seq,
          time: { created: DateTime.makeUnsafe(fixture.at) },
        })
        const { id, type, ...data } = encodeMessage(message)
        yield* db.insert(SessionMessageTable).values({
          id: SessionMessage.ID.make(id),
          session_id: SessionSchema.ID.make(fixture.session),
          type,
          seq: fixture.seq,
          time_created: fixture.at,
          data,
          search_text: searchText(message),
        }).run().pipe(Effect.orDie)
      }
      const result = yield* ExchangeMemorySession.search(db, {
        query: "vectorization", limit: 2, directoryPrefixes: ["/approved"],
      })
      expect(result.hits.map((x) => x.sessionId)).toEqual(["ses_dense", "ses_independent"])
      expect(result.hits.every((x) => x.source === "conversation")).toBe(true)
      expect(result.truncated).toBe(true)
    }),
  )
})