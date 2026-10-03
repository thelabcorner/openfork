import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
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
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmTaskLeaseTable, SwarmTaskRunTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmRuntimeRetention } from "@/swarm/runtime-retention"
import { SwarmTaskRetirement } from "@/swarm/task-retirement"
import { testEffect } from "../lib/effect"

const currentRuntimeID = "runtime-owner:input-completion-current" as RuntimeOwner.ID
const deadRuntimeID = "runtime-owner:input-completion-dead" as RuntimeOwner.ID
const UNCERTAIN_CALL_ID = "call-uncertain-completion"

const runtimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: currentRuntimeID,
    pid: 9401,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void }),
    snapshot: (id) =>
      Effect.succeed(
        id === deadRuntimeID
          ? { id, pid: 9402, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }
          : id === currentRuntimeID
            ? { id, pid: 9401, startedAt: 1, heartbeatAt: 10_000, controlEpoch: 0 }
            : undefined,
      ),
    proveLocalDeath: (id) => Effect.succeed(id === deadRuntimeID ? "dead" : "alive-or-unknown"),
  }),
)

// SwarmTaskClosure is deliberately absent. Every settlement asserted here must
// come from SwarmTaskRetirement winning the crash race, never from the
// execution-end closure service.
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

const projectID = ProjectV2.ID.make("swarm-input-completion-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_input_completion")
const workerSessionID = SessionV2.ID.make("ses_swarm_input_completion_worker")

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

const base = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const swarm = yield* SwarmV2.Service
  const execution = yield* SessionExecutionOwner.Service
  const retention = yield* SwarmRuntimeRetention.Service
  const retirement = yield* SwarmTaskRetirement.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/input-completion"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm input completion", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: workerSessionID,
      project_id: projectID,
      workspace_id: workspaceID,
      slug: workerSessionID,
      directory: "/swarm/input-completion",
      title: workerSessionID,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(RuntimeOwnerTable)
    .values([
      { id: currentRuntimeID, pid: 9401, started_at: 1, heartbeat_at: 10_000, control_epoch: 0 },
      { id: deadRuntimeID, pid: 9402, started_at: 1, heartbeat_at: 1, control_epoch: 0 },
    ])
    .run()
    .pipe(Effect.orDie)

  const created = yield* swarm.create({
    projectID,
    workspaceID,
    directory: "/swarm/input-completion",
    name: "input completion swarm",
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
  return { db, events, swarm, execution, retention, retirement, info, worker }
})

type State = Effect.Success<typeof base>

/** Admit, promote, and (optionally) durably complete one exact assignment. */
const assignment = (state: State, title: string, opts: { readonly complete: boolean }) =>
  Effect.gen(function* () {
    const task = yield* state.swarm.createTask({ swarmID: state.info.id, title, now: 30 })
    const claim = yield* state.swarm.claimTask({
      swarmID: state.info.id,
      taskID: task.id,
      memberID: state.worker.id,
      processOwner: state.retention.ownerID,
      leaseMs: 60_000,
      now: 40,
    })
    const runID = Swarm.TaskRunID.create()
    const inputID = SessionMessage.ID.create()
    yield* SessionInput.admitSynthetic(state.db, state.events, {
      id: inputID,
      sessionID: workerSessionID,
      content: { text: title },
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
        SwarmV2.commitTaskRunAdmission(state.db, {
          token: claim.token,
          id: runID,
          sessionInputID: inputID,
          admittedAt: Date.now(),
        }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
    })
    yield* SessionInput.promoteLane(
      state.db,
      state.events,
      workerSessionID,
      { admissionClass: "host", delivery: "queue" },
      Number.MAX_SAFE_INTEGER,
    )
    if (opts.complete) {
      const result = yield* SessionInput.complete(state.db, state.events, {
        sessionID: workerSessionID,
        id: inputID,
      })
      if (result.state !== "completed")
        return yield* Effect.die(`assignment input was not marked complete: ${result.state}`)
    }
    return { task, claim, runID, inputID }
  })

/** A worker Session whose owner died with no in-flight tool work. */
const deadOwner = (state: State, generation: number) =>
  state.db
    .insert(SessionExecutionOwnerTable)
    .values({
      session_id: workerSessionID,
      generation,
      owner_id: deadRuntimeID,
      acquired_at: 42,
    })
    .run()
    .pipe(Effect.orDie)

/** One unresolved mutating tool call: unresolved external effect. */
const unresolvedTool = (state: State) =>
  Effect.gen(function* () {
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
      callID: UNCERTAIN_CALL_ID,
      name: "bash",
    })
    yield* state.events.publish(SessionEvent.Tool.Called, {
      sessionID: workerSessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(45),
      callID: UNCERTAIN_CALL_ID,
      tool: "bash",
      input: { command: "touch outcome-unknown" },
      provider: { executed: false },
    })
    return assistantMessageID
  })

