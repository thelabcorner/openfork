import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageProjection } from "@opencode-ai/core/session/message-projection"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRecoveryTurn } from "@opencode-ai/core/session/recovery-turn"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionDormantRecovery } from "@opencode-ai/core/session/dormant-recovery"
import { MessageTable, SessionMessageTable, SessionMessageToolOverlayTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))
const session = SessionV2.ID.make("ses_abandoned_generation_001")
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  yield* db.insert(ProjectTable).values({
    id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [],
  }).onConflictDoNothing().run()
  yield* db.insert(SessionTable).values({
    id: session, project_id: Project.ID.global, slug: "abandoned", directory: "/project",
    title: "abandoned", version: "test",
  }).run()
  return { db, events }
})

const legacyAssistant = (id: string, created: number, completed?: number) => SessionV1.Assistant.make({
  id: SessionV1.MessageID.make(id),
  sessionID: session,
  role: "assistant",
  time: { created, ...(completed === undefined ? {} : { completed }) },
  parentID: SessionV1.MessageID.make("msg_old_input"),
  modelID: "model" as never,
  providerID: "provider" as never,
  mode: "build",
  agent: "build",
  path: { cwd: "/project", root: "/project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

describe("interrupted generation transcript settlement", () => {
  it.effect("one-time dormant repair uses the exact owner claim and closes a ghost assistant", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: session, assistantMessageID,
        timestamp: DateTime.makeUnsafe(250), agent: "build", model,
      })
      const token: SessionExecutionOwner.RecoveryToken = {
        sessionID: session, ownerID: "runtime_crashed" as never,
        generation: 4, recoveryOwnerID: "runtime_sweeper" as never,
      }
      const snapshot: SessionExecutionOwner.Snapshot = {
        sessionID: session, ownerID: token.ownerID, generation: token.generation,
        acquiredAt: 200, recoveryOwnerID: token.recoveryOwnerID,
      }
      let releases = 0
      let owned = true
      const owner = {
        listWorking: () => Effect.succeed(
          owned ? new Map([[session, { type: "interrupted" as const }]]) : new Map(),
        ),
        tryClaimRecovery: () => Effect.succeed({ state: "claimed" as const, token, snapshot }),
        completeRecovery: () => Effect.sync(() => { owned = false; releases++; return "released" as const }),
        snapshot: () => Effect.succeed(snapshot),
      } as unknown as SessionExecutionOwner.Interface
      expect(yield* SessionDormantRecovery.reconcileDormant(db, owner, events)).toEqual({
        inspected: 1, recovered: 1, deferred: 0, truncated: false,
      })
      expect(releases).toBe(1)
      const row = yield* db.select().from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID)).get()
      if (!row) return yield* Effect.die("missing assistant")
      expect(yield* SessionMessageProjection.decodeRow(db, row)).toMatchObject({
        type: "assistant", error: { type: "unknown" },
      })
      expect(yield* SessionDormantRecovery.reconcileDormant(db, owner, events)).toEqual({
        inspected: 0, recovered: 0, deferred: 0, truncated: false,
      })
      expect(releases).toBe(1)
    }),
  )

  it.effect("dormant background repair never claims a generation with an unsettled external tool", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: session, assistantMessageID,
        timestamp: DateTime.makeUnsafe(250), agent: "build", model,
      })
      yield* db.insert(SessionMessageToolOverlayTable).values({
        message_id: assistantMessageID, call_id: "call_external_effect_unknown",
      }).run()
      let claimed = 0
      const owner = {
        listWorking: () => Effect.succeed(new Map([[session, { type: "interrupted" as const }]])),
        tryClaimRecovery: () => Effect.sync(() => { claimed++; return { state: "busy" as const } }),
      } as unknown as SessionExecutionOwner.Interface
      expect(yield* SessionDormantRecovery.reconcileDormant(db, owner, events)).toEqual({
        inspected: 1, recovered: 0, deferred: 1, truncated: false,
      })
      expect(claimed).toBe(0)
      const row = yield* db.select().from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID)).get()
      if (!row) return yield* Effect.die("missing assistant")
      const untouched = yield* SessionMessageProjection.decodeRow(db, row)
      expect(untouched.type).toBe("assistant")
      expect("completed" in untouched.time ? untouched.time.completed : undefined).toBeUndefined()
    }),
  )

  it.effect("serializes concurrent recovery callers for the same dead generation", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: session, assistantMessageID,
        timestamp: DateTime.makeUnsafe(210), agent: "build", model,
      })
      const token: SessionExecutionOwner.RecoveryToken = {
        sessionID: session, ownerID: "runtime_dead" as never,
        generation: 9, recoveryOwnerID: "runtime_repair" as never,
      }
      const snapshot: SessionExecutionOwner.Snapshot = {
        sessionID: session, ownerID: token.ownerID, generation: 9,
        recoveryOwnerID: token.recoveryOwnerID, acquiredAt: 200,
      }
      let owned = true
      let claimed = 0
      let released = 0
      const owner = {
        tryClaimRecovery: () => Effect.sync(() => {
          claimed++
          return owned ? { state: "claimed" as const, token, snapshot }
            : { state: "idle" as const, snapshot: { ...snapshot, ownerID: undefined } }
        }),
        completeRecovery: () => Effect.gen(function* () {
          // Test clock is deterministic/frozen: deliberately yield scheduler
          // work rather than waiting on a live wall-clock timer.
          yield* Effect.yieldNow
          owned = false
          released++
          return "released" as const
        }),
        snapshot: () => Effect.succeed(snapshot),
      } as unknown as SessionExecutionOwner.Interface
      const outcomes = yield* Effect.all([
        SessionRecovery.recoverDeadOwnerIfQuiescent(db, owner, session, events),
        SessionRecovery.recoverDeadOwnerIfQuiescent(db, owner, session, events),
      ], { concurrency: 2 })
      expect(outcomes.map((entry) => entry.state).sort()).toEqual(["idle", "recovered"])
      expect(claimed).toBe(2)
      expect(released).toBe(1)
      const rows = yield* db.select().from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID)).all()
      expect(rows).toHaveLength(1)
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, 200))
        .toEqual({ state: "sealed", current: 0, v1: 0 })
    }),
  )

  it.effect("repairs a pre-migration owner with no acquisition clock when both transcripts are empty", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, undefined))
        .toEqual({ state: "sealed", current: 0, v1: 0 })
    }),
  )

  it.effect("keyset-paginates more than one recovery page with shared timestamps without skipping messages", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      for (let index = 0; index < 37; index++) {
        yield* events.publish(SessionV1.Event.MessageUpdated, {
          sessionID: session,
          info: legacyAssistant(`msg_v1_long_abandon_${index.toString().padStart(3, "0")}`, 250),
        })
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: session, timestamp: DateTime.makeUnsafe(250),
          assistantMessageID: SessionMessage.ID.create(), agent: "build", model,
        })
      }
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, 200))
        .toEqual({ state: "sealed", current: 37, v1: 37 })
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, 200))
        .toEqual({ state: "sealed", current: 0, v1: 0 })
    }),
  )

  it.effect("automatic recovery settles the unfinished step before generation CAS-release", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: session, assistantMessageID,
        timestamp: DateTime.makeUnsafe(200), agent: "build", model,
      })
      const token: SessionExecutionOwner.RecoveryToken = {
        sessionID: session, ownerID: "runtime_dead" as never,
        generation: 5, recoveryOwnerID: "runtime_repair" as never,
      }
      let released = 0
      const snapshot: SessionExecutionOwner.Snapshot = {
        sessionID: session, ownerID: token.ownerID, generation: token.generation, acquiredAt: 100,
        recoveryOwnerID: token.recoveryOwnerID,
      }
      const owner = {
        tryClaimRecovery: () => Effect.succeed({ state: "claimed" as const, token, snapshot }),
        completeRecovery: () => Effect.gen(function* () {
          const row = yield* db.select().from(SessionMessageTable)
            .where(eq(SessionMessageTable.id, assistantMessageID)).get()
          if (!row) return yield* Effect.die("missing assistant")
          const assistant = yield* SessionMessageProjection.decodeRow(db, row)
          expect(assistant).toMatchObject({
            type: "assistant", error: { type: "unknown", message: expect.stringContaining("interrupted") },
          })
          released++
          return "released" as const
        }),
        snapshot: () => Effect.succeed(snapshot),
      } as unknown as SessionExecutionOwner.Interface
      expect((yield* SessionRecovery.recoverDeadOwnerIfQuiescent(db, owner, session, events)).state).toBe("recovered")
      expect(released).toBe(1)
    }),
  )

  it.effect("keeps the exact recovery claim fenced when the transcript is undecodable", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: session, info: legacyAssistant("msg_opaque_no_release", 250),
      })
      yield* db.run(sql`UPDATE message SET data = '{"$cdbRef":"unknown"}' WHERE id = 'msg_opaque_no_release'`)
      let released = false
      const token: SessionExecutionOwner.RecoveryToken = {
        sessionID: session, ownerID: "runtime_dead" as never,
        generation: 9, recoveryOwnerID: "runtime_repair" as never,
      }
      const snapshot: SessionExecutionOwner.Snapshot = {
        sessionID: session, ownerID: token.ownerID, generation: token.generation, acquiredAt: 200,
        recoveryOwnerID: token.recoveryOwnerID,
      }
      const owner = {
        tryClaimRecovery: () => Effect.succeed({ state: "claimed" as const, token, snapshot }),
        completeRecovery: () => Effect.sync(() => { released = true; return "released" as const }),
        snapshot: () => Effect.succeed(snapshot),
      } as unknown as SessionExecutionOwner.Interface
      expect(yield* SessionRecovery.recoverDeadOwnerIfQuiescent(db, owner, session, events))
        .toMatchObject({ state: "transcript-unverifiable", reason: "opaque or unknown V1 message role" })
      expect(released).toBe(false)
    }),
  )

  it.effect("marks an unfinished current assistant as failed without touching completed history or a different session", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const old = SessionMessage.ID.create()
      const current = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: session, assistantMessageID: old, timestamp: DateTime.makeUnsafe(10), agent: "build", model,
      })
      yield* events.publish(SessionEvent.Step.Failed, {
        sessionID: session, assistantMessageID: old, timestamp: DateTime.makeUnsafe(15),
        error: { type: "unknown", message: "already complete" },
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: session, assistantMessageID: current, timestamp: DateTime.makeUnsafe(20), agent: "build", model,
      })
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, 0)).toEqual({
        state: "sealed", current: 1, v1: 0,
      })
      const actual = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, current)).get()
      if (!actual) return yield* Effect.die("missing current message")
      const parsed = yield* SessionMessageProjection.decodeRow(db, actual)
      expect(parsed).toMatchObject({ type: "assistant", error: { type: "unknown", message: expect.stringContaining("interrupted") } })
      if (parsed.type === "assistant" && parsed.time.completed)
        expect(DateTime.toEpochMillis(parsed.time.completed)).toBeGreaterThanOrEqual(20)
      const prior = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, old)).get()
      if (!prior) return yield* Effect.die("missing old message")
      expect(yield* SessionMessageProjection.decodeRow(db, prior)).toMatchObject({
        type: "assistant", error: { type: "unknown", message: "already complete" },
      })
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, 0)).toEqual({
        state: "sealed", current: 0, v1: 0,
      })
    }),
  )

  it.effect("repairs a V1 reasoning-only abandoned turn while preserving completed and pre-generation turns", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      for (const info of [
        legacyAssistant("msg_legacy_before_generation", 1),
        legacyAssistant("msg_legacy_already_complete", 100, 110),
        legacyAssistant("msg_legacy_crashed_mid_reasoning", 125),
      ]) yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: session, info })
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, 100)).toEqual({
        state: "sealed", current: 0, v1: 1,
      })
      const rows = yield* db.select().from(MessageTable).all()
      const before = rows.find((row) => row.id === "msg_legacy_before_generation")!
      const completed = rows.find((row) => row.id === "msg_legacy_already_complete")!
      const crashed = rows.find((row) => row.id === "msg_legacy_crashed_mid_reasoning")!
      const completedAt = (data: typeof before.data) => "completed" in data.time ? data.time.completed : undefined
      expect(completedAt(before.data)).toBeUndefined()
      expect(completedAt(completed.data)).toBe(110)
      expect(completedAt(crashed.data)).toBeDefined()
      expect(completedAt(crashed.data)).toBeGreaterThanOrEqual(125)
      expect("error" in crashed.data ? crashed.data.error : undefined)
        .toMatchObject({ name: "MessageAbortedError" })
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, 100)).toEqual({
        state: "sealed", current: 0, v1: 0,
      })
    }),
  )

  it.effect("refuses to infer transcript safety from opaque V1 JSON or unknown acquisition time", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const info = legacyAssistant("msg_legacy_opaque", 100)
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: session, info })
      yield* db.run(sql`UPDATE message SET data = '{"$cdbRef": "opaque"}' WHERE id = 'msg_legacy_opaque'`)
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, 100)).toMatchObject({
        state: "unverifiable", reason: "opaque or unknown V1 message role",
      })
      expect(yield* SessionRecoveryTurn.sealInterruptedGeneration(db, events, session, undefined)).toMatchObject({
        state: "unverifiable", reason: "execution acquisition timestamp unavailable",
      })
    }),
  )
})
