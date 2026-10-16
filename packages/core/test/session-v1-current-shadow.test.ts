import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageID, PartID, SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  MessageTable, PartTable, SessionMessageTable, SessionTable,
  SessionV1ShadowCursorTable, SessionV1ShadowTable,
} from "@opencode-ai/core/session/sql"
import { V1CurrentShadow } from "@opencode-ai/core/session/v1-current-shadow"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))
const sid = SessionSchema.ID.make("ses_shadow_test")
const uid = MessageID.make("msg_shadow_user")
const aid = MessageID.make("msg_shadow_assistant")
const toolID = PartID.make("prt_shadow_tool")
const modelID = ModelV2.ID.make("test-model")
const providerID = ProviderV2.ID.make("test-provider")

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({
    id: Project.ID.global, worktree: AbsolutePath.make("/shadow"), sandboxes: [],
  }).onConflictDoNothing().run()
  yield* db.insert(SessionTable).values({
    id: sid, project_id: Project.ID.global,
    slug: "shadow", directory: "/shadow", title: "shadow", version: "test",
  }).run()
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sid, seq: 12 }).run()
  yield* db.insert(MessageTable).values({
    id: uid, session_id: sid, time_created: 1, time_updated: 1,
    data: SessionV1.User.make({
      id: uid, sessionID: sid, role: "user", time: { created: 1 },
      agent: "build", model: { modelID, providerID },
    }) as never,
  }).run()
  yield* db.insert(MessageTable).values({
    id: aid, session_id: sid, time_created: 2, time_updated: 2,
    data: SessionV1.Assistant.make({
      id: aid, sessionID: sid, role: "assistant", time: { created: 2 },
      parentID: uid, modelID, providerID, agent: "build", mode: "build",
      path: { cwd: "/shadow", root: "/shadow" }, cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }) as never,
  }).run()
  yield* db.insert(PartTable).values({
    id: toolID, session_id: sid, message_id: aid, time_created: 2, time_updated: 2,
    data: {
      type: "tool", callID: "call_shadow", tool: "bash",
      state: { status: "completed", input: { command: "pwd" }, output: "OLD",
        title: "shell", metadata: {}, time: { start: 2, end: 3 } },
    } as never,
  }).run()
  return db
})

const updateOutput = (db: Database.Interface["db"], output: string) =>
  db.update(PartTable).set({
    data: {
      type: "tool", callID: "call_shadow", tool: "bash",
      state: { status: "completed", input: { command: "pwd" }, output,
        title: "shell", metadata: {}, time: { start: 2, end: 3 } },
    } as never,
  }).where(eq(PartTable.id, toolID)).run()