const leaseFor = (state: State, taskID: Swarm.TaskID) =>
  state.db
    .select()
    .from(SwarmTaskLeaseTable)
    .where(eq(SwarmTaskLeaseTable.task_id, taskID))
    .get()
    .pipe(Effect.orDie)

const runFor = (state: State, runID: Swarm.TaskRunID) =>
  state.db
    .select()
    .from(SwarmTaskRunTable)
    .where(eq(SwarmTaskRunTable.id, runID))
    .get()
    .pipe(Effect.orDie)

const taskRowFor = (state: State, taskID: Swarm.TaskID) =>
  state.db
    .select({ status: SwarmTaskTable.status, retry: SwarmTaskTable.semantic_retry_count })
    .from(SwarmTaskTable)
    .where(eq(SwarmTaskTable.id, taskID))
    .get()
    .pipe(Effect.orDie)

const readyFor = (state: State, taskID: Swarm.TaskID) =>
  state.swarm.readyAssignments().pipe(
    Effect.map((assignments) => assignments.filter((row) => row.task.id === taskID)),
  )

describe("Swarm anti-replay via exact SessionInput completion", () => {
  it.effect(
    "retirement that wins the crash race after a completed assignment ends unsettled and review_pending, never ready",
    () =>
      Effect.gen(function* () {
        const state = yield* base
        const admitted = yield* assignment(state, "completed then owner lost", { complete: true })
        // The exact assignment input carries the completion fact.
        expect((yield* SessionInput.findEntry(state.db, admitted.inputID))?.completedSeq).toBeGreaterThan(0)
        yield* deadOwner(state, 7)
        yield* state.swarm.requestTaskRetirement({
          token: admitted.claim.token,
          reason: "lease_owner_lost",
          now: 46,
        })
        yield* state.retirement.poke()
        yield* waitFor(state.retirement.activeDrains().pipe(Effect.map((count) => count === 0)))

        // Execution-ended truth, never semantic success.
        expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "unsettled" })
        expect(yield* taskRowFor(state, admitted.task.id)).toEqual({ status: "review_pending", retry: 0 })
        // The anti-replay guarantee: already-produced work is never handed back.
        expect(yield* leaseFor(state, admitted.task.id)).toBeUndefined()
        expect(yield* readyFor(state, admitted.task.id)).toEqual([])
      }),
  )

  it.effect("an uncompleted assignment still retires operationally and returns to ready", () =>
    Effect.gen(function* () {
      const state = yield* base
      const admitted = yield* assignment(state, "never completed", { complete: false })
      yield* deadOwner(state, 7)
      yield* state.swarm.requestTaskRetirement({
        token: admitted.claim.token,
        reason: "lease_owner_lost",
        now: 46,
      })
      yield* state.retirement.poke()
      yield* waitFor(
        Effect.gen(function* () {
          return (yield* leaseFor(state, admitted.task.id)) === undefined
        }),
      )
      expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "superseded" })
      expect(yield* taskRowFor(state, admitted.task.id)).toEqual({ status: "ready", retry: 0 })
    }),
  )

  it.effect("a completed assignment with unresolved tool effects stays fenced and is never review-closed", () =>
    Effect.gen(function* () {
      const state = yield* base
      const admitted = yield* assignment(state, "completed with hazard", { complete: true })
      yield* deadOwner(state, 7)
      yield* unresolvedTool(state)

      yield* state.swarm.requestTaskRetirement({
        token: admitted.claim.token,
        reason: "lease_owner_lost",
        now: 46,
      })
      yield* state.retirement.poke()
      yield* waitFor(
        Effect.gen(function* () {
          return (yield* leaseFor(state, admitted.task.id)) !== undefined
        }),
      )
      yield* waitFor(state.retirement.activeDrains().pipe(Effect.map((count) => count === 0)))

      // effect-unknown outranks the completion marker: external effects nobody
      // observed keep their fence and are never closed for review.
      expect(yield* SessionRecovery.executionHazards(state.db, workerSessionID)).toEqual({
        currentTool: true,
        legacyTool: false,
      })
      for (let pass = 0; pass < 3; pass++) {
        yield* state.retirement.poke()
        yield* waitFor(state.retirement.activeDrains().pipe(Effect.map((count) => count === 0)))
        expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "running" })
        expect(yield* taskRowFor(state, admitted.task.id)).toEqual({ status: "working", retry: 0 })
      }
      expect(yield* readyFor(state, admitted.task.id)).toEqual([])
    }),
  )

  it.effect("a completed assignment under member_stop or operator_release still settles operationally", () =>
    Effect.gen(function* () {
      const state = yield* base
      for (const reason of ["member_stop", "operator_release"] as const) {
        const admitted = yield* assignment(state, `completed then ${reason}`, { complete: true })
        // Operator/lifecycle retirement takes the live-owner path: acquire,
        // request retirement, then release ownership to reach the idle barrier.
        const acquired = yield* state.execution.tryAcquire(workerSessionID)
        if (acquired.state !== "acquired")
          return yield* Effect.die(`could not acquire execution owner: ${acquired.state}`)
        yield* state.swarm.requestTaskRetirement({
          token: admitted.claim.token,
          reason,
          now: 46,
        })
        yield* state.retirement.poke()
        yield* waitFor(
          state.execution
            .snapshot(workerSessionID)
            .pipe(Effect.map((snapshot) => snapshot.interruptReason === "handoff")),
        )
        expect(yield* state.execution.release(acquired.token)).toBe("released")
        yield* state.events.publish(SessionStatusEvent.Idle, { sessionID: workerSessionID })
        yield* waitFor(
          Effect.gen(function* () {
            return (yield* leaseFor(state, admitted.task.id)) === undefined
          }),
        )

        // Operator/lifecycle semantics are deliberately not redesigned: these
        // remain operational supersessions, never review_pending.
        expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "superseded" })
        expect(yield* taskRowFor(state, admitted.task.id)).toEqual({ status: "ready", retry: 0 })
      }
    }),
  )

  it.effect("an explicit settlement still wins over the completion marker", () =>
    Effect.gen(function* () {
      const state = yield* base
      const admitted = yield* assignment(state, "explicitly settled", { complete: true })
      yield* state.swarm.settleTask({
        token: admitted.claim.token,
        runID: admitted.runID,
        settlement: { type: "completed" },
      })

      expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "completed" })
      expect(yield* taskRowFor(state, admitted.task.id)).toMatchObject({ status: "completed" })

      // Retirement afterwards has no active run or lease left, so a full scan
      // pass must not downgrade the explicit outcome with the marker.
      yield* state.retirement.poke()
      yield* waitFor(state.retirement.activeDrains().pipe(Effect.map((count) => count === 0)))
      expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "completed" })
      expect(yield* taskRowFor(state, admitted.task.id)).toMatchObject({ status: "completed" })
    }),
  )
})
