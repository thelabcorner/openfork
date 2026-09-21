import { beforeEach, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
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
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"
import { SwarmTaskLeaseTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmDeadlineOwner } from "@/swarm/deadline-owner"
import { SwarmDispatcher } from "@/swarm/dispatcher"
import { SwarmRuntimeRetention } from "@/swarm/runtime-retention"
import { SwarmTaskRetirement } from "@/swarm/task-retirement"
import { testEffect } from "../lib/effect"

const T0 = 1_000_000
const projectID = ProjectV2.ID.make("swarm-deadline-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_deadline")
const coordinatorSessionID = SessionV2.ID.make("ses_swarm_deadline_coordinator")
const workerSessionID = SessionV2.ID.make("ses_swarm_deadline_worker")

const managedProfile = Swarm.MemberExecutionProfile.make({
  agent: AgentModel.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("test-model"),
  },
  permissionBoundary: [],
})

let dispatcherPokes = 0
let retirementPokes = 0

const fakeDispatcherLayer = Layer.succeed(
  SwarmDispatcher.Service,
  SwarmDispatcher.Service.of({
    start: () => Effect.void,
    poke: () => Effect.sync(() => void dispatcherPokes++),
    activeDrains: () => Effect.succeed(0),
  }),
)

const fakeRetirementLayer = Layer.succeed(
  SwarmTaskRetirement.Service,
  SwarmTaskRetirement.Service.of({
    start: () => Effect.void,
    poke: () => Effect.sync(() => void retirementPokes++),
    activeDrains: () => Effect.succeed(0),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      RuntimeOwner.node,
      SwarmV2.node,
      SwarmRuntimeRetention.node,
      SwarmDeadlineOwner.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [SwarmDispatcher.node, fakeDispatcherLayer],
      [SwarmTaskRetirement.node, fakeRetirementLayer],
    ],
  ),
)

beforeEach(() => {
  dispatcherPokes = 0
  retirementPokes = 0
})

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/deadline",
    title: id,
    version: "test",
  }
}

const waitFor = (predicate: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let index = 0; index < 4_000; index++) {
      if (yield* predicate) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("waitFor timed out"))
  })

const settleOwner = (owner: SwarmDeadlineOwner.Interface) =>
  waitFor(owner.activeDrains().pipe(Effect.map((count) => count === 0)))

const setup = Effect.gen(function* () {
  yield* TestClock.setTime(T0)
  const { db } = yield* Database.Service
  const swarm = yield* SwarmV2.Service
  const retention = yield* SwarmRuntimeRetention.Service
  const deadline = yield* SwarmDeadlineOwner.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/deadline"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm deadline", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([sessionRow(coordinatorSessionID), sessionRow(workerSessionID)])
    .run()
    .pipe(Effect.orDie)

  const created = yield* swarm.create({
    projectID,
    workspaceID,
    directory: "/swarm/deadline",
    name: "deadline swarm",
    now: T0,
  })
  const info = yield* swarm.update({
    id: created.id,
    expectedRevision: created.revision,
    status: "active",
    now: T0,
  })
  const coordinator = yield* swarm.addMember({
    swarmID: info.id,
    name: "coordinator",
    kind: "coordinator",
    role: "lead",
    sessionID: coordinatorSessionID,
    workspacePolicy: { mode: "shared-read" },
    now: T0,
  })
  const worker = yield* swarm.addMember({
    swarmID: info.id,
    name: "worker",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: managedProfile,
    sessionID: workerSessionID,
    workspacePolicy: { mode: "shared-read" },
    now: T0,
  })
  yield* retention.ensure()
  yield* settleOwner(deadline)
  return { db, swarm, retention, deadline, info, coordinator, worker }
})

const leaseRow = (state: Effect.Success<typeof setup>, taskID: Swarm.TaskID) =>
  state.db
    .select()
    .from(SwarmTaskLeaseTable)
    .where(eq(SwarmTaskLeaseTable.task_id, taskID))
    .get()
    .pipe(Effect.orDie)

