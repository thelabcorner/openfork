import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { RuntimeOwnerTable } from "@opencode-ai/core/runtime-owner.sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionExecutionOwnerTable } from "@opencode-ai/core/session/execution-owner.sql"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { SessionMessageTable, SessionMessageToolOverlayTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmTaskLeaseTable, SwarmTaskRunTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmRuntimeRetention } from "@/swarm/runtime-retention"
import { SwarmTaskClosure } from "@/swarm/task-closure"
import { testEffect } from "../lib/effect"

const projectID = ProjectV2.ID.make("swarm-closure-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_closure")
const workerSessionID = SessionV2.ID.make("ses_swarm_closure_worker")

const profile = Swarm.MemberExecutionProfile.make({
  agent: AgentModel.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("test-model"),
  },
  permissionBoundary: [],
})

const nodes = LayerNode.group([
  Database.node,
  EventV2.node,
  SessionProjector.node,
  SwarmSessionProjector.node,
  RuntimeOwner.node,
  SessionExecutionOwner.node,
  SwarmV2.node,
  SwarmRuntimeRetention.node,
  SwarmTaskClosure.node,
])

const it = testEffect(
  AppNodeBuilder.build(nodes, [[Database.node, Database.layerFromPath(":memory:")]]),
)

const waitFor = (predicate: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let index = 0; index < 4_000; index++) {
      if (yield* predicate) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("waitFor timed out"))
  })

const settle = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const swarm = yield* SwarmV2.Service
  const execution = yield* SessionExecutionOwner.Service
  const retention = yield* SwarmRuntimeRetention.Service
  const closure = yield* SwarmTaskClosure.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/closure"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm closure", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: workerSessionID,
      project_id: projectID,
      workspace_id: workspaceID,
      slug: workerSessionID,
      directory: "/swarm/closure",
      title: workerSessionID,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)

  const created = yield* swarm.create({
    projectID,
    workspaceID,
    directory: "/swarm/closure",
    name: "closure swarm",
    now: 10,
  })
  const info = yield* swarm.update({
    id: created.id,
    expectedRevision: created.revision,
    status: "active",
    now: 11,
  })
  const worker = yield* swarm.addMember({
    swarmID: info.id,
    name: "worker",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: profile,
    sessionID: workerSessionID,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  yield* retention.ensure()

  const task = yield* swarm.createTask({ swarmID: info.id, title: "silent completion", now: 30 })
  const claim = yield* swarm.claimTask({
    swarmID: info.id,
    taskID: task.id,
    memberID: worker.id,
    processOwner: retention.ownerID,
    leaseMs: 60_000,
    now: 40,
  })
  const runID = Swarm.TaskRunID.create()
  const inputID = SessionMessage.ID.create()
  yield* SessionInput.admitSynthetic(db, events, {
    id: inputID,
    sessionID: workerSessionID,
    content: { text: "do the work" },
    origin: {
      producer: SessionTurnProvenance.Source.SwarmAssignment,
      actor: { type: "host" },
      ref: runID,
    },
    admissionClass: "host",
    delivery: "queue",
    userPreemptible: true,
    expectedLatestUserSeq: undefined,
    commit: () =>
      SwarmV2.commitTaskRunAdmission(db, {
        token: claim.token,
        id: runID,
        sessionInputID: inputID,
        admittedAt: 41,
      }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
  })
  // The assignment actually ran: promotion is the durable proof that execution
  // began, which is what makes an unsetttled close truthful rather than guessed.
  yield* SessionInput.promoteLane(
    db,
    events,
    workerSessionID,
    { admissionClass: "host", delivery: "queue" },
    Number.MAX_SAFE_INTEGER,
  )
  return { db, events, swarm, execution, closure, info, task, claim, runID }
})

type State = Effect.Success<typeof settle>

const leaseFor = (state: State) =>
  state.db
    .select()
    .from(SwarmTaskLeaseTable)
    .where(eq(SwarmTaskLeaseTable.task_id, state.task.id))
    .get()
    .pipe(Effect.orDie)

const runFor = (state: State) =>
  state.db
    .select()
    .from(SwarmTaskRunTable)
    .where(eq(SwarmTaskRunTable.id, state.runID))
    .get()
    .pipe(Effect.orDie)

const taskRowFor = (state: State) =>
  state.db
    .select({ status: SwarmTaskTable.status, retry: SwarmTaskTable.semantic_retry_count })
    .from(SwarmTaskTable)
    .where(eq(SwarmTaskTable.id, state.task.id))
    .get()
    .pipe(Effect.orDie)

describe("Swarm execution-end closure", () => {
  it.live("never closes a run whose Session execution owner is still live", () =>
    Effect.gen(function* () {
      const state = yield* settle
      const acquired = yield* state.execution.tryAcquire(workerSessionID)
      expect(acquired.state).toBe("acquired")
      if (acquired.state !== "acquired") return
      expect(yield* runFor(state)).toMatchObject({ status: "running" })

      // Repeated unattended passes while the worker is still executing.
      for (let pass = 0; pass < 3; pass++) {
        yield* state.closure.poke()
        yield* waitFor(state.closure.activeDrains().pipe(Effect.map((count) => count === 0)))
      }

      expect(yield* leaseFor(state)).toMatchObject({ state: "active", generation: state.claim.token.generation })
      expect(yield* runFor(state)).toMatchObject({ status: "running" })
      expect(yield* taskRowFor(state)).toEqual({ status: "working", retry: 0 })
      // A live owner is never cleared, stolen, or interrupted by closure.
      const live = yield* state.execution.snapshot(workerSessionID)
      expect(live).toMatchObject({ ownerID: acquired.token.ownerID, generation: acquired.token.generation })
      expect(live.interruptReason).toBeUndefined()

      // A natural idle event can race just ahead of owner release. It marks
      // this Session eligible, but closure must still block until the exact
      // execution owner is gone.
      yield* state.events.publish(SessionStatusEvent.Idle, { sessionID: workerSessionID })
      yield* waitFor(state.closure.activeDrains().pipe(Effect.map((count) => count === 0)))
      expect(yield* taskRowFor(state)).toEqual({ status: "working", retry: 0 })

      expect(yield* state.execution.release(acquired.token)).toBe("released")
      yield* Effect.sleep("2100 millis")
      yield* waitFor(taskRowFor(state).pipe(Effect.map((row) => row?.status === "review_pending")))

      expect(yield* runFor(state)).toMatchObject({ status: "unsettled" })
      expect(yield* taskRowFor(state)).toEqual({ status: "review_pending", retry: 0 })
      expect(yield* leaseFor(state)).toBeUndefined()
      // Anti-replay: nothing can hand this already-produced work back out.
      expect(yield* state.swarm.expiredLeaseTargets({ now: Number.MAX_SAFE_INTEGER })).toHaveLength(0)
      expect(yield* state.swarm.retirementRequiredTargets()).toHaveLength(0)
      expect(
        yield* state.swarm
          .readyAssignments({ now: 1_000 })
          .pipe(Effect.map((assignments) => assignments.some((row) => row.task.id === state.task.id))),
      ).toBe(false)
    }),
  )

  })

const currentRuntimeID = "runtime-owner:closure-current" as RuntimeOwner.ID
const deadRuntimeID = "runtime-owner:closure-dead" as RuntimeOwner.ID

/**
 * Death is only provable for an owner this host can actually adjudicate, so
 * this fixture pins the death proof instead of relying on a real PID.
 */
const runtimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: currentRuntimeID,
    pid: 9301,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void as Effect.Effect<void, never, never> }),
    snapshot: (id) =>
      Effect.succeed(
        id === deadRuntimeID
          ? { id, pid: 9302, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }
          : id === currentRuntimeID
            ? { id, pid: 9301, startedAt: 1, heartbeatAt: Date.now(), controlEpoch: 0 }
            : undefined,
      ),
    proveLocalDeath: () => Effect.succeed("dead" as const),
  }),
)

