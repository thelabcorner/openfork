import { describe, expect } from "bun:test"
import { eq, like } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTurnProvenance } from "@opencode-ai/core/session/turn-provenance"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionSchema.ID.make("ses_input_completion_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "input-completion",
      directory: "/project",
      title: "input completion",
      version: "test",
      agent: "build",
      model: { providerID: "test-provider", id: "test-model" },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/** A host Swarm-style assignment: the exact worker-root input under test. */
const admitHost = (id: SessionMessage.ID, text: string, producer: SessionTurnProvenance.Source) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    return yield* SessionInput.admitSynthetic(db, events, {
      id,
      sessionID,
      content: SessionInput.SyntheticContent.make({ text }),
      origin: SessionInput.SyntheticOrigin.make({
        producer,
        actor: { type: "host" },
        ref: `ref:${id}`,
      }),
      admissionClass: "host",
      delivery: "queue",
      userPreemptible: true,
      expectedLatestUserSeq: undefined,
    })
  })

const admitAssignment = (id: SessionMessage.ID, text: string) =>
  admitHost(id, text, SessionTurnProvenance.Source.SwarmAssignment)

const promoteHostQueue = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  return yield* SessionInput.promoteLane(db, events, sessionID, { admissionClass: "host", delivery: "queue" }, Number.MAX_SAFE_INTEGER)
})

const complete = (id: SessionMessage.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    return yield* SessionInput.complete(db, events, { sessionID, id })
  })

const entry = (id: SessionMessage.ID) =>
  Database.Service.use(({ db }) => SessionInput.findEntry(db, id))

const completionEvents = () =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(EventTable)
      .where(like(EventTable.type, "%input.completed%"))
      .all()
      .pipe(Effect.orDie),
  )

describe("SessionInput exact cycle completion", () => {
  it.effect("marks the exact promoted input complete for a successful cycle", () =>
    Effect.gen(function* () {
      yield* setup
      const id = SessionMessage.ID.make("msg_complete_success")
      yield* admitAssignment(id, "assignment that runs")
      expect(yield* promoteHostQueue()).toMatchObject({ promoted: 1 })

      expect(yield* complete(id)).toMatchObject({ state: "completed" })

      const stored = yield* entry(id)
      expect(stored?.promotedSeq).toBeDefined()
      expect(stored?.completedSeq).toBeGreaterThan(0)
      // The marker is a Session aggregate sequence, not a wall clock.
      expect((yield* completionEvents()).length).toBe(1)
      expect(yield* entry(id)).toMatchObject({ completedSeq: stored?.completedSeq })
    }),
  )

  it.effect("fails closed for admitted-but-never-promoted input and commits no event", () =>
    Effect.gen(function* () {
      yield* setup
      const id = SessionMessage.ID.make("msg_complete_unpromoted")
      yield* admitAssignment(id, "assignment that never ran")

      const stored = yield* entry(id)
      expect(stored?.promotedSeq).toBeUndefined()
      expect(stored?.completedSeq).toBeUndefined()

      // A pending input never reached a runner cycle, so completion is refused
      // rather than recorded against a row that never executed.
      expect(yield* complete(id)).toMatchObject({ state: "not-promoted" })
      expect((yield* completionEvents()).length).toBe(0)
      expect((yield* entry(id))?.completedSeq).toBeUndefined()
    }),
  )

  it.effect("does not let a later successful cycle cover an earlier failed assignment", () =>
    Effect.gen(function* () {
      yield* setup
      const failed = SessionMessage.ID.make("msg_complete_failed_assignment")
      yield* admitAssignment(failed, "assignment that fails")
      yield* promoteHostQueue()
      // The failed cycle publishes nothing: no provider step completed, so
      // there is no completion event for this row at all.
      expect((yield* entry(failed))?.completedSeq).toBeUndefined()

      const later = SessionMessage.ID.make("msg_complete_later_cycle")
      yield* admitAssignment(later, "unrelated later work")
      yield* promoteHostQueue()
      expect(yield* complete(later)).toMatchObject({ state: "completed" })

      // The later success marks only its own input. The failed assignment stays
      // exactly uncompleted forever unless it is explicitly re-executed.
      expect((yield* entry(later))?.completedSeq).toBeGreaterThan(0)
      expect((yield* entry(failed))?.completedSeq).toBeUndefined()
    }),
  )

  it.effect("keeps an exact completion marker stable across later peer input and a new generation", () =>
    Effect.gen(function* () {
      yield* setup
      const assignment = SessionMessage.ID.make("msg_completion_exact")
      yield* admitAssignment(assignment, "assignment that completed")
      yield* promoteHostQueue()
      expect(yield* complete(assignment)).toMatchObject({ state: "completed" })
      const original = (yield* entry(assignment))?.completedSeq

      // Later peer/user work and a fresh execution generation are different
      // inputs. They must never move or inherit the earlier row's marker.
      const peer = SessionMessage.ID.make("msg_completion_peer")
      yield* admitHost(peer, "peer follow-up", SessionTurnProvenance.Source.SwarmPeer)
      yield* promoteHostQueue()
      expect(yield* complete(peer)).toMatchObject({ state: "completed" })

      expect((yield* entry(assignment))?.completedSeq).toBe(original)
      expect((yield* entry(peer))?.completedSeq).toBeDefined()
      expect((yield* entry(peer))?.completedSeq).not.toBe(original)
      expect(yield* entry(assignment)).toMatchObject({ id: assignment, completedSeq: original })
    }),
  )

  it.effect("is idempotent for repeated event replay and keeps the first completion sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const id = SessionMessage.ID.make("msg_complete_replay")
      yield* admitAssignment(id, "assignment replayed")
      yield* promoteHostQueue()

      const first = yield* complete(id)
      expect(first.state).toBe("completed")
      const replay = yield* complete(id)
      // Re-publishing is refused by the projector and classified, never
      // double-stamped and never fatal to the caller.
      expect(replay.state).toBe("already-completed")
      expect((yield* entry(id))?.completedSeq).toBe(first.state === "completed" ? first.completedSeq : undefined)

      // Exactly one durable completion fact exists for this input.
      const events = yield* completionEvents()
      expect(events.filter((row) => row.aggregate_id === sessionID).length).toBe(1)
      const row = yield* Database.Service.use(({ db }) =>
        db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      )
      expect(row?.completed_seq).toBe(first.state === "completed" ? first.completedSeq : null)
    }),
  )
})
