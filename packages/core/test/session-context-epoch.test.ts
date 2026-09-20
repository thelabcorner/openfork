import { describe, expect } from "bun:test"
import { Cause, DateTime, Effect, Exit, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionContextEpochState } from "@opencode-ai/core/session/context-epoch-state"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionContextEpochTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemSurface } from "@opencode-ai/core/system-surface"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))
const key = SystemSurface.Key.make("test/context")
const headOnly = { history: "head-only", turnScoped: false } as const
const replaceComplete = { history: "replace-complete", turnScoped: false } as const

const present = (rendered: string, projectionVersion = SystemSurface.CURRENT_PROJECTION_VERSION) =>
  Effect.succeed({
    observations: [SystemSurface.present(key, rendered)],
    order: [key],
    projectionVersion,
  })

const unavailable = Effect.succeed({
  observations: [SystemSurface.unavailable(key)],
  order: [key],
})

const setupSession = (suffix: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = SessionSchema.ID.make(`ses_context_epoch_${suffix}`)
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/context-epoch"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: AbsolutePath.make("/context-epoch"),
        title: "context epoch",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    return sessionID
  })

describe("SessionContextEpoch SystemSurface bridge", () => {
  it.effect("persists replace-complete changes as chronological complete-System history", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = yield* setupSession("replace_complete")

      expect(yield* SessionContextEpoch.initialize(db, present("A"), sessionID)).toEqual({ baseline: "A", baselineSeq: -1 })
      expect(yield* SessionContextEpoch.prepare(db, events, present("B"), sessionID, replaceComplete)).toEqual({
        baseline: "A",
        baselineSeq: -1,
      })

      const row = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(row?.baseline).toBe("A")
      expect(row?.baseline_seq).toBe(-1)
      const checkpoint = Schema.decodeUnknownSync(SessionContextEpochState.Checkpoint)(row!.snapshot)
      expect(checkpoint).toMatchObject({
        surface: { sections: { [key]: "B" } },
        projection: { historyActive: true, history: "replace-complete" },
      })
      const contextEvents = yield* db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, "session.next.context.updated.1"),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(contextEvents).toHaveLength(1)
      expect(contextEvents[0]?.data).toMatchObject({ sessionID, text: "B" })

      // An unchanged observation must not append another durable System event or
      // alter the canonical checkpoint.
      yield* SessionContextEpoch.prepare(db, events, present("B"), sessionID, replaceComplete)
      expect(
        yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, sessionID),
              eq(EventTable.type, "session.next.context.updated.1"),
            ),
          )
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      const unchanged = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(unchanged?.snapshot).toEqual(row?.snapshot)
    }),
  )

  it.effect("lazily migrates a legacy typed snapshot by rebasing exact current bytes", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = yield* setupSession("legacy")
      const legacy: SystemContext.LegacySnapshot = {
        "test/context": { value: "A", removed: "legacy removal" },
      }
      yield* db
        .insert(SessionContextEpochTable)
        .values({ session_id: sessionID, baseline: "A", snapshot: legacy, baseline_seq: -1 })
        .run()
        .pipe(Effect.orDie)

      // Prove migration rebases to the durable frontier observed at migration
      // time rather than preserving the stale sequence stored in the legacy row.
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        text: "ordinary durable history",
      })
      const frontier = yield* EventV2.latestSequence(db, sessionID)
      expect(frontier).toBeGreaterThan(-1)

      expect(yield* SessionContextEpoch.prepare(db, events, present("B"), sessionID, headOnly)).toEqual({
        baseline: "B",
        baselineSeq: frontier,
      })
      const row = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(row?.baseline_seq).toBe(frontier)
      expect(Schema.decodeUnknownSync(SessionContextEpochState.Checkpoint)(row!.snapshot)).toMatchObject({
        version: 1,
        surface: { projectionVersion: 1, sections: { [key]: "B" } },
        projection: { historyActive: false },
      })
    }),
  )

  it.effect("blocks required unavailable context across an incompatible projection version", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = yield* setupSession("projection_version")
      yield* SessionContextEpoch.initialize(db, present("A", SystemSurface.ProjectionVersion.make(2)), sessionID)

      const exit = yield* SessionContextEpoch.prepare(db, events, unavailable, sessionID, headOnly).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(SystemContext.InitializationBlocked)
        expect(error).toMatchObject({ keys: [SystemContext.Key.make("test/context")] })
      }
    }),
  )

  it.effect("fails closed when a stored snapshot is neither current nor legacy", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const sessionID = yield* setupSession("corrupt")
      yield* db
        .insert(SessionContextEpochTable)
        .values({
          session_id: sessionID,
          baseline: "A",
          snapshot: { corrupt: true } as never,
          baseline_seq: -1,
        })
        .run()
        .pipe(Effect.orDie)

      const exit = yield* SessionContextEpoch.prepare(db, events, present("A"), sessionID, headOnly).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ContextSnapshotDecodeError")
    }),
  )
})
