import { beforeEach, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
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
import { SessionInput } from "@opencode-ai/core/session/input"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import {
  SwarmMessageDeliveryTable,
  SwarmMessageTable,
  SwarmTaskLeaseTable,
  SwarmTaskRunTable,
} from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { SwarmMailExecutor } from "@/swarm/mail-executor"
import { SwarmRuntimeRetention } from "@/swarm/runtime-retention"
import { SwarmTaskExecutor } from "@/swarm/task-executor"
import { testEffect } from "../lib/effect"

const projectID = ProjectV2.ID.make("swarm-executor-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_executor")
const coordinatorSessionID = SessionV2.ID.make("ses_swarm_executor_coordinator")
const workerSessionID = SessionV2.ID.make("ses_swarm_executor_worker")
const reboundSessionID = SessionV2.ID.make("ses_swarm_executor_rebound")

const managedProfile = Swarm.MemberExecutionProfile.make({
  agent: AgentModel.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("test-model"),
  },
  permissionBoundary: [],
})

type AdmissionHook = (input: SessionInput.SyntheticAdmission) => Effect.Effect<void, unknown, any>

let beforeSynthetic: AdmissionHook | undefined
let promptWakeRequests = 0

const promptLayer = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    admitSynthetic: ((input: SessionInput.SyntheticAdmission) =>
      Effect.gen(function* () {
        if (beforeSynthetic) yield* beforeSynthetic(input)
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        const admitted = yield* SessionInput.admitSynthetic(db, events, input)
        // Production SessionPrompt.admitSynthetic forks the Session loop after
        // this durable commit. Reaching this seam therefore proves one wake
        // request without booting provider/tool runtime in an orchestration test.
        promptWakeRequests++
        return admitted
      })) as never,
  } as never),
)

const instanceLayer = Layer.succeed(
  InstanceStore.Service,
  InstanceStore.Service.of({
    provide: ((_input: unknown, effect: Effect.Effect<unknown>) => effect) as never,
  } as never),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SwarmV2.node,
      RuntimeOwner.node,
      SwarmRuntimeRetention.node,
      SwarmTaskExecutor.node,
      SwarmMailExecutor.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [SessionPrompt.node, promptLayer],
      [InstanceStore.node, instanceLayer],
    ],
  ),
)

beforeEach(() => {
  beforeSynthetic = undefined
  promptWakeRequests = 0
})

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/executor",
    title: id,
    version: "test",
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const swarm = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/executor"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm executor", project_id: projectID, time_used: 1 })
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
    directory: "/swarm/executor",
    name: "executor swarm",
    now: 10,
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
  return { db, swarm, info, coordinator, worker }
})

const sendToWorker = (state: Effect.Success<typeof setup>, expiresAt?: number) =>
  state.swarm.enqueueMessage({
    swarmID: state.info.id,
    senderMemberID: state.coordinator.id,
    target: { type: "member", memberID: state.worker.id },
    kind: "message",
    body: "peer delivery",
    ...(expiresAt === undefined ? {} : { expiresAt }),
  })

const injectHumanInput: AdmissionHook = (input) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    yield* SessionInput.admit(db, events, {
      id: SessionMessage.ID.create(),
      sessionID: input.sessionID,
      prompt: Prompt.make({ text: "human focus" }),
      delivery: "queue",
      provenance: { owner: "user", source: SessionTurnProvenance.Source.Prompt },
    })
  })

