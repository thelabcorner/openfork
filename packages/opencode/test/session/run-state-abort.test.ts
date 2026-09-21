import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Deferred, Effect, Ref } from "effect"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "../../src/session/schema"
import { SessionRunState } from "../../src/session/run-state"
import { requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * t-manual-stop (opencode side): an operator cancel must be OBSERVABLE.
 *
 * The idle transition caused by SessionRunState.cancel publishes
 * session.idle with reason:"aborted" so downstream consumers (swarm
 * supervisors) can distinguish an operator stop from a natural turn end
 * and never auto-resume it. A naturally-completing run publishes the same
 * event WITHOUT the reason.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      RuntimeOwner.node,
      SessionExecutionOwner.node,
      SessionRunState.node,
      EventV2Bridge.node,
    ]),
  ),
)

const work = Effect.succeed({} as SessionV1.WithParts)

it.effect("drain registration is process-scoped and does not require an active InstanceRef", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    yield* runState.registerDrain(() => work)
  }),
)

const seedSession = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const instance = yield* requireInstance
    yield* db
      .insert(ProjectTable)
      .values({
        id: instance.project.id ?? Project.ID.global,
        worktree: AbsolutePath.make(instance.worktree),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: instance.project.id ?? Project.ID.global,
        slug: sessionID,
        directory: instance.directory,
        title: "run-state test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/** Register a listener that resolves on the next session.idle payload. The
 * listener is attached synchronously (no pubsub subscription race). */
const nextIdle = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<any>()
  yield* events.listen((event) =>
    event.type === "session.idle" ? Deferred.succeed(deferred, event as any) : Effect.void,
  )
  return deferred
})

it.instance("operator cancel publishes session.idle with reason aborted", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const sessionID = SessionID.make("session-abort-test")
    yield* seedSession(sessionID)

    const fiber = yield* nextIdle
    yield* Effect.forkChild(runState.ensureRunning(sessionID, work, Effect.never))
    yield* Effect.sleep("50 millis")
    yield* runState.cancel(sessionID)

    const event = yield* Deferred.await(fiber)
    expect(event.type).toBe("session.idle")
    expect(event.data.sessionID).toBe(sessionID)
    expect(event.data.reason).toBe("aborted")
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("cancel with no active run still publishes reason aborted", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const sessionID = SessionID.make("session-abort-noop")

    const fiber = yield* nextIdle
    yield* runState.cancel(sessionID)

    const event = yield* Deferred.await(fiber)
    expect(event.data.sessionID).toBe(sessionID)
    expect(event.data.reason).toBe("aborted")
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("natural completion publishes session.idle without a reason", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const sessionID = SessionID.make("session-natural-idle")
    yield* seedSession(sessionID)

    const fiber = yield* nextIdle
    yield* Effect.sleep("20 millis")
    yield* runState.ensureRunning(sessionID, work, work)

    const event = yield* Deferred.await(fiber)
    expect(event.data.sessionID).toBe(sessionID)
    expect(event.data.reason).toBeUndefined()
  }).pipe(Effect.timeout("5 seconds")),
)

it.instance("pending SessionInput continues under the same durable owner generation before release", () =>
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    const owner = yield* SessionExecutionOwner.Service
    const { db } = yield* Database.Service
    const sessionID = SessionID.make("session-owner-drain-continuation")
    yield* seedSession(sessionID)

    const firstGeneration = yield* Ref.make<number | undefined>(undefined)
    const drainedGeneration = yield* Ref.make<number | undefined>(undefined)
    const drained = yield* Deferred.make<void>()
    yield* runState.registerDrain((id) =>
      Effect.gen(function* () {
        const snapshot = yield* owner.snapshot(id)
        yield* Ref.set(drainedGeneration, snapshot.generation)
        yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
        yield* Deferred.succeed(drained, undefined)
        return {} as SessionV1.WithParts
      }),
    )

    yield* db
      .insert(SessionInputTable)
      .values({
        id: SessionMessage.ID.make("msg_run_state_pending"),
        session_id: sessionID,
        prompt: Prompt.make({ text: "pending" }),
        delivery: "queue",
        admitted_seq: 1,
      })
      .run()
      .pipe(Effect.orDie)

    yield* runState.ensureRunning(
      sessionID,
      work,
      Effect.gen(function* () {
        yield* Ref.set(firstGeneration, (yield* owner.snapshot(sessionID)).generation)
        return {} as SessionV1.WithParts
      }),
    )
    yield* Deferred.await(drained)
    expect(yield* Ref.get(drainedGeneration)).toBe(yield* Ref.get(firstGeneration))

    for (let index = 0; index < 100; index++) {
      if (!(yield* owner.snapshot(sessionID)).ownerID) break
      yield* Effect.sleep("10 millis")
    }
    expect((yield* owner.snapshot(sessionID)).ownerID).toBeUndefined()
  }).pipe(Effect.timeout("5 seconds")),
)
