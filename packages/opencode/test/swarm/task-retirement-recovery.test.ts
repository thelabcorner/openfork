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
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageProjection } from "@opencode-ai/core/session/message-projection"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { SessionMessageTable, SessionMessageToolOverlayTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmTaskLeaseTable, SwarmTaskRunTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmRuntimeRetention } from "@/swarm/runtime-retention"
import { SwarmTaskRetirement } from "@/swarm/task-retirement"
import { testEffect } from "../lib/effect"

const currentRuntimeID = "runtime-owner:retirement-recovery-current" as RuntimeOwner.ID
const deadRuntimeID = "runtime-owner:retirement-recovery-dead" as RuntimeOwner.ID

const runtimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: currentRuntimeID,
    pid: 9101,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void }),
    snapshot: (id) =>
      Effect.succeed(
        id === deadRuntimeID
          ? { id, pid: 9102, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }
          : id === currentRuntimeID
            ? { id, pid: 9101, startedAt: 1, heartbeatAt: 10_000, controlEpoch: 0 }
            : undefined,
      ),
    proveLocalDeath: (id) => Effect.succeed(id === deadRuntimeID ? "dead" : "alive-or-unknown"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SwarmSessionProjector.node,
      RuntimeOwner.node,
      SessionExecutionOwner.node,
      SwarmV2.node,
      SwarmRuntimeRetention.node,
      SwarmTaskRetirement.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [RuntimeOwner.node, runtimeLayer],
    ],
  ),
)

const projectID = ProjectV2.ID.make("swarm-retirement-recovery-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_retirement_recovery")
const workerSessionID = SessionV2.ID.make("ses_swarm_retirement_recovery_worker")
const UNCERTAIN_CALL_ID = "call-uncertain"

const profile = Swarm.MemberExecutionProfile.make({
  agent: AgentModel.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("test-model"),
  },
  permissionBoundary: [],
})

const waitFor = (predicate: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let index = 0; index < 4_000; index++) {
      if (yield* predicate) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("waitFor timed out"))
  })

/**
 * One retired lease whose worker Session is owned by a proven-dead process and
 * whose transcript holds a single unresolved mutating tool call. This is exactly
 * the state automatic recovery must refuse to resolve, and there is no
 * acknowledgement affordance anywhere on the unattended retirement path.
 */
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const swarm = yield* SwarmV2.Service
  const execution = yield* SessionExecutionOwner.Service
  const retention = yield* SwarmRuntimeRetention.Service
  const retirement = yield* SwarmTaskRetirement.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/retirement-recovery"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({
      id: workspaceID,
      type: "local",
      name: "Swarm retirement recovery",
      project_id: projectID,
      time_used: 1,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: workerSessionID,
      project_id: projectID,
      workspace_id: workspaceID,
      slug: workerSessionID,
      directory: "/swarm/retirement-recovery",
      title: workerSessionID,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(RuntimeOwnerTable)
    .values([
      {
        id: currentRuntimeID,
        pid: 9101,
        started_at: 1,
        heartbeat_at: 10_000,
        control_epoch: 0,
      },
      {
        id: deadRuntimeID,
        pid: 9102,
        started_at: 1,
        heartbeat_at: 1,
        control_epoch: 0,
      },
    ])
    .run()
    .pipe(Effect.orDie)

  const created = yield* swarm.create({
    projectID,
    workspaceID,
    directory: "/swarm/retirement-recovery",
    name: "recovery swarm",
    now: 10,
  })
  const info = yield* swarm.update({
    id: created.id,
    expectedRevision: created.revision,
    status: "active",
    now: 15,
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

  const task = yield* swarm.createTask({ swarmID: info.id, title: "uncertain tool", now: 30 })
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
    content: { text: "run uncertain mutating tool" },
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
  yield* SessionInput.promoteLane(
    db,
    events,
    workerSessionID,
    { admissionClass: "host", delivery: "queue" },
    Number.MAX_SAFE_INTEGER,
  )

  yield* db
    .insert(SessionExecutionOwnerTable)
    .values({
      session_id: workerSessionID,
      generation: 7,
      owner_id: deadRuntimeID,
      acquired_at: 42,
    })
    .run()
    .pipe(Effect.orDie)

  const assistantMessageID = SessionMessage.ID.create()
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID: workerSessionID,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(43),
    agent: "build",
    model: {
      providerID: ProviderV2.ID.make("test"),
      id: ModelV2.ID.make("test-model"),
    },
  })
  yield* events.publish(SessionEvent.Tool.Input.Started, {
    sessionID: workerSessionID,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(44),
    callID: UNCERTAIN_CALL_ID,
    name: "bash",
  })
  yield* events.publish(SessionEvent.Tool.Called, {
    sessionID: workerSessionID,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(45),
    callID: UNCERTAIN_CALL_ID,
    tool: "bash",
    input: { command: "touch outcome-unknown" },
    provider: { executed: false },
  })

  yield* swarm.requestTaskRetirement({
    token: claim.token,
    reason: "lease_owner_lost",
    now: 46,
  })
  yield* retirement.poke()

  // Level-triggered convergence: the bounded drain may need more than one pass
  // to observe the recovery claim that pass just wrote.
  yield* waitFor(
    execution.snapshot(workerSessionID).pipe(
      Effect.map(
        (snapshot) => snapshot.ownerID === deadRuntimeID && snapshot.recoveryOwnerID === currentRuntimeID,
      ),
    ),
  )
  yield* waitFor(retirement.activeDrains().pipe(Effect.map((count) => count === 0)))

  return {
    db,
    events,
    swarm,
    execution,
    retirement,
    info,
    task,
    claim,
    runID,
    assistantMessageID,
  }
})

type State = Effect.Success<typeof setup>