describe("Swarm thin executors", () => {
  it.live("retains one process-global RuntimeOwner across task and mail ownership", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const retention = yield* SwarmRuntimeRetention.Service
      const task = yield* state.swarm.createTask({ swarmID: state.info.id, title: "retained task" })
      const sent = yield* sendToWorker(state)
      const delivery = sent.deliveries[0]!

      yield* retention.ensure()
      yield* retention.ensure()
      const taskClaim = yield* state.swarm.claimTask({
        swarmID: state.info.id,
        taskID: task.id,
        memberID: state.worker.id,
        processOwner: retention.ownerID,
        leaseMs: 60_000,
      })
      const mailClaim = yield* state.swarm.claimDelivery({
        deliveryID: delivery.id,
        owner: retention.ownerID,
        leaseMs: 60_000,
      })

      expect(taskClaim.token.processOwner).toBe(retention.ownerID)
      expect(mailClaim.token.owner).toBe(retention.ownerID)
      expect(yield* state.swarm.processOwnedWork(retention.ownerID)).toEqual({
        taskLeases: 1,
        deliveryClaims: 1,
      })
      expect(yield* state.db.select().from(RuntimeOwnerTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* retention.reconcile()).toEqual({ taskLeases: 1, deliveryClaims: 1 })

      yield* state.swarm.releaseDelivery({
        token: mailClaim.token,
        outcome: { type: "retry", nextAttemptAt: Date.now() + 5_000, countAsAttempt: false },
      })
      yield* state.swarm.requestTaskRetirement({ token: taskClaim.token, reason: "operator_release" })
      yield* state.swarm.settleTask({ token: taskClaim.token, settlement: { type: "superseded" } })
      expect(yield* retention.reconcile()).toEqual({ taskLeases: 0, deliveryClaims: 0 })
    }),
  )

  it.live("assignment admission commits the TaskRun and crosses the SessionPrompt wake boundary", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const executor = yield* SwarmTaskExecutor.Service
      const task = yield* state.swarm.createTask({ swarmID: state.info.id, title: "admit assignment" })

      const result = yield* executor.execute({ task, member: state.worker })
      expect(result.state).toBe("admitted")
      if (result.state !== "admitted") return
      expect(promptWakeRequests).toBe(1)

      const run = yield* state.db
        .select()
        .from(SwarmTaskRunTable)
        .where(eq(SwarmTaskRunTable.id, result.runID))
        .get()
        .pipe(Effect.orDie)
      expect(run).toMatchObject({
        id: result.runID,
        task_id: task.id,
        member_id: state.worker.id,
        session_id: workerSessionID,
        session_input_id: result.sessionInputID,
        status: "admitted",
      })
      expect(yield* SessionInput.findEntry(state.db, result.sessionInputID)).toMatchObject({
        kind: "synthetic",
        admissionClass: "host",
      })
    }),
  )

  it.live("failed assignment admission retires and supersedes operationally without semantic retry", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const executor = yield* SwarmTaskExecutor.Service
      const task = yield* state.swarm.createTask({ swarmID: state.info.id, title: "fenced assignment" })
      beforeSynthetic = injectHumanInput

      const result = yield* executor.execute({ task, member: state.worker })
      expect(result.state).toBe("released")
      expect(promptWakeRequests).toBe(0)

      const current = (yield* state.swarm.get(state.info.id)).tasks.find((item) => item.id === task.id)
      expect(current).toMatchObject({ status: "ready", semanticRetryCount: 0 })
      expect(
        yield* state.db
          .select()
          .from(SwarmTaskLeaseTable)
          .where(eq(SwarmTaskLeaseTable.task_id, task.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(
        yield* state.db
          .select()
          .from(SwarmTaskRunTable)
          .where(eq(SwarmTaskRunTable.task_id, task.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
    }),
  )

  it.live("mail admission commits SessionInput and durable receipt atomically", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const executor = yield* SwarmMailExecutor.Service
      const sent = yield* sendToWorker(state)
      const delivery = sent.deliveries[0]!

      expect(yield* executor.execute(delivery.id)).toMatchObject({ state: "admitted", deliveryID: delivery.id })
      expect(promptWakeRequests).toBe(1)

      const receipt = (yield* state.swarm.deliveriesForMessage(sent.message.id))[0]!
      expect(receipt).toMatchObject({
        id: delivery.id,
        state: "admitted",
        attemptCount: 0,
        admittedSessionID: workerSessionID,
      })
      const input = yield* SessionInput.findEntry(state.db, delivery.sessionInputID)
      expect(input).toMatchObject({ kind: "synthetic", admissionClass: "host" })
      expect(receipt.admittedSeq).toBe(input?.admittedSeq)
    }),
  )

  it.live("human-focus deferral returns mail to pending without consuming attempt budget", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const executor = yield* SwarmMailExecutor.Service
      const sent = yield* sendToWorker(state)
      const delivery = sent.deliveries[0]!
      beforeSynthetic = injectHumanInput

      expect(yield* executor.execute(delivery.id)).toMatchObject({ state: "deferred", deliveryID: delivery.id })
      const receipt = (yield* state.swarm.deliveriesForMessage(sent.message.id))[0]!
      expect(receipt.state).toBe("pending")
      expect(receipt.attemptCount).toBe(0)
      expect(receipt.nextAttemptAt).toBeDefined()
      expect(yield* SessionInput.findEntry(state.db, delivery.sessionInputID)).toBeUndefined()
      expect(promptWakeRequests).toBe(0)
    }),
  )

  it.live("recipient rebind deferral returns mail to pending without consuming attempt budget", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const executor = yield* SwarmMailExecutor.Service
      const sent = yield* sendToWorker(state)
      const delivery = sent.deliveries[0]!
      beforeSynthetic = () =>
        state.swarm
          .rebindMember({
            swarmID: state.info.id,
            memberID: state.worker.id,
            expectedBindingGeneration: state.worker.bindingGeneration,
            sessionID: reboundSessionID,
          })
          .pipe(Effect.asVoid)

      expect(yield* executor.execute(delivery.id)).toMatchObject({ state: "deferred", deliveryID: delivery.id })
      const receipt = (yield* state.swarm.deliveriesForMessage(sent.message.id))[0]!
      expect(receipt.state).toBe("pending")
      expect(receipt.attemptCount).toBe(0)
      expect(yield* SessionInput.findEntry(state.db, delivery.sessionInputID)).toBeUndefined()
      expect(promptWakeRequests).toBe(0)
    }),
  )

  it.live("TTL crossing at Session commit produces durable expired delivery without an attempt", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const executor = yield* SwarmMailExecutor.Service
      const sent = yield* sendToWorker(state, Date.now() + 60_000)
      const delivery = sent.deliveries[0]!
      beforeSynthetic = () =>
        state.db
          .update(SwarmMessageTable)
          .set({ expires_at: 1 })
          .where(eq(SwarmMessageTable.id, sent.message.id))
          .run()
          .pipe(Effect.orDie, Effect.asVoid)

      expect(yield* executor.execute(delivery.id)).toMatchObject({ state: "expired", deliveryID: delivery.id })
      const receipt = (yield* state.swarm.deliveriesForMessage(sent.message.id))[0]!
      expect(receipt.state).toBe("expired")
      expect(receipt.attemptCount).toBe(0)
      expect(yield* SessionInput.findEntry(state.db, delivery.sessionInputID)).toBeUndefined()
      expect(promptWakeRequests).toBe(0)
    }),
  )
})