const itDeadOwner = testEffect(
  AppNodeBuilder.build(nodes, [
    [Database.node, Database.layerFromPath(":memory:")],
    [RuntimeOwner.node, runtimeLayer],
  ]),
)

describe("Swarm execution-end closure under dead-owner fencing", () => {
  it.live("never treats a dead execution owner as proof that the worker completed", () =>
    Effect.gen(function* () {
      const state = yield* settle
      yield* state.db
        .insert(RuntimeOwnerTable)
        .values([
          { id: currentRuntimeID, pid: 9301, started_at: 1, heartbeat_at: Date.now(), control_epoch: 0 },
          { id: deadRuntimeID, pid: 9302, started_at: 1, heartbeat_at: 1, control_epoch: 0 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* state.db
        .insert(SessionExecutionOwnerTable)
        .values({ session_id: workerSessionID, generation: 5, owner_id: deadRuntimeID, acquired_at: 42 })
        .run()
        .pipe(Effect.orDie)

      for (let pass = 0; pass < 3; pass++) {
        yield* state.closure.poke()
        yield* waitFor(state.closure.activeDrains().pipe(Effect.map((count) => count === 0)))
      }

      expect(yield* state.execution.snapshot(workerSessionID)).toMatchObject({
        ownerID: deadRuntimeID,
        generation: 5,
      })
      expect(yield* runFor(state)).toMatchObject({ status: "running" })
      expect(yield* taskRowFor(state)).toEqual({ status: "working", retry: 0 })
      expect(yield* leaseFor(state)).toMatchObject({ state: "active" })
    }),
  )

  // Live clock: dead-owner adjudication compares real heartbeat ages.
  it.live("keeps a dead-owner run fenced when external effects are still unknown", () =>
    Effect.gen(function* () {
      const state = yield* settle

      // A hard-dead owner plus one unresolved mutating tool call: exactly the
      // state automatic recovery must refuse to resolve.
      yield* state.db
        .insert(RuntimeOwnerTable)
        .values([
          { id: currentRuntimeID, pid: 9301, started_at: 1, heartbeat_at: Date.now(), control_epoch: 0 },
          { id: deadRuntimeID, pid: 9302, started_at: 1, heartbeat_at: 1, control_epoch: 0 },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* state.db
        .insert(SessionExecutionOwnerTable)
        .values({ session_id: workerSessionID, generation: 5, owner_id: deadRuntimeID, acquired_at: 42 })
        .run()
        .pipe(Effect.orDie)

      const callID = "call-closure-uncertain"
      const assistantMessageID = SessionMessage.ID.create()
      yield* state.events.publish(SessionEvent.Step.Started, {
        sessionID: workerSessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(43),
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("test"),
          id: ModelV2.ID.make("test-model"),
        },
      })
      yield* state.events.publish(SessionEvent.Tool.Input.Started, {
        sessionID: workerSessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(44),
        callID,
        name: "bash",
      })
      yield* state.events.publish(SessionEvent.Tool.Called, {
        sessionID: workerSessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(45),
        callID,
        tool: "bash",
        input: { command: "touch outcome-unknown" },
        provider: { executed: false },
      })

      const toolCallEvents = () =>
        state.db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, workerSessionID))
          .all()
          .pipe(Effect.orDie)
          .pipe(Effect.map((rows) => rows.filter((row) => row.type.includes(SessionEvent.Tool.Called.type)).length))
      const overlay = () =>
        state.db
          .select({ settled: SessionMessageToolOverlayTable.settlement_event_id })
          .from(SessionMessageTable)
          .innerJoin(
            SessionMessageToolOverlayTable,
            eq(SessionMessageToolOverlayTable.message_id, SessionMessageTable.id),
          )
          .where(eq(SessionMessageTable.session_id, workerSessionID))
          .all()
          .pipe(Effect.orDie)

      const before = yield* toolCallEvents()
      expect(before).toBe(1)
      expect(yield* SessionRecovery.executionHazards(state.db, workerSessionID)).toEqual({
        currentTool: true,
        legacyTool: false,
      })

      // Repeated unattended passes. Every one of them must be a no-op: the run is
      // never closed, the unresolved tool is never sealed, and the task is never
      // handed back out.
      for (let pass = 0; pass < 4; pass++) {
        yield* state.closure.poke()
        yield* waitFor(state.closure.activeDrains().pipe(Effect.map((count) => count === 0)))
        yield* Effect.yieldNow
      }

      // Fail-closed: the unresolved tool row is the durable evidence that keeps
      // the generation fenced. Closure never seals it, closes the run, releases
      // the lease, or replays the task.
      expect(yield* SessionRecovery.executionHazards(state.db, workerSessionID)).toEqual({
        currentTool: true,
        legacyTool: false,
      })
      expect((yield* overlay()).map((row) => row.settled)).toEqual([null])
      expect(yield* toolCallEvents()).toBe(before)
      expect(yield* leaseFor(state)).toMatchObject({ state: "active", generation: state.claim.token.generation })
      expect(yield* runFor(state)).toMatchObject({ status: "running" })
      expect(yield* taskRowFor(state)).toEqual({ status: "working", retry: 0 })
      expect(yield* state.swarm.unsettledExecutionTargets()).toHaveLength(1)
      // Normal execution cannot overlap a fenced Session.
      expect(yield* state.execution.tryAcquire(workerSessionID)).toMatchObject({ state: "busy" })
      expect(
        yield* state.swarm
          .readyAssignments({ now: 1_000 })
          .pipe(Effect.map((rows) => rows.some((row) => row.task.id === state.task.id))),
      ).toBe(false)

      // Explicit operator containment can resolve the tool hazard, but it still
      // does NOT manufacture a natural execution-completion signal. A dead owner
      // remains retirement/retry territory rather than becoming review_pending.
      yield* SessionRecovery.failInterruptedTools(state.db, state.events, workerSessionID)
      yield* state.db
        .delete(SessionExecutionOwnerTable)
        .where(eq(SessionExecutionOwnerTable.session_id, workerSessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* SessionRecovery.executionHazards(state.db, workerSessionID)).toEqual({
        currentTool: false,
        legacyTool: false,
      })

      yield* state.closure.poke()
      yield* waitFor(state.closure.activeDrains().pipe(Effect.map((count) => count === 0)))
      expect(yield* runFor(state)).toMatchObject({ status: "running" })
      expect(yield* taskRowFor(state)).toEqual({ status: "working", retry: 0 })
      expect(yield* leaseFor(state)).toMatchObject({ state: "active" })

      // Aborted idle is explicitly not completion evidence either.
      yield* state.events.publish(SessionStatusEvent.Idle, { sessionID: workerSessionID, reason: "aborted" })
      yield* state.closure.poke()
      yield* waitFor(state.closure.activeDrains().pipe(Effect.map((count) => count === 0)))
      expect(yield* runFor(state)).toMatchObject({ status: "running" })
      expect(yield* taskRowFor(state)).toEqual({ status: "working", retry: 0 })
      expect(yield* toolCallEvents()).toBe(before)
    }),
  )
})