describe("durable V1→V2 shadow projection (no authority switch)", () => {
  test("survives SQLite close/reopen and independent background connection; source deletion cascades", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-v1-shadow-restart-"))
    const filename = join(dir, "shadow.sqlite")
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.insert(ProjectTable).values({
          id: Project.ID.global, worktree: AbsolutePath.make("/shadow-file"), sandboxes: [],
        }).onConflictDoNothing().run()
        yield* db.insert(SessionTable).values({
          id: sid, project_id: Project.ID.global, slug: "file-shadow",
          directory: "/shadow-file", title: "file-shadow", version: "test",
        }).run()
        yield* db.insert(MessageTable).values({
          id: uid, session_id: sid,
          data: SessionV1.User.make({
            id: uid, sessionID: sid, role: "user", time: { created: 1 },
            agent: "build", model: { modelID, providerID },
          }) as never,
        }).run()
        const first = yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: uid })
        expect(first).toMatchObject({ status: "written" })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped))

      // Reopen via an independent process-lifetime connection to prove actual
      // persistence, not just memory-visible transaction effects.
      await Effect.runPromise(Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(yield* V1CurrentShadow.readVerified(db, { sessionID: sid, messageID: uid }))
          .toMatchObject({ status: "verified", cutoverSafe: false })
        expect(yield* V1CurrentShadow.scanOnOwnConnection(filename, { sessionID: sid, limit: 1 }))
          .toMatchObject({ status: "ok", complete: true, scanned: 1, written: 0 })
        expect((yield* db.select().from(SessionV1ShadowCursorTable)
          .where(eq(SessionV1ShadowCursorTable.session_id, sid)).get())?.complete).toBe(true)
        yield* db.delete(MessageTable).where(eq(MessageTable.id, uid)).run()
        expect(yield* db.select().from(SessionV1ShadowTable)
          .where(eq(SessionV1ShadowTable.message_id, uid)).get()).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  it.effect("persists compact wire, verifies against V1 and rejects stale same-ID part edits", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const first = yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: aid })
      expect(first).toMatchObject({ status: "written" })
      expect(yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "unchanged" })
      const stored = yield* db.select().from(SessionV1ShadowTable)
        .where(eq(SessionV1ShadowTable.message_id, aid)).get()
      expect(stored).toMatchObject({
        message_id: aid, session_id: sid, source_event_seq: 12,
      })
      expect(JSON.stringify(stored?.wire).includes("OLD")).toBe(true)
      const good = yield* V1CurrentShadow.readVerified(db, { sessionID: sid, messageID: aid })
      expect(good.status).toBe("verified")
      if (good.status !== "verified") throw new Error("Expected verified shadow")
      expect(good.cutoverSafe).toBe(false)
      expect((good.message.parts[0] as SessionV1.ToolPart).state.status).toBe("completed")
      expect(yield* db.select().from(SessionMessageTable).all()).toEqual([])
      yield* updateOutput(db, "CHANGED")
      expect(yield* V1CurrentShadow.readVerified(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "stale" })
      expect(yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "written" })
      const refreshed = yield* V1CurrentShadow.readVerified(db, { sessionID: sid, messageID: aid })
      expect(refreshed).toMatchObject({ status: "verified" })
      if (refreshed.status !== "verified") throw new Error("Expected refreshed shadow")
      const tool = refreshed.message.parts[0] as SessionV1.ToolPart
      expect(tool.state.status).toBe("completed")
      if (tool.state.status !== "completed") throw new Error("Expected completed")
      expect(tool.state.output).toBe("CHANGED")

      // Event drift invalidates the read even if canonical JSON is unchanged.
      yield* db.update(EventSequenceTable).set({ seq: 13 })
        .where(eq(EventSequenceTable.aggregate_id, sid)).run()
      expect(yield* V1CurrentShadow.readVerified(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "stale" })
      expect(yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "written" })
      yield* db.update(SessionV1ShadowTable).set({ wire_hash: "0".repeat(64) })
        .where(eq(SessionV1ShadowTable.message_id, aid)).run()
      expect(yield* V1CurrentShadow.readVerified(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "corrupt" })
      expect(yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "written" })
      expect(yield* V1CurrentShadow.readVerified(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "verified" })
    }),
  )

  it.effect("refuses commit when the event generation advances during lowering", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const raced = yield* V1CurrentShadow.projectOne(db, {
        sessionID: sid, messageID: aid,
        beforeCommit: () => db.update(EventSequenceTable).set({ seq: 13 })
          .where(eq(EventSequenceTable.aggregate_id, sid))
          .run().pipe(Effect.asVoid, Effect.orDie),
      })
      expect(raced).toMatchObject({ status: "stale" })
      expect(yield* db.select().from(SessionV1ShadowTable).all()).toEqual([])
      expect(yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "written" })
      expect((yield* db.select().from(SessionV1ShadowTable)
        .where(eq(SessionV1ShadowTable.message_id, aid)).get())?.source_event_seq).toBe(13)
    }),
  )

  it.effect("fails the CAS after an intervening producer mutation; no stale wire is written", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const raced = yield* V1CurrentShadow.projectOne(db, {
        sessionID: sid, messageID: aid,
        beforeCommit: () => updateOutput(db, "RACED").pipe(Effect.asVoid, Effect.orDie),
      })
      expect(raced).toMatchObject({ status: "stale" })
      expect(yield* db.select().from(SessionV1ShadowTable).all()).toEqual([])
      expect(yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "written" })
      const good = yield* V1CurrentShadow.readVerified(db, { sessionID: sid, messageID: aid })
      if (good.status !== "verified") throw new Error("Expected verified shadow")
      const tool = good.message.parts[0] as SessionV1.ToolPart
      if (tool.state.status !== "completed") throw new Error("Expected completed")
      expect(tool.state.output).toBe("RACED")
    }),
  )

  it.effect("resumes exact rowid cursor, handles a new insert and resets after event change", () =>
    Effect.gen(function* () {
      const db = yield* seed
      expect(yield* V1CurrentShadow.scanSlice(db, { sessionID: sid, limit: 1 }))
        .toMatchObject({ complete: false, status: "ok", scanned: 1, written: 1, cutoverSafe: false })
      const afterOne = yield* db.select().from(SessionV1ShadowCursorTable)
        .where(eq(SessionV1ShadowCursorTable.session_id, sid)).get()
      expect(afterOne?.complete).toBe(false)
      expect(yield* V1CurrentShadow.scanSlice(db, { sessionID: sid, limit: 1 }))
        .toMatchObject({ complete: true, scanned: 1, written: 1 })
      expect((yield* db.select().from(SessionV1ShadowTable).all()).length).toBe(2)
      const completed = yield* V1CurrentShadow.scanSlice(db, { sessionID: sid, limit: 1 })
      expect(completed).toMatchObject({ complete: true, scanned: 0 })
      // A direct import can add a new row without emitting an event. Monotonic
      // rowid scanning still discovers it after a previously complete cursor.
      const imported = MessageID.make("msg_shadow_imported")
      yield* db.insert(MessageTable).values({
        id: imported, session_id: sid, time_created: 0, time_updated: 0,
        data: SessionV1.User.make({
          id: imported, sessionID: sid, role: "user", time: { created: 0 },
          agent: "build", model: { modelID, providerID },
        }) as never,
      }).run()
      expect(yield* V1CurrentShadow.scanSlice(db, { sessionID: sid, limit: 2 }))
        .toMatchObject({ complete: true, scanned: 1, written: 1 })
      yield* db.update(EventSequenceTable).set({ seq: 14 })
        .where(eq(EventSequenceTable.aggregate_id, sid)).run()
      // New generation restarts from rowid zero and re-verifies prior shadows.
      expect(yield* V1CurrentShadow.scanSlice(db, { sessionID: sid, limit: 1 }))
        .toMatchObject({ complete: false, scanned: 1, written: 1 })
      expect((yield* db.select().from(SessionV1ShadowCursorTable)
        .where(eq(SessionV1ShadowCursorTable.session_id, sid)).get())?.source_event_seq).toBe(14)
      expect(yield* db.select().from(SessionMessageTable).all()).toEqual([])
    }),
  )

  it.effect("rejects missing ancestry and never persists invalid V1 source", () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db.delete(MessageTable).where(eq(MessageTable.id, uid)).run()
      expect(yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "blocked", reason: "orphan-parent" })
      expect(yield* db.select().from(SessionV1ShadowTable).all()).toEqual([])
      const corrupt = MessageID.make("msg_shadow_corrupt")
      yield* db.insert(MessageTable).values({
        id: corrupt, session_id: sid, data: { role: "not-a-role" } as never,
      }).run()
      const outcome = yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: corrupt })
        .pipe(Effect.exit)
      expect(Exit.isFailure(outcome)).toBe(true)
      expect(yield* db.select().from(SessionV1ShadowTable).all()).toEqual([])
    }),
  )

  it.effect("fails closed when a part references the message but has a foreign session owner", () =>
    Effect.gen(function* () {
      const db = yield* seed
      const foreign = SessionSchema.ID.make("ses_shadow_wrong_owner")
      yield* db.insert(PartTable).values({
        id: PartID.make("prt_shadow_foreign"),
        session_id: foreign, message_id: aid,
        data: { type: "text", text: "unowned" } as never,
      }).run()
      expect(yield* V1CurrentShadow.projectOne(db, { sessionID: sid, messageID: aid }))
        .toMatchObject({ status: "blocked", reason: "foreign-part-session" })
      expect(yield* db.select().from(SessionV1ShadowTable).all()).toEqual([])
    }),
  )
})
