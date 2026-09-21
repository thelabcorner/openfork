import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmTaskLeaseTable, SwarmTaskRunTable } from "@opencode-ai/core/swarm/sql"
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

const projectID = ProjectV2.ID.make("swarm-retirement-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_retirement")
const coordinatorSessionID = SessionV2.ID.make("ses_swarm_retirement_coordinator")
const workerSessionID = SessionV2.ID.make("ses_swarm_retirement_worker")
const reboundSessionID = SessionV2.ID.make("ses_swarm_retirement_rebound")

const managedProfile = Swarm.MemberExecutionProfile.make({
  agent: AgentModel.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("test-model"),
  },
  permissionBoundary: [],
})

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
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/retirement",
    title: id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const swarm = yield* SwarmV2.Service
  const retention = yield* SwarmRuntimeRetention.Service
  const retirement = yield* SwarmTaskRetirement.Service
  const execution = yield* SessionExecutionOwner.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/retirement"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm retirement", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([sessionRow(coordinatorSessionID), sessionRow(workerSessionID), sessionRow(reboundSessionID)])
    .run()
    .pipe(Effect.orDie)

  const info = yield* swarm.create({
    projectID,
    workspaceID,
    directory: "/swarm/retirement",
    name: "retirement swarm",
    now: 10,
  })
  const active = yield* swarm.update({
    id: info.id,
    expectedRevision: info.revision,
    status: "active",
    now: 15,
  })
  const coordinator = yield* swarm.addMember({
    swarmID: info.id,
    name: "coordinator",
    kind: "coordinator",
    role: "lead",
    sessionID: coordinatorSessionID,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  const worker = yield* swarm.addMember({
    swarmID: info.id,
    name: "worker",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: managedProfile,
    sessionID: workerSessionID,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  yield* retention.ensure()
  return { db, events, swarm, retention, retirement, execution, info: active, coordinator, worker }
})

const waitFor = (predicate: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let index = 0; index < 4_000; index++) {
      if (yield* predicate) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("waitFor timed out"))
  })

const leaseFor = (state: Effect.Success<typeof setup>, taskID: Swarm.TaskID) =>
  state.db
    .select()
    .from(SwarmTaskLeaseTable)
    .where(eq(SwarmTaskLeaseTable.task_id, taskID))
    .get()
    .pipe(Effect.orDie)

const runFor = (state: Effect.Success<typeof setup>, runID: Swarm.TaskRunID) =>
  state.db
    .select()
    .from(SwarmTaskRunTable)
    .where(eq(SwarmTaskRunTable.id, runID))
    .get()
    .pipe(Effect.orDie)

const taskFor = (state: Effect.Success<typeof setup>, taskID: Swarm.TaskID) =>
  state.swarm.get(state.info.id).pipe(Effect.map((detail) => detail.tasks.find((task) => task.id === taskID)))

