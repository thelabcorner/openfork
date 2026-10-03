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
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmRuntimeRetention } from "@/swarm/runtime-retention"
import { SwarmTaskClosure } from "@/swarm/task-closure"
import { testEffect } from "../lib/effect"

/**
 * Host-integration coverage for the execution-end closure service, complementing
 * `task-closure.test.ts` (fail-closed external-effect / dead-owner fencing).
 * This file owns the three lifecycle boundaries that must never regress:
 * normal execution end, live-execution refusal, and retirement precedence.
 */
const projectID = ProjectV2.ID.make("swarm-closure-svc-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_closure_svc")
const coordinatorSessionID = SessionV2.ID.make("ses_swarm_closure_svc_coordinator")
const workerSessionID = SessionV2.ID.make("ses_swarm_closure_svc_worker")

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
      SwarmTaskClosure.node,
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
    directory: "/swarm/closure-svc",
    title: id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const swarm = yield* SwarmV2.Service
  const retention = yield* SwarmRuntimeRetention.Service
  const closure = yield* SwarmTaskClosure.Service
  const execution = yield* SessionExecutionOwner.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/closure-svc"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm closure svc", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([sessionRow(coordinatorSessionID), sessionRow(workerSessionID)])
    .run()
    .pipe(Effect.orDie)

  const info = yield* swarm.create({
    projectID,
    workspaceID,
    directory: "/swarm/closure-svc",
    name: "closure service swarm",
    now: 10,
  })
  const active = yield* swarm.update({ id: info.id, expectedRevision: info.revision, status: "active", now: 15 })
  yield* swarm.addMember({
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
  return { db, events, swarm, retention, closure, execution, info: active, worker }
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

const taskStatus = (state: Effect.Success<typeof setup>, taskID: Swarm.TaskID) =>
  state.swarm.get(state.info.id).pipe(Effect.map((detail) => detail.tasks.find((task) => task.id === taskID)?.status))

/**
 * Full production assignment path: lease -> admitted host input -> canonical
 * promotion, which is what makes `running` truthful (projector invariant).
 */
const admitAndStart = (state: Effect.Success<typeof setup>, title: string) =>
  Effect.gen(function* () {
    const task = yield* state.swarm.createTask({ swarmID: state.info.id, title })
    const claim = yield* state.swarm.claimTask({
      swarmID: state.info.id,
      taskID: task.id,
      memberID: state.worker.id,
      processOwner: state.retention.ownerID,
      leaseMs: 600_000,
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
    expect(yield* runFor(state, runID)).toMatchObject({ status: "running" })
    return { task, claim, runID, inputID }
  })

describe("Swarm execution-end closure service lifecycle", () => {
  it.live("closes a normally finished execution that never settled, with no replay", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const started = yield* admitAndStart(state, "worker finished without settling")

      const acquired = yield* state.execution.tryAcquire(workerSessionID)
      expect(acquired.state).toBe("acquired")
      if (acquired.state !== "acquired") return
      expect(yield* state.execution.release(acquired.token)).toBe("released")

      // The host-owned natural idle event is the completion evidence. An
      // arbitrary closure poke is deliberately insufficient.
      yield* state.events.publish(SessionStatusEvent.Idle, { sessionID: workerSessionID })
      yield* waitFor(
        Effect.gen(function* () {
          return (yield* leaseFor(state, started.task.id)) === undefined
        }),
      )

      expect(yield* runFor(state, started.runID)).toMatchObject({ status: "unsettled" })
      expect(yield* taskStatus(state, started.task.id)).toBe("review_pending")
      // Anti-replay: the produced work is never handed back out as ready work.
      const ready = yield* state.swarm.readyAssignments({ now: Date.now() })
      expect(ready.map((assignment) => assignment.task.id)).not.toContain(started.task.id)
    }),
  )

  it.live("never closes while the Session execution owner is still live", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const started = yield* admitAndStart(state, "still executing")

      const acquired = yield* state.execution.tryAcquire(workerSessionID)
      expect(acquired.state).toBe("acquired")
      if (acquired.state !== "acquired") return

      // Idle may publish just before the execution-owner release boundary. The
      // first closure pass must block, then its bounded probe must converge once
      // the canonical owner is released — without needing an unrelated event.
      yield* state.events.publish(SessionStatusEvent.Idle, { sessionID: workerSessionID })
      yield* waitFor(state.closure.activeDrains().pipe(Effect.map((count) => count === 0)))

      expect(yield* leaseFor(state, started.task.id)).toMatchObject({ state: "active" })
      expect(yield* runFor(state, started.runID)).toMatchObject({ status: "running" })
      expect(yield* taskStatus(state, started.task.id)).toBe("working")

      expect(yield* state.execution.release(acquired.token)).toBe("released")
      yield* Effect.sleep("2100 millis")
      yield* waitFor(
        taskStatus(state, started.task.id).pipe(
          Effect.map((status) => status === "review_pending"),
          Effect.orDie,
        ),
      )
      expect(yield* runFor(state, started.runID)).toMatchObject({ status: "unsettled" })
    }),
  )

  it.live("leaves a superseding retirement intact instead of racing it", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const started = yield* admitAndStart(state, "retirement wins the race")

      const acquired = yield* state.execution.tryAcquire(workerSessionID)
      expect(acquired.state).toBe("acquired")
      if (acquired.state !== "acquired") return
      yield* state.execution.release(acquired.token)

      yield* state.swarm.requestTaskRetirement({
        token: started.claim.token,
        reason: "operator_release",
      })

      yield* state.events.publish(SessionStatusEvent.Idle, { sessionID: workerSessionID })
      yield* waitFor(state.closure.activeDrains().pipe(Effect.map((count) => count === 0)))

      // Retirement keeps sole ownership of the outcome; closure must not
      // convert a superseding retirement into an unsettled review.
      expect(yield* leaseFor(state, started.task.id)).toMatchObject({ state: "retiring" })
      expect(yield* runFor(state, started.runID)).toMatchObject({ status: "running" })
      expect(yield* taskStatus(state, started.task.id)).toBe("working")
    }),
  )
})