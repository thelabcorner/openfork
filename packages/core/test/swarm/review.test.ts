import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
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
import { SwarmTaskLeaseTable, SwarmTaskRunTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SwarmSessionProjector.node, SwarmV2.node]),
  ),
)

const projectID = ProjectV2.ID.make("swarm-review-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_review")
const workerSessionID = SessionV2.ID.make("ses_swarm_review_worker")
const coordinatorSessionID = SessionV2.ID.make("ses_swarm_review_coordinator")

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/review",
    title: id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/review"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm review", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([sessionRow(workerSessionID), sessionRow(coordinatorSessionID)])
    .run()
    .pipe(Effect.orDie)
  const swarm = yield* service.create({
    projectID,
    workspaceID,
    directory: "/swarm/review",
    name: "review swarm",
    now: 10,
  })
  const active = yield* service.update({
    id: swarm.id,
    expectedRevision: swarm.revision,
    status: "active",
    now: 11,
  })
  const worker = yield* service.addMember({
    swarmID: swarm.id,
    name: "worker",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: managedProfile,
    sessionID: workerSessionID,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  const coordinator = yield* service.addMember({
    swarmID: swarm.id,
    name: "coordinator",
    kind: "coordinator",
    role: "lead",
    sessionID: coordinatorSessionID,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  return { service, swarm: active, worker, coordinator, db }
})

/**
 * One assigned, started task run whose worker never settled. This is the only
 * state the review loop exists for: execution demonstrably happened, semantic
 * settlement did not.
 */
const unsettledAssignment = (state: Effect.Success<typeof setup>, title: string, suffix: string) =>
  Effect.gen(function* () {
    const { db, service, swarm, worker } = state
    const events = yield* EventV2.Service
    const task = yield* service.createTask({ swarmID: swarm.id, title, now: 100 })
    const claim = yield* service.claimTask({
      swarmID: swarm.id,
      taskID: task.id,
      memberID: worker.id,
      processOwner: "review-worker",
      leaseMs: 60_000,
      now: 101,
    })
    const runID = Swarm.TaskRunID.make(`swrn_review_${suffix}`)
    const inputID = SessionMessage.ID.make(`msg_swarm_review_${suffix}`)
    yield* SessionInput.admitSynthetic(db, events, {
      id: inputID,
      sessionID: workerSessionID,
      content: { text: title },
      origin: {
        producer: SessionTurnProvenance.Source.SwarmAssignment,
        actor: { type: "host" as const },
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
          admittedAt: 102,
        }).pipe(Effect.asVoid, Effect.catch((error) => Effect.die(error))),
    })
    yield* SessionInput.promoteLane(
      db,
      events,
      workerSessionID,
      { admissionClass: "host", delivery: "queue" },
      Number.MAX_SAFE_INTEGER,
    )
    return { task, claim, runID }
  })

const rowFor = (state: Effect.Success<typeof setup>, taskID: Swarm.TaskID) =>
  state.db
    .select({ status: SwarmTaskTable.status, retry: SwarmTaskTable.semantic_retry_count })
    .from(SwarmTaskTable)
    .where(eq(SwarmTaskTable.id, taskID))
    .get()
    .pipe(Effect.orDie)

const leaseExists = (state: Effect.Success<typeof setup>, taskID: Swarm.TaskID) =>
  state.db
    .select({ id: SwarmTaskLeaseTable.task_id })
    .from(SwarmTaskLeaseTable)
    .where(eq(SwarmTaskLeaseTable.task_id, taskID))
    .get()
    .pipe(Effect.orDie)

const dispatchable = (state: Effect.Success<typeof setup>, taskID: Swarm.TaskID) =>
  state.service
    .readyAssignments({ now: 1_000 })
    .pipe(Effect.map((assignments) => assignments.some((assignment) => assignment.task.id === taskID)))

describe("Swarm execution-end review loop", () => {
  it.effect("closes an unsettled execution into a non-dispatchable review state without replaying it", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const { service, swarm } = state
      const assignment = yield* unsettledAssignment(state, "never settled", "closure")

      const settled = yield* service.settleTask({
        token: assignment.claim.token,
        runID: assignment.runID,
        settlement: { type: "unsettled", detail: "worker execution ended without semantic settlement" },
        now: 200,
      })

      // Neither success nor semantic failure: the run is a truthful terminal
      // fact and the task consumes no semantic retry budget.
      expect(settled.run).toMatchObject({ status: "unsettled" })
      expect(settled.task).toMatchObject({ status: "review_pending", semanticRetryCount: 0 })
      expect(yield* rowFor(state, assignment.task.id)).toEqual({ status: "review_pending", retry: 0 })
      expect(yield* leaseExists(state, assignment.task.id)).toBeUndefined()
      expect(yield* dispatchable(state, assignment.task.id)).toBe(false)

      // Anti-replay: lease expiry and owner loss can no longer hand this back
      // out, because there is no live lease row to expire and no working row.
      expect(yield* service.expiredLeaseTargets({ now: Number.MAX_SAFE_INTEGER })).toHaveLength(0)
      expect(yield* service.retirementRequiredTargets()).toHaveLength(0)
      expect(yield* service.unsettledExecutionTargets()).toHaveLength(0)
      expect(swarm.id).toBeDefined()
    }),
  )

  it.effect("never infers settlement from an execution that merely started", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const assignment = yield* unsettledAssignment(state, "admitted but never started", "admitted")
      // Roll the run back to `admitted`: execution never actually began, so
      // `unsettled` must not be expressible and operational supersession owns it.
      yield* state.db
        .update(SwarmTaskRunTable)
        .set({ status: "admitted", started_at: null })
        .where(eq(SwarmTaskRunTable.id, assignment.runID))
        .run()
        .pipe(Effect.orDie)

      const exit = yield* state.service
        .settleTask({
          token: assignment.claim.token,
          runID: assignment.runID,
          settlement: { type: "unsettled" },
          now: 200,
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* rowFor(state, assignment.task.id)).toEqual({ status: "working", retry: 0 })
    }),
  )

  it.effect("requires a reviewer decision to redispatch, then accepts the reviewer result", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const { service, swarm, coordinator } = state
      const assignment = yield* unsettledAssignment(state, "needs review", "accept")
      const closed = yield* service.settleTask({
        token: assignment.claim.token,
        runID: assignment.runID,
        settlement: { type: "unsettled" },
        now: 200,
      })
      const generation = closed.task.leaseGeneration

      const accepted = yield* service.reviewTask({
        swarmID: swarm.id,
        taskID: assignment.task.id,
        reviewerMemberID: coordinator.id,
        expectedLeaseGeneration: generation,
        decision: { type: "accept" },
        now: 300,
      })
      expect(accepted.status).toBe("completed")
      expect(yield* rowFor(state, assignment.task.id)).toEqual({ status: "completed", retry: 0 })
      expect(yield* dispatchable(state, assignment.task.id)).toBe(false)

      // A completed decision is not re-decidable.
      const replay = yield* service
        .reviewTask({
          swarmID: swarm.id,
          taskID: assignment.task.id,
          reviewerMemberID: coordinator.id,
          expectedLeaseGeneration: generation,
          decision: { type: "retry" },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(replay)).toBe(true)
    }),
  )

  it.effect("keeps requesting changes and authorizing a retry as two separate deliberate steps", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const { service, swarm, coordinator } = state
      const assignment = yield* unsettledAssignment(state, "two step review", "changes")
      const closed = yield* service.settleTask({
        token: assignment.claim.token,
        runID: assignment.runID,
        settlement: { type: "unsettled" },
        now: 200,
      })

      const demanded = yield* service.reviewTask({
        swarmID: swarm.id,
        taskID: assignment.task.id,
        reviewerMemberID: coordinator.id,
        expectedLeaseGeneration: closed.task.leaseGeneration,
        decision: { type: "request_changes", detail: "artifacts are stale" },
        now: 300,
      })
      expect(demanded.status).toBe("changes_requested")
      // Non-dispatchable: demanding changes is not permission to rerun.
      expect(yield* dispatchable(state, assignment.task.id)).toBe(false)

      // Repeating the same demand is rejected rather than silently accepted.
      const repeated = yield* service
        .reviewTask({
          swarmID: swarm.id,
          taskID: assignment.task.id,
          reviewerMemberID: coordinator.id,
          expectedLeaseGeneration: demanded.leaseGeneration,
          decision: { type: "request_changes" },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(repeated)).toBe(true)

      const retried = yield* service.reviewTask({
        swarmID: swarm.id,
        taskID: assignment.task.id,
        reviewerMemberID: coordinator.id,
        expectedLeaseGeneration: demanded.leaseGeneration,
        decision: { type: "retry" },
        now: 400,
      })
      expect(retried.status).toBe("ready")
      expect(yield* dispatchable(state, assignment.task.id)).toBe(true)
    }),
  )

  it.effect("fences a stale reviewer and a reviewer that lost active authority", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const { service, swarm, coordinator, worker } = state
      const assignment = yield* unsettledAssignment(state, "fenced review", "fence")
      const closed = yield* service.settleTask({
        token: assignment.claim.token,
        runID: assignment.runID,
        settlement: { type: "unsettled" },
        now: 200,
      })

      const stale = yield* service
        .reviewTask({
          swarmID: swarm.id,
          taskID: assignment.task.id,
          reviewerMemberID: coordinator.id,
          expectedLeaseGeneration: closed.task.leaseGeneration - 1,
          decision: { type: "accept" },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)
      expect(yield* rowFor(state, assignment.task.id)).toEqual({ status: "review_pending", retry: 0 })

      yield* service.setMemberLifecycle({
        swarmID: swarm.id,
        memberID: coordinator.id,
        expectedLifecycle: "active",
        lifecycle: "stopped",
        now: 250,
      })

      const stopped = yield* service
        .reviewTask({
          swarmID: swarm.id,
          taskID: assignment.task.id,
          reviewerMemberID: coordinator.id,
          expectedLeaseGeneration: closed.task.leaseGeneration,
          decision: { type: "accept" },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(stopped)).toBe(true)
      expect(yield* rowFor(state, assignment.task.id)).toEqual({ status: "review_pending", retry: 0 })
      expect(worker.id).toBeDefined()
    }),
  )

  it.effect("refuses to review a task that still holds live execution authority", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const { service, swarm, coordinator } = state
      const assignment = yield* unsettledAssignment(state, "still working", "authority")

      const refused = yield* service
        .reviewTask({
          swarmID: swarm.id,
          taskID: assignment.task.id,
          reviewerMemberID: coordinator.id,
          expectedLeaseGeneration: assignment.claim.token.generation,
          decision: { type: "accept" },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(refused)).toBe(true)
      expect(yield* rowFor(state, assignment.task.id)).toEqual({ status: "working", retry: 0 })
      expect(yield* leaseExists(state, assignment.task.id)).toBeDefined()
    }),
  )

  it.effect("admits exactly one reviewer decision under concurrent review", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const { service, swarm, coordinator } = state
      const assignment = yield* unsettledAssignment(state, "concurrent review", "race")
      const closed = yield* service.settleTask({
        token: assignment.claim.token,
        runID: assignment.runID,
        settlement: { type: "unsettled" },
        now: 200,
      })

      const attempts = yield* Effect.all(
        ["accept", "retry", "fail", "cancel"].map((decision) =>
          service
            .reviewTask({
              swarmID: swarm.id,
              taskID: assignment.task.id,
              reviewerMemberID: coordinator.id,
              expectedLeaseGeneration: closed.task.leaseGeneration,
              decision: { type: decision as "accept" },
              now: 300,
            })
            .pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )

      expect(attempts.filter(Exit.isSuccess)).toHaveLength(1)
      const decided = yield* rowFor(state, assignment.task.id)
      // The row must still exist; the winning decision, not the losers, is durable.
      expect(decided).toBeDefined()
      const terminal: ReadonlyArray<Swarm.TaskStatus> = ["completed", "ready", "failed", "cancelled"]
      expect(terminal).toContain(decided!.status)
    }),
  )

  it.effect("promotes a dependent only after the reviewer accepts the unsettled prerequisite", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const { service, swarm, coordinator } = state
      const prerequisite = yield* unsettledAssignment(state, "prerequisite", "depend")
      const dependent = yield* service.createTask({
        swarmID: swarm.id,
        title: "dependent",
        dependencies: [{ taskID: prerequisite.task.id, requirement: "require_success" }],
        now: 100,
      })
      expect(dependent.status).toBe("blocked")
      expect(yield* dispatchable(state, dependent.id)).toBe(false)

      const closed = yield* service.settleTask({
        token: prerequisite.claim.token,
        runID: prerequisite.runID,
        settlement: { type: "unsettled" },
        now: 200,
      })
      // An unsettled prerequisite is not a success, so nothing may proceed.
      expect(yield* dispatchable(state, dependent.id)).toBe(false)

      yield* service.reviewTask({
        swarmID: swarm.id,
        taskID: prerequisite.task.id,
        reviewerMemberID: coordinator.id,
        expectedLeaseGeneration: closed.task.leaseGeneration,
        decision: { type: "accept" },
        now: 300,
      })
      expect(yield* dispatchable(state, dependent.id)).toBe(true)
    }),
  )
})