const admitAssignment = (state: Effect.Success<typeof setup>, title: string) =>
  Effect.gen(function* () {
    const task = yield* state.swarm.createTask({ swarmID: state.info.id, title })
    const claim = yield* state.swarm.claimTask({
      swarmID: state.info.id,
      taskID: task.id,
      memberID: state.worker.id,
      processOwner: state.retention.ownerID,
      leaseMs: 60_000,
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
    return { task, claim, runID, inputID }
  })

describe("Swarm task retirement", () => {
  it.live("revokes an admitted pending assignment and supersedes operationally", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const admitted = yield* admitAssignment(state, "pending retirement")
      yield* state.swarm.requestTaskRetirement({
        token: admitted.claim.token,
        reason: "operator_release",
      })
      yield* state.retirement.poke()

      yield* waitFor(
        Effect.gen(function* () {
          return (yield* leaseFor(state, admitted.task.id)) === undefined
        }),
      )

      const input = yield* SessionInput.findEntry(state.db, admitted.inputID)
      expect(input?.revokedSeq).toBeDefined()
      expect(input?.promotedSeq).toBeUndefined()
      expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "superseded" })
      expect(yield* taskFor(state, admitted.task.id)).toMatchObject({
        status: "ready",
        semanticRetryCount: 0,
      })
    }),
  )

  it.live("running retirement requests a fenced interrupt but does not transfer or release Session ownership", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const admitted = yield* admitAssignment(state, "running retirement")
      const promoted = yield* SessionInput.promoteLane(
        state.db,
        state.events,
        workerSessionID,
        { admissionClass: "host", delivery: "queue" },
        Number.MAX_SAFE_INTEGER,
      )
      expect(promoted.promoted).toBe(1)
      expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "running" })

      const acquired = yield* state.execution.tryAcquire(workerSessionID)
      expect(acquired.state).toBe("acquired")
      if (acquired.state !== "acquired") return

      yield* state.swarm.requestTaskRetirement({
        token: admitted.claim.token,
        reason: "operator_release",
      })
      yield* state.retirement.poke()
      yield* waitFor(
        state.execution
          .snapshot(workerSessionID)
          .pipe(Effect.map((snapshot) => snapshot.interruptReason === "handoff")),
      )
      yield* waitFor(state.retirement.activeDrains().pipe(Effect.map((count) => count === 0)))

      const snapshot = yield* state.execution.snapshot(workerSessionID)
      expect(snapshot.ownerID).toBe(acquired.token.ownerID)
      expect(snapshot.generation).toBe(acquired.token.generation)
      expect(snapshot.interruptReason).toBe("handoff")
      expect(yield* leaseFor(state, admitted.task.id)).toMatchObject({ state: "retiring" })
      expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "running" })
      expect(yield* taskFor(state, admitted.task.id)).toMatchObject({ status: "working" })
    }),
  )

  it.live("settles a running retirement only after Session ownership reaches the idle quiescence barrier", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const admitted = yield* admitAssignment(state, "idle retirement")
      yield* SessionInput.promoteLane(
        state.db,
        state.events,
        workerSessionID,
        { admissionClass: "host", delivery: "queue" },
        Number.MAX_SAFE_INTEGER,
      )
      const acquired = yield* state.execution.tryAcquire(workerSessionID)
      expect(acquired.state).toBe("acquired")
      if (acquired.state !== "acquired") return

      yield* state.swarm.requestTaskRetirement({
        token: admitted.claim.token,
        reason: "operator_release",
      })
      yield* state.retirement.poke()
      yield* waitFor(
        state.execution
          .snapshot(workerSessionID)
          .pipe(Effect.map((snapshot) => snapshot.interruptReason === "handoff")),
      )
      expect(yield* leaseFor(state, admitted.task.id)).toMatchObject({ state: "retiring" })

      expect(yield* state.execution.release(acquired.token)).toBe("released")
      yield* state.events.publish(SessionStatusEvent.Idle, { sessionID: workerSessionID })

      yield* waitFor(
        Effect.gen(function* () {
          return (yield* leaseFor(state, admitted.task.id)) === undefined
        }),
      )
      expect(yield* state.execution.snapshot(workerSessionID)).toMatchObject({
        generation: acquired.token.generation,
      })
      expect((yield* state.execution.snapshot(workerSessionID)).ownerID).toBeUndefined()
      expect(yield* runFor(state, admitted.runID)).toMatchObject({ status: "superseded" })
      expect(yield* taskFor(state, admitted.task.id)).toMatchObject({
        status: "ready",
        semanticRetryCount: 0,
      })
    }),
  )

  it.live("member rebind converges through the same retirement barrier without a TaskRun", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const task = yield* state.swarm.createTask({ swarmID: state.info.id, title: "rebind retirement" })
      const claim = yield* state.swarm.claimTask({
        swarmID: state.info.id,
        taskID: task.id,
        memberID: state.worker.id,
        processOwner: state.retention.ownerID,
        leaseMs: 60_000,
      })

      yield* state.swarm.rebindMember({
        swarmID: state.info.id,
        memberID: state.worker.id,
        expectedBindingGeneration: state.worker.bindingGeneration,
        sessionID: reboundSessionID,
      })
      yield* state.retirement.poke()

      yield* waitFor(
        Effect.gen(function* () {
          return (yield* leaseFor(state, task.id)) === undefined
        }),
      )
      expect(
        yield* state.db
          .select()
          .from(SwarmTaskRunTable)
          .where(eq(SwarmTaskRunTable.task_id, task.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(yield* taskFor(state, task.id)).toMatchObject({
        status: "ready",
        semanticRetryCount: 0,
        leaseGeneration: claim.token.generation + 1,
      })
    }),
  )
})
