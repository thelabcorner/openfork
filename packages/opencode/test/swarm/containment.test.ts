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
import { SwarmTable, SwarmTaskLeaseTable, SwarmTaskRunTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmContainment } from "@/swarm/containment"
import { SwarmRuntimeRetention } from "@/swarm/runtime-retention"
import { SwarmTaskRetirement } from "@/swarm/task-retirement"
import { testEffect } from "../lib/effect"

const currentRuntimeID = "runtime-owner:containment-current" as RuntimeOwner.ID
const deadRuntimeID = "runtime-owner:containment-dead" as RuntimeOwner.ID

const runtimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: currentRuntimeID,
    pid: 9201,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void }),
    snapshot: (id) =>
      Effect.succeed(
        id === deadRuntimeID
          ? { id, pid: 9202, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }
          : id === currentRuntimeID
            ? { id, pid: 9201, startedAt: 1, heartbeatAt: 10_000, controlEpoch: 0 }
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
      SwarmContainment.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [RuntimeOwner.node, runtimeLayer],
    ],
  ),
)

const projectID = ProjectV2.ID.make("swarm-containment-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_containment")
const workerSessionID = SessionV2.ID.make("ses_swarm_containment_worker")
const UNCERTAIN_CALL_ID = "call-uncertain-containment"

const profile = Swarm.MemberExecutionProfile.make({
  agent: AgentModel.ID.make("build"),
  model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
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

const baseFixture = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const swarm = yield* SwarmV2.Service
  const execution = yield* SessionExecutionOwner.Service
  const retention = yield* SwarmRuntimeRetention.Service
  const retirement = yield* SwarmTaskRetirement.Service
  const containment = yield* SwarmContainment.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/containment"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm containment", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: workerSessionID,
      project_id: projectID,
      workspace_id: workspaceID,
      slug: workerSessionID,
      directory: "/swarm/containment",
      title: workerSessionID,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(RuntimeOwnerTable)
    .values([
      { id: currentRuntimeID, pid: 9201, started_at: 1, heartbeat_at: 10_000, control_epoch: 0 },
      { id: deadRuntimeID, pid: 9202, started_at: 1, heartbeat_at: 1, control_epoch: 0 },
    ])
    .run()
    .pipe(Effect.orDie)

  return { db, events, swarm, execution, retention, retirement, containment }
})

/**
 * A retiring lease whose worker Session is owned by a proven-dead process and
 * whose transcript holds one unresolved mutating tool call: the `effect-unknown`
 * state automatic recovery must never resolve on its own.
 */
const setupFenced = Effect.gen(function* () {
  const base = yield* baseFixture
  const { db, events, swarm, execution, retention, retirement } = base

  const created = yield* swarm.create({
    projectID,
    workspaceID,
    directory: "/swarm/containment",
    name: "containment swarm",
    now: 10,
  })
  const info = yield* swarm.update({ id: created.id, expectedRevision: created.revision, status: "active", now: 15 })
  const coordinatorMember = yield* swarm.addMember({
    swarmID: info.id,
    name: "coordinator",
    kind: "coordinator",
    role: "coordinator",
    workspacePolicy: { mode: "shared-read" },
    now: 16,
  })
  yield* swarm.update({
    id: info.id,
    expectedRevision: (yield* swarm.info(info.id)).revision,
    coordinatorMemberID: coordinatorMember.id,
    now: 18,
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
    .values({ session_id: workerSessionID, generation: 7, owner_id: deadRuntimeID, acquired_at: 42 })
    .run()
    .pipe(Effect.orDie)

  const assistantMessageID = SessionMessage.ID.create()
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID: workerSessionID,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(43),
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
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

  yield* swarm.requestTaskRetirement({ token: claim.token, reason: "lease_owner_lost", now: 46 })
  yield* retirement.poke()
  yield* waitFor(
    execution.snapshot(workerSessionID).pipe(
      Effect.map((snapshot) => snapshot.ownerID === deadRuntimeID && snapshot.recoveryOwnerID === currentRuntimeID),
    ),
  )
  yield* waitFor(retirement.activeDrains().pipe(Effect.map((count) => count === 0)))

  return { ...base, info, task, claim, runID, assistantMessageID, coordinatorID: coordinatorMember.id }
})

type Fenced = Effect.Success<typeof setupFenced>

const overlayFor = (state: Fenced) =>
  state.db
    .select()
    .from(SessionMessageToolOverlayTable)
    .where(eq(SessionMessageToolOverlayTable.call_id, UNCERTAIN_CALL_ID))
    .get()
    .pipe(Effect.orDie)

const decodedAssistant = (state: Fenced) =>
  state.db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, state.assistantMessageID))
    .get()
    .pipe(
      Effect.flatMap((row) => {
        if (!row) return Effect.die("missing assistant")
        return SessionMessageProjection.decodeRow(state.db, row)
      }),
      Effect.orDie,
    )

