import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmTaskRunTable } from "@opencode-ai/core/swarm/sql"
import { eq } from "drizzle-orm"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SwarmSessionProjector.node, SwarmV2.node]),
  ),
)

const projectID = ProjectV2.ID.make("swarm-containment-core-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_containment_core")
const workerSession = SessionV2.ID.make("ses_swarm_containment_core_worker")

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/containment-core",
    title: id,
    version: "test",
  }
}

/**
 * One Swarm whose worker has a running task run, optionally parked in
 * `retiring` so both closure paths can be exercised against real durable rows.
 */
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const service = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/containment-core"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm containment", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values(sessionRow(workerSession))
    .run()
    .pipe(Effect.orDie)

  const created = yield* service.create({
    projectID,
    workspaceID,
    directory: "/swarm/containment-core",
    name: "containment swarm",
    now: 10,
  })
  const info = yield* service.update({
    id: created.id,
    expectedRevision: created.revision,
    status: "active",
    now: 11,
  })
  const reviewer = yield* service.addMember({
    swarmID: info.id,
    name: "reviewer",
    kind: "coordinator",
    role: "coordinator",
    workspacePolicy: { mode: "shared-read" },
    now: 12,
  })
  yield* service.update({
    id: info.id,
    expectedRevision: (yield* service.info(info.id)).revision,
    coordinatorMemberID: reviewer.id,
    now: 13,
  })
  const worker = yield* service.addMember({
    swarmID: info.id,
    name: "worker",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: managedProfile,
    sessionID: workerSession,
    workspacePolicy: { mode: "shared-read" },
    now: 14,
  })

  const task = yield* service.createTask({ swarmID: info.id, title: "mutating work", now: 20 })
  const claim = yield* service.claimTask({
    swarmID: info.id,
    taskID: task.id,
    memberID: worker.id,
    processOwner: "runtime-owner:containment-core",
    leaseMs: 60_000,
    now: 21,
  })
  const runID = Swarm.TaskRunID.create()
  const inputID = SessionMessage.ID.create()
  yield* SessionInput.admitSynthetic(db, events, {
    id: inputID,
    sessionID: workerSession,
    content: { text: "mutate the workspace" },
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
        admittedAt: 22,
      }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
  })
  yield* service.startTaskRun({ token: claim.token, runID, now: 23 })
  const readRun = () =>
    db
      .select()
      .from(SwarmTaskRunTable)
      .where(eq(SwarmTaskRunTable.id, runID))
      .get()
      .pipe(Effect.orDie)
  return { service, info, task, claim, runID, reviewerID: reviewer.id, readRun }
})

describe("Swarm contained_unknown settlement", () => {
  it.effect("requires an exact retiring lease and refuses without one", () =>
    Effect.gen(function* () {
      const { service, info, task, claim, runID } = yield* setup

      // A live (non-retiring) lease cannot be closed as a contained unknown:
      // that path is reserved for a fence an operator is actually resolving.
      const premature = yield* service
        .settleTask({
          token: claim.token,
          runID,
          settlement: { type: "contained_unknown", detail: "too early" },
          now: 24,
        })
        .pipe(Effect.exit)
      expect(premature._tag).toBe("Failure")
      expect((yield* service.get(info.id)).tasks.find((item) => item.id === task.id)?.status).toBe("working")
    }),
  )

  it.effect("parks the task in review_pending instead of redispatching a contained mutation", () =>
    Effect.gen(function* () {
      const { service, info, task, claim, runID, reviewerID, readRun } = yield* setup
      yield* service.requestTaskRetirement({ token: claim.token, reason: "lease_owner_lost", now: 30 })

      const settled = yield* service.settleTask({
        token: claim.token,
        runID,
        settlement: { type: "contained_unknown", detail: "effects contained; outcome unknown" },
        now: 31,
      })
      expect(settled.task.status).toBe("review_pending")
      expect(settled.task.semanticRetryCount).toBe(0)
      expect(settled.run?.status).toBe("unsettled")

      // Persistence parity: a fresh read of the durable row must carry the same
      // containment detail the returned object and the event advertise. A
      // hydrated-only detail would leave transcript and storage disagreeing.
      expect(yield* readRun()).toMatchObject({
        status: "unsettled",
        failure_detail: "effects contained; outcome unknown",
      })

      // Regression: the mutation may or may not have happened, so the task must
      // not be dispatchable. Only a deliberate review decision can retry it.
      const ready = yield* service.readyAssignments({ now: 32, limit: 16 })
      expect(ready.some((assignment) => assignment.task.id === task.id)).toBe(false)

      // A stale reviewer observation fails closed on the exact lease fence.
      const stale = yield* service
        .reviewTask({
          swarmID: info.id,
          taskID: task.id,
          reviewerMemberID: reviewerID,
          expectedLeaseGeneration: claim.token.generation,
          decision: { type: "accept" },
          now: 33,
        })
        .pipe(Effect.exit)
      expect(stale._tag).toBe("Failure")

      // Deliberate accept resolves it terminally.
      const accepted = yield* service.reviewTask({
        swarmID: info.id,
        taskID: task.id,
        reviewerMemberID: reviewerID,
        expectedLeaseGeneration: settled.task.leaseGeneration,
        decision: { type: "accept" },
        now: 34,
      })
      expect(accepted.status).toBe("completed")
      expect(accepted.semanticRetryCount).toBe(0)
    }),
  )

  it.effect("a deliberate reviewer retry is the only path back to dispatchable", () =>
    Effect.gen(function* () {
      const { service, info, task, claim, runID, reviewerID } = yield* setup
      yield* service.requestTaskRetirement({ token: claim.token, reason: "lease_owner_lost", now: 40 })
      const settled = yield* service.settleTask({
        token: claim.token,
        runID,
        settlement: { type: "contained_unknown", detail: "contained" },
        now: 41,
      })

      const retried = yield* service.reviewTask({
        swarmID: info.id,
        taskID: task.id,
        reviewerMemberID: reviewerID,
        expectedLeaseGeneration: settled.task.leaseGeneration,
        decision: { type: "retry" },
        now: 42,
      })
      expect(retried.status).toBe("ready")
      expect(retried.semanticRetryCount).toBe(0)
      const ready = yield* service.readyAssignments({ now: 43, limit: 16 })
      expect(ready.some((assignment) => assignment.task.id === task.id)).toBe(true)
    }),
  )

  it.effect("ordinary retirement supersession still returns the task to ready", () =>
    Effect.gen(function* () {
      const { service, info, task, claim, runID } = yield* setup
      yield* service.requestTaskRetirement({ token: claim.token, reason: "lease_owner_lost", now: 50 })

      // Unchanged operational semantics: supersession means "no unknown external
      // outcome", so the task is redispatchable immediately.
      const settled = yield* service.settleTask({
        token: claim.token,
        runID,
        settlement: { type: "superseded", detail: "retired after lease_owner_lost" },
        now: 51,
      })
      expect(settled.task.status).toBe("ready")
      expect(settled.task.semanticRetryCount).toBe(0)
      expect(settled.run?.status).toBe("superseded")
      const ready = yield* service.readyAssignments({ now: 52, limit: 16 })
      expect(ready.some((assignment) => assignment.task.id === task.id)).toBe(true)
    }),
  )
})
