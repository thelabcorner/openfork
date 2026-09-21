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
import { SessionMessageTable, SessionMessageToolOverlayTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { SwarmTaskLeaseTable, SwarmTaskRunTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmRuntimeRetention } from "@/swarm/runtime-retention"
import { SwarmTaskRetirement } from "@/swarm/task-retirement"
import { testEffect } from "../lib/effect"

const currentRuntimeID = "runtime-owner:retirement-recovery-current" as RuntimeOwner.ID
const deadRuntimeID = "runtime-owner:retirement-recovery-dead" as RuntimeOwner.ID

const runtimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: currentRuntimeID,
    pid: 9101,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void }),
    snapshot: (id) =>
      Effect.succeed(
        id === deadRuntimeID
          ? { id, pid: 9102, startedAt: 1, heartbeatAt: 1, controlEpoch: 0 }
          : id === currentRuntimeID
            ? { id, pid: 9101, startedAt: 1, heartbeatAt: 10_000, controlEpoch: 0 }
            : undefined,
      ),
    proveLocalDeath: (id) =>
      Effect.succeed(id === deadRuntimeID ? "dead" : "alive-or-unknown"),
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
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [RuntimeOwner.node, runtimeLayer],
    ],
  ),
)

const projectID = ProjectV2.ID.make("swarm-retirement-recovery-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_retirement_recovery")
const workerSessionID = SessionV2.ID.make("ses_swarm_retirement_recovery_worker")

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

describe("Swarm dead-owner retirement recovery", () => {
  it.effect("seals one uncertain tool outcome and remains fenced without replay or reassignment", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const swarm = yield* SwarmV2.Service
      const execution = yield* SessionExecutionOwner.Service
      const retention = yield* SwarmRuntimeRetention.Service
      const retirement = yield* SwarmTaskRetirement.Service

      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/swarm/retirement-recovery"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkspaceTable)
        .values({
          id: workspaceID,
          type: "local",
          name: "Swarm retirement recovery",
          project_id: projectID,
          time_used: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: workerSessionID,
          project_id: projectID,
          workspace_id: workspaceID,
          slug: workerSessionID,
          directory: "/swarm/retirement-recovery",
          title: workerSessionID,
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(RuntimeOwnerTable)
        .values([
          {
            id: currentRuntimeID,
            pid: 9101,
            started_at: 1,
            heartbeat_at: 10_000,
            control_epoch: 0,
          },
          {
            id: deadRuntimeID,
            pid: 9102,
            started_at: 1,
            heartbeat_at: 1,
            control_epoch: 0,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const created = yield* swarm.create({
        projectID,
        workspaceID,
        directory: "/swarm/retirement-recovery",
        name: "recovery swarm",
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
        .values({
          session_id: workerSessionID,
          generation: 7,
          owner_id: deadRuntimeID,
          acquired_at: 42,
        })
        .run()
        .pipe(Effect.orDie)

      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: workerSessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(43),
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("test"),
          id: ModelV2.ID.make("test-model"),
        },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID: workerSessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(44),
        callID: "call-uncertain",
        name: "bash",
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: workerSessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(45),
        callID: "call-uncertain",
        tool: "bash",
        input: { command: "touch outcome-unknown" },
        provider: { executed: false },
      })

      yield* swarm.requestTaskRetirement({
        token: claim.token,
        reason: "lease_owner_lost",
        now: 46,
      })
      yield* retirement.poke()

      yield* waitFor(
        execution.snapshot(workerSessionID).pipe(
          Effect.map(
            (snapshot) =>
              snapshot.ownerID === deadRuntimeID &&
              snapshot.recoveryOwnerID === currentRuntimeID,
          ),
        ),
      )
      yield* waitFor(
        db
          .select()
          .from(SessionMessageToolOverlayTable)
          .where(eq(SessionMessageToolOverlayTable.call_id, "call-uncertain"))
          .get()
          .pipe(Effect.orDie, Effect.map((row) => row?.settlement_event_id != null)),
      )
      yield* waitFor(retirement.activeDrains().pipe(Effect.map((count) => count === 0)))

      expect(yield* execution.snapshot(workerSessionID)).toMatchObject({
        ownerID: deadRuntimeID,
        generation: 7,
        recoveryOwnerID: currentRuntimeID,
      })
      expect(yield* execution.tryAcquire(workerSessionID)).toMatchObject({
        state: "busy",
        snapshot: {
          ownerID: deadRuntimeID,
          generation: 7,
          recoveryOwnerID: currentRuntimeID,
        },
      })
      expect(
        yield* db
          .select()
          .from(SwarmTaskLeaseTable)
          .where(eq(SwarmTaskLeaseTable.task_id, task.id))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        state: "retiring",
        generation: claim.token.generation,
        retire_reason: "lease_owner_lost",
      })
      expect(
        yield* db
          .select()
          .from(SwarmTaskRunTable)
          .where(eq(SwarmTaskRunTable.id, runID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ status: "running" })
      expect(
        yield* db
          .select({ status: SwarmTaskTable.status, retry: SwarmTaskTable.semantic_retry_count })
          .from(SwarmTaskTable)
          .where(eq(SwarmTaskTable.id, task.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ status: "working", retry: 0 })

      const messageRow = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      if (!messageRow) return yield* Effect.die("missing assistant")
      expect(yield* SessionMessageProjection.decodeRow(db, messageRow).pipe(Effect.orDie)).toMatchObject({
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-uncertain",
            state: {
              status: "error",
              error: { type: "unknown", message: "Tool execution interrupted" },
            },
          },
        ],
      })

      const before = yield* db
        .select()
        .from(SessionMessageToolOverlayTable)
        .where(eq(SessionMessageToolOverlayTable.call_id, "call-uncertain"))
        .get()
        .pipe(Effect.orDie)
      const calledBefore = (
        yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, workerSessionID))
          .all()
          .pipe(Effect.orDie)
      ).filter((event) => event.type.includes(SessionEvent.Tool.Called.type)).length

      yield* retirement.poke()
      yield* waitFor(retirement.activeDrains().pipe(Effect.map((count) => count === 0)))

      const after = yield* db
        .select()
        .from(SessionMessageToolOverlayTable)
        .where(eq(SessionMessageToolOverlayTable.call_id, "call-uncertain"))
        .get()
        .pipe(Effect.orDie)
      const calledAfter = (
        yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, workerSessionID))
          .all()
          .pipe(Effect.orDie)
      ).filter((event) => event.type.includes(SessionEvent.Tool.Called.type)).length
      expect(after?.settlement_event_id).toBe(before?.settlement_event_id)
      expect(calledBefore).toBe(1)
      expect(calledAfter).toBe(1)
    }),
  )
})