const runFor = (state: Fenced) =>
  state.db
    .select()
    .from(SwarmTaskRunTable)
    .where(eq(SwarmTaskRunTable.id, state.runID))
    .get()
    .pipe(Effect.orDie)

const leaseFor = (state: Fenced) =>
  state.db
    .select()
    .from(SwarmTaskLeaseTable)
    .where(eq(SwarmTaskLeaseTable.task_id, state.task.id))
    .get()
    .pipe(Effect.orDie)

const taskRowFor = (state: Fenced) =>
  state.db
    .select({ status: SwarmTaskTable.status, retry: SwarmTaskTable.semantic_retry_count })
    .from(SwarmTaskTable)
    .where(eq(SwarmTaskTable.id, state.task.id))
    .get()
    .pipe(Effect.orDie)

const toolSuccessEvents = (state: Fenced) =>
  state.db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, workerSessionID))
    .all()
    .pipe(Effect.orDie)
    .pipe(Effect.map((rows) => rows.filter((row) => row.type.includes(SessionEvent.Tool.Success.type)).length))

const swarmRowFor = (id: Swarm.ID) =>
  Database.Service.pipe(
    Effect.flatMap(({ db }) => db.select().from(SwarmTable).where(eq(SwarmTable.id, id)).get().pipe(Effect.orDie)),
  )

