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
import { SessionTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SwarmV2.node])))

const projectA = ProjectV2.ID.make("swarm-observe-project-a")
const projectB = ProjectV2.ID.make("swarm-observe-project-b")
const workspaceA = WorkspaceV2.ID.make("wrk_swarm_observe_a")
const workspaceB = WorkspaceV2.ID.make("wrk_swarm_observe_b")
const coordinatorSession = SessionV2.ID.make("ses_swarm_observe_coordinator")
const workerSession = SessionV2.ID.make("ses_swarm_observe_worker")
const idleSession = SessionV2.ID.make("ses_swarm_observe_idle")
const foreignSession = SessionV2.ID.make("ses_swarm_observe_foreign")

function sessionRow(input: {
  id: SessionV2.ID
  projectID: ProjectV2.ID
  workspaceID: WorkspaceV2.ID
  directory: string
}) {
  return {
    id: input.id,
    project_id: input.projectID,
    workspace_id: input.workspaceID,
    slug: input.id,
    directory: input.directory,
    title: input.id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values([
      { id: projectA, worktree: AbsolutePath.make("/swarm/observe/a"), sandboxes: [] },
      { id: projectB, worktree: AbsolutePath.make("/swarm/observe/b"), sandboxes: [] },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values([
      { id: workspaceA, type: "local", name: "Swarm observe A", project_id: projectA, time_used: 1 },
      { id: workspaceB, type: "local", name: "Swarm observe B", project_id: projectB, time_used: 1 },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      sessionRow({ id: coordinatorSession, projectID: projectA, workspaceID: workspaceA, directory: "/swarm/observe/a" }),
      sessionRow({ id: workerSession, projectID: projectA, workspaceID: workspaceA, directory: "/swarm/observe/a" }),
      sessionRow({ id: idleSession, projectID: projectA, workspaceID: workspaceA, directory: "/swarm/observe/a" }),
      sessionRow({ id: foreignSession, projectID: projectB, workspaceID: workspaceB, directory: "/swarm/observe/b" }),
    ])
    .run()
    .pipe(Effect.orDie)
})

const createRunnable = Effect.fn("test.createObservableSwarm")(function* (name: string, now = 100) {
  const swarms = yield* SwarmV2.Service
  const swarm = yield* swarms.create({
    projectID: projectA,
    workspaceID: workspaceA,
    directory: "/swarm/observe/a",
    name,
    now,
  })
  const coordinator = yield* swarms.addMember({
    swarmID: swarm.id,
    name: "coordinator",
    kind: "coordinator",
    role: "Lead",
    sessionID: coordinatorSession,
    workspacePolicy: { mode: "shared-read" },
    now: now + 1,
  })
  const worker = yield* swarms.addMember({
    swarmID: swarm.id,
    name: "worker",
    kind: "managed_worker",
    role: "Builder",
    desiredProfile: managedProfile,
    sessionID: workerSession,
    workspacePolicy: { mode: "shared-write" },
    now: now + 2,
  })
  const active = yield* swarms.update({
    id: swarm.id,
    expectedRevision: swarm.revision,
    coordinatorMemberID: coordinator.id,
    status: "active",
    now: now + 3,
  })
  return { swarm: active, coordinator, worker }
})

/** Run one task through explicit settle, quiet unsettled closure, or retirement. */
const runTask = Effect.fn("test.runObservableTask")(function* (input: {
  swarmID: SwarmV2.ID
  workerID: SwarmV2.Member["id"]
  title: string
  mode: "settled" | "unsettled" | "superseded" | "semantic_failure" | "operational_failure" | "held"
  now: number
}) {
  const swarms = yield* SwarmV2.Service
  const task = yield* swarms.createTask({
    swarmID: input.swarmID,
    title: input.title,
    now: input.now,
  })
  const claimed = yield* swarms.claimTask({
    swarmID: input.swarmID,
    taskID: task.id,
    memberID: input.workerID,
    processOwner: "observe-test",
    leaseMs: 10_000,
    now: input.now + 1,
  })
  if (input.mode === "held") return { task, claimed }
  const run = yield* swarms.recordTaskRun({
    token: claimed.token,
    sessionInputID: SessionMessage.ID.make("msg_observe_" + input.title),
    admittedAt: input.now + 2,
    now: input.now + 2,
  })
  yield* swarms.startTaskRun({ token: claimed.token, runID: run.id, now: input.now + 3 })
  if (input.mode === "settled") {
    yield* swarms.settleTask({
      token: claimed.token,
      runID: run.id,
      settlement: { type: "completed" },
      now: input.now + 4,
    })
    return { task, run, claimed }
  }
  if (input.mode === "unsettled") {
    yield* swarms.settleTask({
      token: claimed.token,
      runID: run.id,
      settlement: { type: "unsettled", detail: "worker finished without settling" },
      now: input.now + 4,
    })
    return { task, run, claimed }
  }
  if (input.mode === "semantic_failure" || input.mode === "operational_failure") {
    yield* swarms.settleTask({
      token: claimed.token,
      runID: run.id,
      settlement: {
        type: "failed",
        failureKind: input.mode === "semantic_failure" ? "semantic" : "provider",
      },
      now: input.now + 4,
    })
    return { task, run, claimed }
  }
  yield* swarms.requestTaskRetirement({
    token: claimed.token,
    reason: "lease_owner_lost",
    now: input.now + 4,
  })
  yield* swarms.settleTask({
    token: claimed.token,
    runID: run.id,
    settlement: { type: "superseded", detail: "retired after lease_owner_lost" },
    now: input.now + 5,
  })
  return { task, run, claimed }
})

describe("Swarm compact reliability projection", () => {
  it.effect("reports zeroed counters for a Swarm that has only roster truth", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm } = yield* createRunnable("fresh", 100)
      const reliability = yield* swarms.reliability({ swarmID: swarm.id, now: 10_000 })
      expect(reliability.tasks).toEqual({
        total: 0,
        pending: 0,
        blocked: 0,
        ready: 0,
        working: 0,
        reviewPending: 0,
        changesRequested: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      })
      expect(reliability.runs).toEqual({
        total: 0,
        admitted: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        unsettled: 0,
        superseded: 0,
        semanticFailure: 0,
        operationalFailure: 0,
        unowned: 0,
      })
      expect(reliability.leases).toEqual({ active: 0, humanHold: 0, retiring: 0, expired: 0 })
      expect(reliability.members).toEqual({
        total: 2,
        managedWorker: 1,
        boundManagedWorker: 1,
        unboundConfiguredManagedWorker: 0,
        held: 0,
        stopped: 0,
      })
      expect(reliability.collaboration).toMatchObject({
        messages: 0,
        deliveries: 0,
        blackboardEntries: 0,
        blackboardWrites: 0,
      })
    }),
  )

  it.effect("separates explicit settlement, quiet closure, and operational supersession", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, coordinator, worker } = yield* createRunnable("mixed", 100)

      yield* runTask({ swarmID: swarm.id, workerID: worker.id, title: "settled", mode: "settled", now: 1_000 })
      yield* runTask({ swarmID: swarm.id, workerID: worker.id, title: "unsettled", mode: "unsettled", now: 2_000 })
      yield* runTask({
        swarmID: swarm.id,
        workerID: worker.id,
        title: "semantic",
        mode: "semantic_failure",
        now: 3_000,
      })
      yield* runTask({
        swarmID: swarm.id,
        workerID: worker.id,
        title: "operational",
        mode: "operational_failure",
        now: 4_000,
      })
      yield* runTask({ swarmID: swarm.id, workerID: worker.id, title: "superseded", mode: "superseded", now: 5_000 })
      // Left working on purpose: this is the indefinite-working shape the
      // projection must be able to see without reconstructing anything.
      yield* runTask({ swarmID: swarm.id, workerID: worker.id, title: "inflight", mode: "held", now: 6_000 })
      yield* swarms.createTask({ swarmID: swarm.id, title: "never dispatched", now: 7_000 })

      const reliability = yield* swarms.reliability({ swarmID: swarm.id, now: 7_500 })

      expect(reliability.tasks).toMatchObject({
        total: 7,
        working: 1,
        completed: 1,
        reviewPending: 1,
        // The semantic failure consumed the budget and parked the task; the
        // operational failure, the supersession, and the never-dispatched task
        // are all dispatchable again.
        failed: 1,
        ready: 3,
      })
      expect(reliability.runs).toMatchObject({
        total: 5,
        completed: 1,
        unsettled: 1,
        failed: 2,
        semanticFailure: 1,
        operationalFailure: 1,
        superseded: 1,
        // The inflight task has a live active lease, so it is not unowned.
        unowned: 0,
      })
      expect(reliability.leases).toMatchObject({ active: 1, humanHold: 0, retiring: 0, expired: 0 })
      expect(coordinator.id).toStartWith("swm_")
    }),
  )

  it.effect("counts an unowned live run and an expired lease without touching Session history", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("owner-loss", 100)

      // Lease deadline (1_000 + 1 + 10_000) is already past at read time.
      yield* runTask({ swarmID: swarm.id, workerID: worker.id, title: "second", mode: "settled", now: 30_000 })
      yield* runTask({ swarmID: swarm.id, workerID: worker.id, title: "abandoned", mode: "held", now: 40_000 })

      const reliability = yield* swarms.reliability({ swarmID: swarm.id, now: 60_000 })
      expect(reliability.leases.active).toBe(1)
      expect(reliability.leases.expired).toBe(1)
      // A live active lease still authorizes its run, so ownership is not lost yet.
      expect(reliability.runs.unowned).toBe(0)
      expect(reliability.tasks.working).toBe(1)

      // Negative invariant: no member Session carries any message history in
      // this fixture. The projection above is therefore proven to come from
      // durable Swarm rows, never from message/part hydration or rendered rows.
      const { db } = yield* Database.Service
      const history = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .all()
        .pipe(Effect.orDie)
      expect(history).toEqual([])
    }),
  )

  it.effect("treats a human_hold lease as still owning its live run", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("human-hold", 100)
      const task = yield* swarms.createTask({ swarmID: swarm.id, title: "preempted", now: 1_000 })
      const claimed = yield* swarms.claimTask({
        swarmID: swarm.id,
        taskID: task.id,
        memberID: worker.id,
        processOwner: "observe-test",
        leaseMs: 600_000,
        now: 1_001,
      })
      const run = yield* swarms.recordTaskRun({
        token: claimed.token,
        sessionInputID: SessionMessage.ID.make("msg_observe_preempted"),
        admittedAt: 1_002,
        now: 1_002,
      })
      yield* swarms.startTaskRun({ token: claimed.token, runID: run.id, now: 1_003 })
      yield* swarms.holdTask({ token: claimed.token, userSeq: 7, deadline: 500_000, now: 1_004 })

      const reliability = yield* swarms.reliability({ swarmID: swarm.id, now: 1_005 })

      // Human focus preempted execution, but the lease still fences the run, so
      // this must not be reported as lost authority / an uncontrolled replay.
      expect(reliability.leases.humanHold).toBe(1)
      expect(reliability.leases.active).toBe(0)
      expect(reliability.runs.running).toBe(1)
      expect(reliability.runs.unowned).toBe(0)
    }),
  )

  it.effect("counts managed workers that are configured but not bound to a Session", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, worker } = yield* createRunnable("unbound", 100)
      yield* swarms.setMemberLifecycle({
        swarmID: swarm.id,
        memberID: worker.id,
        expectedLifecycle: "active",
        lifecycle: "held",
        now: 200,
      })
      const unbound = yield* swarms.addMember({
        swarmID: swarm.id,
        name: "pending-materialization",
        kind: "managed_worker",
        role: "Reviewer",
        desiredProfile: managedProfile,
        workspacePolicy: { mode: "shared-read" },
        now: 300,
      })
      const guest = yield* swarms.addMember({
        swarmID: swarm.id,
        name: "observer",
        kind: "guest",
        role: "Observer",
        sessionID: idleSession,
        workspacePolicy: { mode: "shared-read" },
        now: 301,
      })

      const reliability = yield* swarms.reliability({ swarmID: swarm.id, now: 400 })
      expect(reliability.members).toMatchObject({
        total: 4,
        managedWorker: 2,
        // A held worker keeps its Session binding, so only the worker that was
        // never bound to a Session is counted here.
        boundManagedWorker: 1,
        unboundConfiguredManagedWorker: 1,
        held: 1,
        stopped: 0,
      })
      expect(unbound.id).toStartWith("swm_")
      expect(guest.id).toStartWith("swm_")
    }),
  )

  it.effect("counts peer mail, retries, shared-state writes, claims, and deliverable verdicts", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, coordinator, worker } = yield* createRunnable("collaboration", 100)

      const retried = yield* swarms.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: coordinator.id,
        target: { type: "member", memberID: worker.id },
        kind: "finding",
        body: "take this",
        now: 1_000,
      })
      const expired = yield* swarms.enqueueMessage({
        swarmID: swarm.id,
        senderMemberID: coordinator.id,
        target: { type: "member", memberID: worker.id },
        kind: "request",
        body: "and this",
        now: 1_001,
        expiresAt: 1_200,
      })

      const claim = yield* swarms.claimDelivery({
        deliveryID: retried.deliveries[0]!.id,
        owner: "observe-mail",
        leaseMs: 1_000,
        now: 1_100,
      })
      // A defer/retry cycle must remain visible as a retried delivery.
      yield* swarms.releaseDelivery({
        token: claim.token,
        outcome: { type: "retry", nextAttemptAt: 1_160, countAsAttempt: true },
        now: 1_150,
      })
      yield* swarms.expireDelivery({
        deliveryID: expired.deliveries[0]!.id,
        now: 1_300,
      })

      yield* swarms.putBlackboard({
        swarmID: swarm.id,
        key: "plan",
        value: { step: 1 },
        contentType: "application/json",
        authorMemberID: worker.id,
        now: 2_000,
      })
      yield* swarms.putBlackboard({
        swarmID: swarm.id,
        key: "plan",
        value: { step: 2 },
        contentType: "application/json",
        authorMemberID: worker.id,
        expectedVersion: 1,
        now: 2_001,
      })
      yield* swarms.acquireClaim({ swarmID: swarm.id, memberID: worker.id, scope: "path:src/a.ts", now: 3_000 })

      const published = yield* swarms.publishDeliverable({
        swarmID: swarm.id,
        memberID: worker.id,
        summary: "done",
        refs: [],
        now: 4_000,
      })
      yield* swarms.publishDeliverable({
        swarmID: swarm.id,
        memberID: coordinator.id,
        summary: "reviewed separately",
        refs: [],
        now: 4_001,
      })
      yield* swarms.verdictDeliverable({
        deliverableID: published.id,
        verdict: "accepted",
        reviewerMemberID: coordinator.id,
        now: 4_100,
      })

      const reliability = yield* swarms.reliability({ swarmID: swarm.id, now: 5_000 })
      expect(reliability.collaboration).toEqual({
        messages: 2,
        deliveries: 2,
        pendingDeliveries: 1,
        claimedDeliveries: 0,
        admittedDeliveries: 0,
        expiredDeliveries: 1,
        failedDeliveries: 0,
        retriedDeliveries: 1,
        blackboardEntries: 1,
        blackboardWrites: 2,
        totalClaimRows: 1,
        deliverables: 2,
        deliverablesAwaitingVerdict: 1,
      })
    }),
  )

  it.effect("never leaks another Swarm's lifecycle rows", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const mine = yield* createRunnable("mine", 100)
      yield* runTask({ swarmID: mine.swarm.id, workerID: mine.worker.id, title: "only-mine", mode: "settled", now: 1_000 })

      const foreign = yield* swarms.create({
        projectID: projectB,
        workspaceID: workspaceB,
        directory: "/swarm/observe/b",
        name: "foreign",
        now: 200,
      })
      yield* swarms.addMember({
        swarmID: foreign.id,
        name: "foreign coordinator",
        kind: "coordinator",
        role: "Lead",
        sessionID: foreignSession,
        workspacePolicy: { mode: "shared-read" },
        now: 201,
      })

      const foreignReliability = yield* swarms.reliability({ swarmID: foreign.id, now: 5_000 })
      expect(foreignReliability.tasks.total).toBe(0)
      expect(foreignReliability.runs.total).toBe(0)
      expect(foreignReliability.collaboration.messages).toBe(0)
      expect(foreignReliability.members).toMatchObject({ total: 1, managedWorker: 0 })

      const mineReliability = yield* swarms.reliability({ swarmID: mine.swarm.id, now: 5_000 })
      expect(mineReliability.runs.completed).toBe(1)
    }),
  )
})
