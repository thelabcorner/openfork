import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageID, PartID, SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { V1CurrentReplay } from "@opencode-ai/core/session/v1-current-replay"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))
const sid = SessionSchema.ID.make("ses_replay_fixture")
const mid = MessageID.make("msg_replay_assistant")
const uid = MessageID.make("msg_replay_user")
const pid = PartID.make("prt_replay_tool")
const modelID = ModelV2.ID.make("local")
const providerID = ProviderV2.ID.make("provider")

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({
    id: Project.ID.global, worktree: AbsolutePath.make("/replay"), sandboxes: [],
  }).onConflictDoNothing().run()
  yield* db.insert(SessionTable).values({
    id: sid, project_id: Project.ID.global,
    slug: "replay", directory: "/replay", title: "replay", version: "test",
  }).run()
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sid, seq: 4 }).run()
  const user = SessionV1.User.make({
    id: uid, sessionID: sid, role: "user", time: { created: 1 },
    agent: "build", model: { modelID, providerID },
  })
  const assistant = SessionV1.Assistant.make({
    id: mid, sessionID: sid, role: "assistant", time: { created: 2 },
    parentID: uid, modelID, providerID, agent: "build", mode: "build",
    path: { cwd: "/replay", root: "/replay" }, cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const pending = SessionV1.ToolPart.make({
    id: pid, sessionID: sid, messageID: mid, type: "tool",
    tool: "bash", callID: "call_replay",
    state: { status: "pending", input: { command: "pwd" }, raw: "{\"command\":\"pwd\"}" },
  })
  const completed = SessionV1.ToolPart.make({
    id: pid, sessionID: sid, messageID: mid, type: "tool",
    tool: "bash", callID: "call_replay",
    state: {
      status: "completed", input: { command: "pwd" }, output: "/replay",
      title: "pwd", metadata: {}, time: { start: 2, end: 4 },
    },
  })
  yield* db.insert(MessageTable).values({
    id: uid, session_id: sid, data: user as never,
  }).run()
  yield* db.insert(MessageTable).values({
    id: mid, session_id: sid, data: assistant as never,
  }).run()
  yield* db.insert(PartTable).values({
    id: pid, session_id: sid, message_id: mid, data: completed as never,
  }).run()
  const event = (seq: number, type: string, data: object) =>
    db.insert(EventTable).values({
      id: EventV2.ID.make(`evt_v1_replay_${seq}`),
      aggregate_id: sid, seq, type, data: data as never,
    }).run()
  yield* event(1, EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1), {
    sessionID: sid, info: user,
  })
  yield* event(2, EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1), {
    sessionID: sid, info: assistant,
  })
  yield* event(3, EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1), {
    sessionID: sid, part: pending, time: 2,
  })
  yield* event(4, EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1), {
    sessionID: sid, part: completed, time: 4,
  })
  return { db, completed, event }
})

describe("V1 historical event transition replay vs canonical projection", () => {
  it.effect("does not call an absent message and empty history a successful replay", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* V1CurrentReplay.probe(db, { sessionID: sid, messageID: mid }))
        .toMatchObject({ status: "partial", processedEvents: 0, cutoverSafe: false })
    }),
  )

  it.effect("replays exact tool transitions and verifies final projection; detects post-replay edits", () =>
    Effect.gen(function* () {
      const { db } = yield* seed
      const good = yield* V1CurrentReplay.probe(db, { sessionID: sid, messageID: mid })
      expect(good).toMatchObject({
        status: "matches", cutoverSafe: false, processedEvents: 4,
        relevantEvents: 4, partial: false, anomalies: [],
      })
      expect(good.transitions.map((row) => row.status)).toEqual(["pending", "completed"])
      expect(good.replayHash).toBe(good.currentSourceHash)
      yield* db.update(PartTable).set({ data: {
        type: "tool", tool: "bash", callID: "call_replay",
        state: {
          status: "completed", input: { command: "pwd" }, output: "TAMPERED",
          title: "pwd", metadata: {}, time: { start: 2, end: 4 },
        },
      } as never }).where(eq(PartTable.id, pid)).run()
      const mismatch = yield* V1CurrentReplay.probe(db, { sessionID: sid, messageID: mid })
      expect(mismatch).toMatchObject({ status: "mismatch", cutoverSafe: false })
      expect(mismatch.replayHash).not.toBe(mismatch.currentSourceHash)
    }),
  )

  it.effect("detects missing history and returns partial instead of fabricated completeness", () =>
    Effect.gen(function* () {
      const { db } = yield* seed
      expect(yield* V1CurrentReplay.probe(db, {
        sessionID: sid, messageID: mid, maxEvents: 2,
      })).toMatchObject({ status: "partial", partial: true, cutoverSafe: false })
      yield* db.delete(EventTable)
        .where(eq(EventTable.id, EventV2.ID.make("evt_v1_replay_2"))).run()
      expect(yield* V1CurrentReplay.probe(db, { sessionID: sid, messageID: mid }))
        .toMatchObject({ status: "partial", partial: true, cutoverSafe: false })
    }),
  )

  it.effect("records tool settlement regressions and mutable callID identity anomalies", () =>
    Effect.gen(function* () {
      const { db, completed, event } = yield* seed
      yield* db.update(EventSequenceTable).set({ seq: 5 })
        .where(eq(EventSequenceTable.aggregate_id, sid)).run()
      yield* event(5, EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1), {
        sessionID: sid,
        part: { ...completed, callID: "call_changed", state: {
          status: "running", input: { command: "pwd" }, time: { start: 5 },
        } },
        time: 5,
      })
      expect(yield* V1CurrentReplay.probe(db, { sessionID: sid, messageID: mid }))
        .toMatchObject({
          status: "anomaly",
          anomalies: ["tool-call-identity-mutated", "tool-resumed-after-settlement"],
          cutoverSafe: false,
        })
    }),
  )

  it.effect("fails closed on malformed or foreign event payloads", () =>
    Effect.gen(function* () {
      const { db } = yield* seed
      const target = EventV2.ID.make("evt_v1_replay_4")
      yield* db.update(EventTable).set({
        data: { sessionID: sid, part: { id: pid, type: "tool", callID: "call_replay" }, time: 4 },
      }).where(eq(EventTable.id, target)).run()
      expect(yield* V1CurrentReplay.probe(db, { sessionID: sid, messageID: mid }))
        .toMatchObject({
          status: "anomaly", anomalies: ["malformed-part-event"], cutoverSafe: false,
        })
      yield* db.update(EventTable).set({
        data: { sessionID: SessionSchema.ID.make("ses_untrusted"), part: {}, time: 4 },
      }).where(eq(EventTable.id, target)).run()
      expect(yield* V1CurrentReplay.probe(db, { sessionID: sid, messageID: mid }))
        .toMatchObject({
          status: "anomaly", anomalies: ["foreign-event-session"], cutoverSafe: false,
        })
    }),
  )

  it.effect("rejects unknown transcript event versions instead of treating them as inert", () =>
    Effect.gen(function* () {
      const { db, event } = yield* seed
      yield* db.update(EventSequenceTable).set({ seq: 5 })
        .where(eq(EventSequenceTable.aggregate_id, sid)).run()
      yield* event(5, "message.part.updated.99", {
        sessionID: sid, part: { id: pid, type: "unknown-future" },
      })
      expect(yield* V1CurrentReplay.probe(db, { sessionID: sid, messageID: mid }))
        .toMatchObject({
          status: "anomaly", anomalies: ["unknown-transcript-event-version"],
          cutoverSafe: false,
        })
    }),
  )
})