describe("Swarm operator containment", () => {
  it.effect("surfaces a retiring lease fenced by unresolved effects without resolving it", () =>
    Effect.gen(function* () {
      const state = yield* setupFenced

      const candidates = yield* state.containment.unresolved()
      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toMatchObject({
        swarmID: state.info.id,
        taskID: state.task.id,
        leaseGeneration: state.claim.token.generation,
        retireReason: "lease_owner_lost",
        sessionID: workerSessionID,
        sessionGeneration: 7,
        deadOwnerID: deadRuntimeID,
        recoveryOwnerID: currentRuntimeID,
        hazards: { currentTool: true, legacyTool: false },
      })

      // Discovery is read-only: the fence and the evidence both survive.
      expect((yield* overlayFor(state))?.settlement_event_id).toBeNull()
      expect(yield* leaseFor(state)).toMatchObject({ state: "retiring" })
      expect(yield* runFor(state)).toMatchObject({ status: "running" })
    }),
  )

  it.effect("acknowledgement seals the effect, releases the fence, and settles without claiming success", () =>
    Effect.gen(function* () {
      const state = yield* setupFenced

      const result = yield* state.containment.acknowledge({
        taskID: state.task.id,
        generation: state.claim.token.generation,
        now: 47,
      })
      expect(result).toMatchObject({ state: "contained", taskID: state.task.id, runID: state.runID, sealed: 1 })

      // Honest transcript repair: the call is sealed as an unknown error, never
      // as success and never as "did not happen".
      expect(yield* SessionRecovery.executionHazards(state.db, workerSessionID)).toEqual({
        currentTool: false,
        legacyTool: false,
      })
      expect((yield* overlayFor(state))?.settlement_event_id).toBeTruthy()
      expect(yield* toolSuccessEvents(state)).toBe(0)
      const decoded = yield* decodedAssistant(state)
      expect(decoded.type).toBe("assistant")
      if (decoded.type !== "assistant") return
      expect(decoded.content).toMatchObject([
        {
          type: "tool",
          id: UNCERTAIN_CALL_ID,
          state: { status: "error", error: { type: "unknown" } },
        },
      ])

      // The dead generation is no longer fenced, so ordinary execution resumes.
      const released = yield* state.execution.snapshot(workerSessionID)
      expect(released.ownerID).toBeUndefined()
      expect(released.recoveryOwnerID).toBeUndefined()
      expect(yield* state.execution.tryAcquire(workerSessionID)).toMatchObject({ state: "acquired" })

      // Swarm closure: the external outcome is genuinely unknown, so the run
      // becomes a terminal `unsettled` fact and the task is parked in
      // `review_pending` for a deliberate decision. It must NOT return to `ready`
      // (that would redispatch a mutation whose effect is still unknown) and no
      // semantic retry budget is spent, because nothing semantically failed.
      expect(yield* runFor(state)).toMatchObject({ status: "unsettled" })
      // Settlement releases the exact lease row rather than parking it, so the
      // aggregate is no longer blocking the task and no lease remains draining.
      expect(yield* leaseFor(state)).toBeUndefined()
      expect(yield* taskRowFor(state)).toEqual({ status: "review_pending", retry: 0 })

      // Regression: a contained unknown-outcome mutation is never automatically
      // re-dispatched. Only `review_pending` is present, never `ready`.
      const ready = yield* state.swarm.readyAssignments({ now: 47, limit: 16 })
      expect(ready.some((assignment) => assignment.task.id === state.task.id)).toBe(false)
    }),
  )

  it.effect("acknowledgement is idempotent and never settles twice", () =>
    Effect.gen(function* () {
      const state = yield* setupFenced
      const first = yield* state.containment.acknowledge({
        taskID: state.task.id,
        generation: state.claim.token.generation,
        now: 47,
      })
      expect(first.state).toBe("contained")
      const settledAt = yield* runFor(state)

      const second = yield* state.containment.acknowledge({
        taskID: state.task.id,
        generation: state.claim.token.generation,
        now: 48,
      })
      expect(second).toEqual({ state: "not-found" })
      expect(yield* runFor(state)).toEqual(settledAt)
      expect(yield* taskRowFor(state)).toEqual({ status: "review_pending", retry: 0 })

      // Nothing is left for the unattended retirement path to redo.
      expect(yield* state.containment.unresolved()).toEqual([])
    }),
  )

  it.effect("refuses to acknowledge a lease generation that is not retiring", () =>
    Effect.gen(function* () {
      const state = yield* setupFenced
      const result = yield* state.containment.acknowledge({
        taskID: state.task.id,
        generation: state.claim.token.generation + 99,
        now: 47,
      })
      expect(result).toEqual({ state: "not-found" })
      expect((yield* overlayFor(state))?.settlement_event_id).toBeNull()
    }),
  )

  it.effect("leaves the contained task non-dispatchable until a deliberate review decision", () =>
    Effect.gen(function* () {
      const state = yield* setupFenced
      yield* state.containment.acknowledge({
        taskID: state.task.id,
        generation: state.claim.token.generation,
        now: 47,
      })

      const parked = (yield* state.swarm.get(state.info.id)).tasks.find(
        (task) => task.id === state.task.id,
      )!
      expect(parked.status).toBe("review_pending")
      // The fence advanced with the closure, so a review must present the new
      // generation. Presenting the pre-containment generation fails closed.
      expect(parked.leaseGeneration).toBe(state.claim.token.generation + 1)

      const staleFence = yield* state.swarm
        .reviewTask({
          swarmID: state.info.id,
          taskID: state.task.id,
          reviewerMemberID: state.coordinatorID,
          expectedLeaseGeneration: state.claim.token.generation,
          decision: { type: "accept" },
          now: 49,
        })
        .pipe(Effect.exit)
      expect(staleFence._tag).toBe("Failure")

      // A deliberate reviewer decision, fenced to the current generation, can
      // still resolve the task. Containment is a pause for judgement, not a
      // dead end.
      const reviewed = yield* state.swarm.reviewTask({
        swarmID: state.info.id,
        taskID: state.task.id,
        reviewerMemberID: state.coordinatorID,
        expectedLeaseGeneration: parked.leaseGeneration,
        decision: { type: "accept" },
        now: 50,
      })
      expect(reviewed.status).toBe("completed")
      expect(reviewed.semanticRetryCount).toBe(0)
    }),
  )

  it.effect("an explicit reviewer retry re-dispatches a contained unknown outcome", () =>
    Effect.gen(function* () {
      const state = yield* setupFenced
      yield* state.containment.acknowledge({
        taskID: state.task.id,
        generation: state.claim.token.generation,
        now: 47,
      })
      const parked = (yield* state.swarm.get(state.info.id)).tasks.find(
        (task) => task.id === state.task.id,
      )!

      const retried = yield* state.swarm.reviewTask({
        swarmID: state.info.id,
        taskID: state.task.id,
        reviewerMemberID: state.coordinatorID,
        expectedLeaseGeneration: parked.leaseGeneration,
        decision: { type: "retry", detail: "operator confirmed containment and wants one clean retry" },
        now: 50,
      })
      expect(retried.status).toBe("ready")
      expect(retried.semanticRetryCount).toBe(0)

      // Only the deliberate retry makes it dispatchable again.
      const ready = yield* state.swarm.readyAssignments({ now: 50, limit: 16 })
      expect(ready.some((assignment) => assignment.task.id === state.task.id)).toBe(true)
    }),
  )

  it.effect("ordinary unattended retirement still supersedes back to ready", () =>
    Effect.gen(function* () {
      // Containment must not have changed ordinary lease-expiry semantics: a
      // retiring lease with no unresolved effects is still operational churn.
      const base = yield* baseFixture
      const created = yield* base.swarm.create({
        projectID,
        workspaceID,
        directory: "/swarm/containment",
        name: "ordinary retirement",
        now: 10,
      })
      const info = yield* base.swarm.update({
        id: created.id,
        expectedRevision: created.revision,
        status: "active",
        now: 11,
      })
      const member = yield* base.swarm.addMember({
        swarmID: info.id,
        name: "worker",
        kind: "managed_worker",
        role: "worker",
        desiredProfile: profile,
        workspacePolicy: { mode: "shared-read" },
        sessionID: workerSessionID,
        now: 12,
      })
      yield* base.retention.ensure()
      const task = yield* base.swarm.createTask({ swarmID: info.id, title: "ordinary", now: 13 })
      const claim = yield* base.swarm.claimTask({
        swarmID: info.id,
        taskID: task.id,
        memberID: member.id,
        processOwner: base.retention.ownerID,
        leaseMs: 60_000,
        now: 14,
      })
      yield* base.swarm.requestTaskRetirement({ token: claim.token, reason: "lease_owner_lost", now: 15 })

      const settled = yield* base.swarm.settleTask({
        token: claim.token,
        settlement: { type: "superseded", detail: "retired after lease_owner_lost" },
        now: 16,
      })
      expect(settled.task.status).toBe("ready")
      expect(settled.task.semanticRetryCount).toBe(0)
    }),
  )
})

