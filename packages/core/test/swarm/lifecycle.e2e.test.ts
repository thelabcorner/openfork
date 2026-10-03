import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { testEffect } from "../lib/effect"
import {
  closeWithoutSettlement,
  delegateSwarm,
  dispatchableTaskIDs,
  dispatchAssignment,
  e2eScope,
  materializeWorkers,
  peerRoundtrip,
  preemptPendingAssignment,
  promoteAssignment,
  settleExplicitly,
} from "./e2e-fixture"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SwarmSessionProjector.node, SwarmV2.node]),
  ),
)

const bootstrap = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const scope = e2eScope("swarm-e2e")
  yield* db
    .insert(ProjectTable)
    .values({ id: scope.projectID, worktree: AbsolutePath.make(scope.directory), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({
      id: scope.workspaceID,
      type: "local",
      name: "Swarm E2E",
      project_id: scope.projectID,
      time_used: 1,
    })
    .run()
    .pipe(Effect.orDie)
  return scope
})

const ready = Effect.fn(function* (name: string) {
  const scope = yield* bootstrap
  return yield* materializeWorkers(yield* delegateSwarm(scope, name))
})

describe("native Swarm lifecycle end to end", () => {
  it.effect("activates a delegated Swarm, then materializes both managed workers", () =>
    Effect.gen(function* () {
      const scope = yield* bootstrap
      const created = yield* delegateSwarm(scope, "materialization")

      // Durable intent exists and the Swarm is runnable before any Session does.
      const before = yield* created.reliability(10_000)
      expect(before.tasks.total).toBe(2)
      expect(before.members.boundManagedWorker).toBe(0)
      expect(before.members.unboundConfiguredManagedWorker).toBe(2)

      const materialized = yield* materializeWorkers(created)
      const after = yield* materialized.reliability(10_000)
      expect(after.members.boundManagedWorker).toBe(2)
      expect(after.members.unboundConfiguredManagedWorker).toBe(0)
      // Materialization debt must be empty once every worker owns a Session.
      expect((yield* materialized.swarms.unboundManagedMemberTargets({ swarmID: materialized.swarm.id })).length).toBe(0)
    }),
  )

  it.effect("dispatches only the DAG-ready task and lets the projector own run creation", () =>
    Effect.gen(function* () {
      const state = yield* ready("assignment")

      const dispatchable = yield* dispatchableTaskIDs(state, 1_000)
      expect(dispatchable).toEqual([state.taskA.id])
      expect(dispatchable).not.toContain(state.taskB.id)

      const dispatched = yield* dispatchAssignment(state, { taskID: state.taskA.id, workerIndex: 0, now: 1_100 })
      // The run row was created by SwarmSessionProjector from the admitted event.
      const runs = yield* state.swarms.taskRunHistory({
        swarmID: state.swarm.id,
        taskID: state.taskA.id,
        limit: 10,
      })
      expect(runs.items.map((run) => run.id)).toEqual([dispatched.runID])
      expect(runs.items[0]?.status).toBe("admitted")

      expect(yield* promoteAssignment(state, dispatched.sessionID)).toBe(true)
      const promoted = yield* state.swarms.taskRunHistory({
        swarmID: state.swarm.id,
        taskID: state.taskA.id,
        limit: 10,
      })
      expect(promoted.items[0]?.status).toBe("running")
      expect(promoted.items[0]?.startedAt).toBeDefined()

      const counters = yield* state.reliability(10_000)
      expect(counters.runs.total).toBe(1)
      expect(counters.tasks.working).toBe(1)
    }),
  )

  it.effect("closes an un-settled execution into review_pending and never replays it", () =>
    Effect.gen(function* () {
      const state = yield* ready("no-replay")
      const dispatched = yield* dispatchAssignment(state, { taskID: state.taskA.id, workerIndex: 0, now: 1_100 })
      yield* promoteAssignment(state, dispatched.sessionID)

      const closed = yield* closeWithoutSettlement(state, {
        token: dispatched.claim.token,
        runID: dispatched.runID,
        now: 1_200,
      })
      expect(closed.task.status).toBe("review_pending")
      // A forgotten bookkeeping call must never be read as task success.
      expect(closed.task.semanticRetryCount).toBe(0)
      expect(closed.run?.status).toBe("unsettled")

      // Level-triggered anti-replay: repeated scheduler polls never resurface it.
      for (const now of [1_300, 2_000, 50_000, 900_000]) {
        expect(yield* dispatchableTaskIDs(state, now)).not.toContain(state.taskA.id)
      }
      // The unsettled run is terminal, so the quiescence sweep converges to empty.
      expect((yield* state.swarms.unsettledExecutionTargets({ limit: 10 })).length).toBe(0)

      const counters = yield* state.reliability(900_001)
      expect(counters.runs.unsettled).toBe(1)
      expect(counters.runs.completed).toBe(0)
      expect(counters.runs.semanticFailure).toBe(0)
      expect(counters.runs.failed).toBe(0)
      // The dependent task stays gated: anti-replay must not advance the DAG.
      expect(yield* dispatchableTaskIDs(state, 900_002)).not.toContain(state.taskB.id)
    }),
  )

  it.effect("records human-focus preemption of a pending assignment as churn, not a verdict", () =>
    Effect.gen(function* () {
      const state = yield* ready("preemption")
      const dispatched = yield* dispatchAssignment(state, { taskID: state.taskA.id, workerIndex: 0, now: 1_100 })

      const revoked = yield* preemptPendingAssignment(state, {
        sessionID: dispatched.sessionID,
        inputID: dispatched.inputID,
      })
      expect(revoked.state).not.toBe("too-late")

      const runs = yield* state.swarms.taskRunHistory({
        swarmID: state.swarm.id,
        taskID: state.taskA.id,
        limit: 10,
      })
      expect(runs.items[0]?.status).toBe("superseded")

      const counters = yield* state.reliability(10_000)
      expect(counters.runs.superseded).toBe(1)
      expect(counters.runs.semanticFailure).toBe(0)
      expect(counters.runs.operationalFailure).toBe(0)
      expect(counters.runs.failed).toBe(0)
      // Authority was released, so the task is legitimately dispatchable again.
      expect(counters.tasks.ready).toBe(1)
      expect(yield* dispatchableTaskIDs(state, 10_001)).toContain(state.taskA.id)
    }),
  )

  it.effect("settles explicitly and keeps a completed task terminal forever", () =>
    Effect.gen(function* () {
      const state = yield* ready("explicit-settle")
      const dispatched = yield* dispatchAssignment(state, { taskID: state.taskA.id, workerIndex: 0, now: 1_100 })
      yield* promoteAssignment(state, dispatched.sessionID)

      const settled = yield* settleExplicitly(state, {
        token: dispatched.claim.token,
        runID: dispatched.runID,
        now: 1_200,
      })
      expect(settled.task.status).toBe("completed")
      expect(settled.task.semanticRetryCount).toBe(0)
      expect(settled.task.time.completed).toBeDefined()

      for (const now of [1_300, 50_000, 900_000]) {
        expect(yield* dispatchableTaskIDs(state, now)).not.toContain(state.taskA.id)
      }

      const counters = yield* state.reliability(900_001)
      expect(counters.runs.completed).toBe(1)
      expect(counters.runs.unsettled).toBe(0)
      expect(counters.runs.superseded).toBe(0)
      // An explicit success is the only thing that may open the dependent task.
      expect(yield* dispatchableTaskIDs(state, 900_002)).toContain(state.taskB.id)
    }),
  )

  it.effect("round-trips peer mail into the recipient Session under delivery fencing", () =>
    Effect.gen(function* () {
      const state = yield* ready("peer-mail")

      const mail = yield* peerRoundtrip(state, {
        from: 0,
        to: 1,
        body: "finding: the ledger replay loop is operational churn",
        now: 1_000,
        owner: "mail-owner",
      })

      // Recipient-scoped inbox read comes from durable delivery rows, not a
      // Swarm-wide message scan.
      expect(mail.inbox).toHaveLength(1)
      expect(mail.inbox[0]?.message.id).toBe(mail.delivery.messageID)
      expect(mail.inbox[0]?.message.senderMemberID).toBe(state.workers[0].id)
      expect(mail.inbox[0]?.message.body).toBe("finding: the ledger replay loop is operational churn")

      // Claim fenced the recipient binding: the token carries the live Session.
      expect(mail.claimed.token.recipientSessionID).toBe(state.sessions[1])
      expect(mail.claimed.token.recipientBindingGeneration).toBe(state.workers[1].bindingGeneration + 1)

      const history = yield* state.swarms.deliveriesForMessage(mail.delivery.messageID)
      expect(history[0]?.state).toBe("admitted")
      expect(history[0]?.admittedSessionID).toBe(state.sessions[1])
      expect(history[0]?.attemptCount).toBe(0)

      // A second claimant cannot steal an already-admitted delivery.
      const stolen = yield* state.swarms
        .claimDelivery({ deliveryID: mail.delivery.id, owner: "thief", leaseMs: 60_000, now: 1_100 })
        .pipe(Effect.flip)
      expect(stolen._tag).toBe("Swarm.ConflictError")
    }),
  )
})