describe("Swarm deadline owner", () => {
  it.effect("has no idle timer when no durable Swarm deadline exists", () =>
    Effect.gen(function* () {
      const state = yield* setup
      expect(yield* state.deadline.activeTimerCount()).toBe(0)
      expect(dispatcherPokes).toBe(0)
      expect(retirementPokes).toBe(0)
    }),
  )

  it.effect("renews exact process-owned leases, including retiring safety fences, without changing generation", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const task = yield* state.swarm.createTask({ swarmID: state.info.id, title: "renew me", now: T0 })
      const claim = yield* state.swarm.claimTask({
        swarmID: state.info.id,
        taskID: task.id,
        memberID: state.worker.id,
        processOwner: state.retention.ownerID,
        leaseMs: SwarmRuntimePolicy.TASK_LEASE_RENEW_AHEAD_MS / 2,
        now: T0,
      })

      yield* waitFor(
        Effect.gen(function* () {
          const row = yield* leaseRow(state, task.id)
          return row?.renewed_at === T0 && row.expires_at === T0 + SwarmRuntimePolicy.TASK_LEASE_MS
        }),
      )
      let row = yield* leaseRow(state, task.id)
      expect(row).toMatchObject({
        generation: claim.token.generation,
        lease_owner_process: state.retention.ownerID,
        expires_at: T0 + SwarmRuntimePolicy.TASK_LEASE_MS,
      })
      yield* settleOwner(state.deadline)
      expect(yield* state.deadline.activeTimerCount()).toBe(1)

      yield* state.swarm.requestTaskRetirement({ token: claim.token, reason: "operator_release", now: T0 + 1 })
      yield* state.db
        .update(SwarmTaskLeaseTable)
        .set({ expires_at: T0 + 1_000, renewed_at: null })
        .where(eq(SwarmTaskLeaseTable.task_id, task.id))
        .run()
        .pipe(Effect.orDie)
      yield* state.deadline.poke()
      yield* waitFor(
        Effect.gen(function* () {
          const current = yield* leaseRow(state, task.id)
          return current?.state === "retiring" && current.renewed_at === T0
        }),
      )
      row = yield* leaseRow(state, task.id)
      expect(row).toMatchObject({
        state: "retiring",
        generation: claim.token.generation,
        expires_at: T0 + SwarmRuntimePolicy.TASK_LEASE_MS,
      })
    }),
  )

  it.effect("lease expiry and human-hold deadlines begin retirement but never reassign authority", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const expiredTask = yield* state.swarm.createTask({ swarmID: state.info.id, title: "foreign expiry", now: T0 })
      const foreign = yield* state.swarm.claimTask({
        swarmID: state.info.id,
        taskID: expiredTask.id,
        memberID: state.worker.id,
        processOwner: "foreign-runtime",
        leaseMs: 5_000,
        now: T0,
      })
      expect(yield* state.deadline.activeTimerCount()).toBe(1)
      yield* TestClock.adjust("5 seconds")
      yield* waitFor(
        Effect.gen(function* () {
          const row = yield* leaseRow(state, expiredTask.id)
          return row?.state === "retiring"
        }),
      )
      expect(yield* leaseRow(state, expiredTask.id)).toMatchObject({
        generation: foreign.token.generation,
        owner_member_id: state.worker.id,
        state: "retiring",
        retire_reason: "lease_expired",
      })
      expect(retirementPokes).toBeGreaterThan(0)
      expect(yield* state.deadline.activeTimerCount()).toBe(1)

      // Settle the first fence only to free the member for the hold case.
      yield* state.swarm.settleTask({
        token: foreign.token,
        settlement: { type: "superseded" },
        now: T0 + 5_000,
      })
      const heldTask = yield* state.swarm.createTask({ swarmID: state.info.id, title: "held deadline", now: T0 + 5_000 })
      const held = yield* state.swarm.claimTask({
        swarmID: state.info.id,
        taskID: heldTask.id,
        memberID: state.worker.id,
        processOwner: state.retention.ownerID,
        leaseMs: SwarmRuntimePolicy.TASK_LEASE_MS,
        now: T0 + 5_000,
      })
      yield* state.swarm.holdTask({
        token: held.token,
        userSeq: 1,
        deadline: T0 + 10_000,
        now: T0 + 5_000,
      })
      yield* TestClock.adjust("5 seconds")
      yield* waitFor(
        Effect.gen(function* () {
          const row = yield* leaseRow(state, heldTask.id)
          return row?.state === "retiring"
        }),
      )
      expect(yield* leaseRow(state, heldTask.id)).toMatchObject({
        generation: held.token.generation,
        owner_member_id: state.worker.id,
        state: "retiring",
        retire_reason: "human_focus",
      })
      expect(yield* state.deadline.activeTimerCount()).toBe(1)
    }),
  )

  it.effect("message TTL expiry is durable, attempt-neutral, and wakes the dispatcher", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const sent = yield* state.swarm.enqueueMessage({
        swarmID: state.info.id,
        senderMemberID: state.coordinator.id,
        target: { type: "member", memberID: state.worker.id },
        kind: "message",
        body: "expire me",
        expiresAt: T0 + 5_000,
        now: T0,
      })
      expect(yield* state.deadline.activeTimerCount()).toBe(1)
      yield* TestClock.adjust("5 seconds")
      yield* waitFor(
        Effect.gen(function* () {
          const [delivery] = yield* state.swarm.deliveriesForMessage(sent.message.id)
          return delivery?.state === "expired"
        }),
      )
      const [delivery] = yield* state.swarm.deliveriesForMessage(sent.message.id)
      expect(delivery).toMatchObject({ state: "expired", attemptCount: 0 })
      expect(dispatcherPokes).toBeGreaterThan(0)
    }),
  )

  it.effect("retry, claim-reclaim, and reservation deadlines wake the level-triggered dispatcher", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const first = yield* state.swarm.enqueueMessage({
        swarmID: state.info.id,
        senderMemberID: state.coordinator.id,
        target: { type: "member", memberID: state.worker.id },
        kind: "message",
        body: "retry",
        now: T0,
      })
      const firstClaim = yield* state.swarm.claimDelivery({
        deliveryID: first.deliveries[0]!.id,
        owner: "mail-owner-a",
        leaseMs: 30_000,
        now: T0,
      })
      yield* state.swarm.releaseDelivery({
        token: firstClaim.token,
        outcome: { type: "retry", nextAttemptAt: T0 + 5_000, countAsAttempt: false },
        now: T0,
      })
      yield* state.deadline.poke()
      yield* settleOwner(state.deadline)
      const beforeRetry = dispatcherPokes
      yield* TestClock.adjust("5 seconds")
      yield* waitFor(Effect.sync(() => dispatcherPokes > beforeRetry))
      expect(yield* state.swarm.claimableDeliveryIDs({ now: T0 + 5_000, limit: 16 })).toContain(first.deliveries[0]!.id)

      const second = yield* state.swarm.enqueueMessage({
        swarmID: state.info.id,
        senderMemberID: state.coordinator.id,
        target: { type: "member", memberID: state.worker.id },
        kind: "message",
        body: "reclaim",
        now: T0 + 5_000,
      })
      yield* state.swarm.claimDelivery({
        deliveryID: second.deliveries[0]!.id,
        owner: "mail-owner-b",
        leaseMs: 5_000,
        now: T0 + 5_000,
      })
      yield* state.deadline.poke()
      yield* settleOwner(state.deadline)
      const beforeReclaim = dispatcherPokes
      yield* TestClock.adjust("5 seconds")
      yield* waitFor(Effect.sync(() => dispatcherPokes > beforeReclaim))
      expect(yield* state.swarm.claimableDeliveryIDs({ now: T0 + 10_000, limit: 16 })).toContain(second.deliveries[0]!.id)

      const reserved = yield* state.swarm.createTask({
        swarmID: state.info.id,
        title: "reservation",
        reservedMemberID: state.worker.id,
        reservedUntil: T0 + 15_000,
        now: T0 + 10_000,
      })
      yield* state.deadline.poke()
      yield* settleOwner(state.deadline)
      const beforeReservation = dispatcherPokes
      yield* TestClock.adjust("5 seconds")
      yield* waitFor(Effect.sync(() => dispatcherPokes > beforeReservation))
      expect((yield* state.swarm.get(state.info.id)).tasks.find((task) => task.id === reserved.id)?.status).toBe("ready")
    }),
  )

  it.effect("retiring cross-process probes are monotonic and cannot be postponed by unrelated event churn", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const task = yield* state.swarm.createTask({ swarmID: state.info.id, title: "probe retirement", now: T0 })
      const claim = yield* state.swarm.claimTask({
        swarmID: state.info.id,
        taskID: task.id,
        memberID: state.worker.id,
        processOwner: "foreign-runtime",
        leaseMs: 60_000,
        now: T0,
      })
      yield* state.swarm.requestTaskRetirement({
        token: claim.token,
        reason: "operator_release",
        now: T0,
      })
      yield* settleOwner(state.deadline)
      expect(yield* state.deadline.activeTimerCount()).toBe(1)
      const baseline = retirementPokes

      yield* TestClock.adjust("4 seconds")
      // This mutation re-arms the deadline owner but must preserve the original
      // T0+5s retirement probe rather than sliding it to T0+9s.
      yield* state.swarm.createTask({
        swarmID: state.info.id,
        title: "unrelated future reservation",
        reservedMemberID: state.worker.id,
        reservedUntil: T0 + 100_000,
        now: T0 + 4_000,
      })
      yield* settleOwner(state.deadline)
      expect(retirementPokes).toBe(baseline)

      yield* TestClock.adjust("1 second")
      yield* waitFor(Effect.sync(() => retirementPokes > baseline))
      expect(yield* state.deadline.activeTimerCount()).toBe(1)
    }),
  )
})