const overlayFor = (state: State) =>
  state.db
    .select()
    .from(SessionMessageToolOverlayTable)
    .where(eq(SessionMessageToolOverlayTable.call_id, UNCERTAIN_CALL_ID))
    .get()
    .pipe(Effect.orDie)

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

const toolCallEvents = (state: State) =>
  state.db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, workerSessionID))
    .all()
    .pipe(Effect.orDie)
    .pipe(Effect.map((rows) => rows.filter((row) => row.type.includes(SessionEvent.Tool.Called.type)).length))

const toolSettlementEvents = (state: State) =>
  state.db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, workerSessionID))
    .all()
    .pipe(Effect.orDie)
    .pipe(
      Effect.map((rows) =>
        rows.filter((row) => row.type.includes(SessionEvent.Tool.Success.type)).length +
        rows.filter((row) => row.type.includes(SessionEvent.Tool.Failed.type)).length,
      ),
    )

const decodedToolState = (state: State) =>
  Effect.gen(function* () {
    const row = yield* state.db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, state.assistantMessageID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* Effect.die("missing assistant")
    const message = yield* SessionMessageProjection.decodeRow(state.db, row).pipe(Effect.orDie)
    if (message.type !== "assistant") return yield* Effect.die("expected an assistant message")
    return message.content.find((part) => part.type === "tool")?.state
  })

describe("Swarm dead-owner retirement recovery", () => {
  it.effect("never auto-seals an unresolved mutating effect and stays durably fenced without replay", () =>
    Effect.gen(function* () {
      const state = yield* setup

      expect(yield* state.execution.snapshot(workerSessionID)).toMatchObject({
        ownerID: deadRuntimeID,
        generation: 7,
        recoveryOwnerID: currentRuntimeID,
      })
      expect(yield* state.execution.tryAcquire(workerSessionID)).toMatchObject({
        state: "busy",
        snapshot: {
          ownerID: deadRuntimeID,
          generation: 7,
          recoveryOwnerID: currentRuntimeID,
        },
      })

      // The unresolved tool row is the durable evidence that keeps the
      // generation fenced. It must survive every unattended pass untouched.
      expect(yield* SessionRecovery.executionHazards(state.db, workerSessionID)).toEqual({
        currentTool: true,
        legacyTool: false,
      })
      expect((yield* overlayFor(state))?.settlement_event_id).toBeNull()
      expect(yield* decodedToolState(state)).toMatchObject({ status: "running" })

      expect(yield* leaseFor(state)).toMatchObject({
        state: "retiring",
        generation: state.claim.token.generation,
        retire_reason: "lease_owner_lost",
      })
      expect(yield* runFor(state)).toMatchObject({ status: "running" })
      expect(yield* taskRowFor(state)).toEqual({ status: "working", retry: 0 })

      const calledBefore = yield* toolCallEvents(state)
      const settledBefore = yield* toolSettlementEvents(state)
      expect(calledBefore).toBe(1)
      expect(settledBefore).toBe(0)

      // Repeated unattended drains are level-triggered and must converge to the
      // same fenced state: never sealing, never re-emitting the tool call, and
      // never releasing the dead owner's generation.
      for (let pass = 0; pass < 3; pass++) {
        yield* state.retirement.poke()
        yield* waitFor(state.retirement.activeDrains().pipe(Effect.map((count) => count === 0)))
      }

      expect((yield* overlayFor(state))?.settlement_event_id).toBeNull()
      expect(yield* decodedToolState(state)).toMatchObject({ status: "running" })
      expect(yield* toolCallEvents(state)).toBe(calledBefore)
      expect(yield* toolSettlementEvents(state)).toBe(settledBefore)
      expect(yield* leaseFor(state)).toMatchObject({ state: "retiring" })
      expect(yield* runFor(state)).toMatchObject({ status: "running" })
      expect(yield* taskRowFor(state)).toEqual({ status: "working", retry: 0 })
      expect(yield* state.execution.snapshot(workerSessionID)).toMatchObject({
        ownerID: deadRuntimeID,
        generation: 7,
        recoveryOwnerID: currentRuntimeID,
      })
    }),
  )

  it.effect("stays fenced indefinitely and never redispatches the task across repeated restarts", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const calledBefore = yield* toolCallEvents(state)
      const settledBefore = yield* toolSettlementEvents(state)

      // A restart re-runs the same level-triggered reconciliation from durable
      // rows. There is no timer here: each pass is an explicit fresh sweep, so
      // this asserts convergence rather than wall-clock expiry.
      for (let restart = 0; restart < 4; restart++) {
        yield* waitFor(state.retirement.activeDrains().pipe(Effect.map((count) => count === 0)))
        yield* state.retirement.poke()
        yield* waitFor(state.retirement.activeDrains().pipe(Effect.map((count) => count === 0)))

        expect(yield* state.execution.snapshot(workerSessionID)).toMatchObject({
          ownerID: deadRuntimeID,
          generation: 7,
          recoveryOwnerID: currentRuntimeID,
        })
        expect((yield* overlayFor(state))?.settlement_event_id).toBeNull()
        expect(yield* toolCallEvents(state)).toBe(calledBefore)
        expect(yield* toolSettlementEvents(state)).toBe(settledBefore)
      }

      // The task is never returned to a dispatchable state, so no replay storm
      // and no semantic retry budget consumption can start from this fence.
      expect(yield* leaseFor(state)).toMatchObject({ state: "retiring" })
      expect(yield* runFor(state)).toMatchObject({ status: "running" })
      expect(yield* taskRowFor(state)).toEqual({ status: "working", retry: 0 })
      expect(
        yield* state.swarm.readyAssignments().pipe(
          Effect.map((assignments) => assignments.filter((row) => row.task.id === state.task.id)),
        ),
      ).toEqual([])
    }),
  )
})