describe("Swarm aggregate recovery", () => {
  it.effect("closes an abandoned creating aggregate and converges on repeat", () =>
    Effect.gen(function* () {
      const { db, swarm, containment } = yield* baseFixture

      const abandoned = yield* swarm.create({
        projectID,
        workspaceID,
        directory: "/swarm/containment",
        name: "abandoned creating",
        now: 1_000,
      })
      expect(abandoned.status).toBe("creating")

      const first = yield* containment.reconcile({
        now: 1_000 + 60 * 60_000 + 1,
      })
      expect(first.closedCreating).toBe(1)
      const row = yield* db
        .select()
        .from(SwarmTable)
        .where(eq(SwarmTable.id, abandoned.id))
        .get()
        .pipe(Effect.orDie)
      expect(row?.status).toBe("failed")
      // Closed, never deleted: audit history and the terminal timestamp survive.
      expect(row?.revision).toBe(1)
      expect(row?.time_completed).toBeTruthy()

      // Level-triggered and idempotent: a restart re-derives no remaining work.
      const second = yield* containment.reconcile({ now: 1_000 + 60 * 60_000 + 2 })
      expect(second.closedCreating).toBe(0)
    }),
  )

  it.effect("leaves a fresh creating aggregate and a partially created one alone", () =>
    Effect.gen(function* () {
      const { swarm, containment } = yield* baseFixture
      const reference = 1_000 + 60 * 60_000 + 1

      const fresh = yield* swarm.create({
        projectID,
        workspaceID,
        directory: "/swarm/containment",
        name: "fresh creating",
        now: reference,
      })

      const partial = yield* swarm.create({
        projectID,
        workspaceID,
        directory: "/swarm/containment",
        name: "partial creating",
        now: 1_000,
      })
      yield* swarm.addMember({
        swarmID: partial.id,
        name: "worker",
        kind: "guest",
        role: "observer",
        workspacePolicy: { mode: "shared-read" },
        now: 1_000,
      })

      const result = yield* containment.reconcile({ now: reference })
      expect(result.closedCreating).toBe(0)
      expect((yield* swarmRowFor(fresh.id))?.status).toBe("creating")
      expect((yield* swarmRowFor(partial.id))?.status).toBe("creating")
    }),
  )

  it.effect("surfaces an idle active aggregate but never closes it", () =>
    Effect.gen(function* () {
      const { swarm, containment } = yield* baseFixture
      const created = yield* swarm.create({
        projectID,
        workspaceID,
        directory: "/swarm/containment",
        name: "idle active",
        now: 1_000,
      })
      yield* swarm.update({ id: created.id, expectedRevision: created.revision, status: "active", now: 1_000 })

      const idle = yield* containment.reconcile({ now: 1_000 + 3 * 24 * 60 * 60_000 + 1 })
      expect(idle.closedCreating).toBe(0)
      expect(idle.staleActive).toBe(1)
      // An idle Swarm is a legitimate quiet state; closing it is an operator
      // decision, so the runtime only reports it.
      expect((yield* swarmRowFor(created.id))?.status).toBe("active")
    }),
  )
})
