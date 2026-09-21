import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
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
import { SwarmTaskLeaseTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmRecovery } from "@/swarm/recovery"
import { testEffect } from "../lib/effect"

const currentID = "runtime-owner:recovery-current" as RuntimeOwner.ID
const foreignID = "runtime-owner:recovery-foreign" as RuntimeOwner.ID
const heartbeatAt = 100
let proof: RuntimeOwner.LocalDeathProof = "alive-or-unknown"

const runtimeLayer = Layer.succeed(
  RuntimeOwner.Service,
  RuntimeOwner.Service.of({
    id: currentID,
    pid: 1001,
    startedAt: 1,
    retain: Effect.succeed({ release: Effect.void }),
    snapshot: (id) =>
      Effect.succeed(
        id === foreignID
          ? { id, pid: 1002, startedAt: 1, heartbeatAt, controlEpoch: 0 }
          : id === currentID
            ? { id, pid: 1001, startedAt: 1, heartbeatAt: 10_000, controlEpoch: 0 }
            : undefined,
      ),
    proveLocalDeath: (id) =>
      Effect.succeed(id === foreignID ? proof : "alive-or-unknown"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SwarmV2.node, RuntimeOwner.node, SwarmRecovery.node]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [RuntimeOwner.node, runtimeLayer],
    ],
  ),
)

const projectID = ProjectV2.ID.make("swarm-recovery-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_recovery")
const sessionA = SessionV2.ID.make("ses_swarm_recovery_a")
const sessionB = SessionV2.ID.make("ses_swarm_recovery_b")

const profile = Swarm.MemberExecutionProfile.make({
  agent: AgentModel.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("test-model"),
  },
  permissionBoundary: [],
})

const setup = Effect.gen(function* () {
  proof = "alive-or-unknown"
  const { db } = yield* Database.Service
  const swarm = yield* SwarmV2.Service
  const recovery = yield* SwarmRecovery.Service

  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/recovery"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm recovery", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionA,
        project_id: projectID,
        workspace_id: workspaceID,
        slug: sessionA,
        directory: "/swarm/recovery",
        title: sessionA,
        version: "test",
      },
      {
        id: sessionB,
        project_id: projectID,
        workspace_id: workspaceID,
        slug: sessionB,
        directory: "/swarm/recovery",
        title: sessionB,
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)

  const created = yield* swarm.create({
    projectID,
    workspaceID,
    directory: "/swarm/recovery",
    name: "recovery swarm",
    now: 10,
  })
  const info = yield* swarm.update({
    id: created.id,
    expectedRevision: created.revision,
    status: "active",
    now: 15,
  })
  const workerA = yield* swarm.addMember({
    swarmID: info.id,
    name: "a",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: profile,
    sessionID: sessionA,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })
  const workerB = yield* swarm.addMember({
    swarmID: info.id,
    name: "b",
    kind: "managed_worker",
    role: "worker",
    desiredProfile: profile,
    sessionID: sessionB,
    workspacePolicy: { mode: "shared-read" },
    now: 20,
  })

  const foreignTask = yield* swarm.createTask({ swarmID: info.id, title: "foreign", now: 30 })
  const foreignLease = yield* swarm.claimTask({
    swarmID: info.id,
    taskID: foreignTask.id,
    memberID: workerA.id,
    processOwner: foreignID,
    leaseMs: 1_000_000,
    now: 40,
  })
  const currentTask = yield* swarm.createTask({ swarmID: info.id, title: "current", now: 50 })
  const currentLease = yield* swarm.claimTask({
    swarmID: info.id,
    taskID: currentTask.id,
    memberID: workerB.id,
    processOwner: currentID,
    leaseMs: 1_000_000,
    now: 60,
  })
  return { db, swarm, recovery, foreignTask, foreignLease, currentTask, currentLease }
})

const lease = (db: Effect.Success<typeof setup>["db"], taskID: Swarm.TaskID) =>
  db
    .select()
    .from(SwarmTaskLeaseTable)
    .where(eq(SwarmTaskLeaseTable.task_id, taskID))
    .get()
    .pipe(Effect.orDie)

describe("SwarmRecovery", () => {
  it.effect("uses heartbeat only as suspicion and proven death as retirement authority", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const suspectAt = heartbeatAt + SwarmRecovery.OWNER_SUSPECT_MS

      expect(yield* state.recovery.reconcile({ now: suspectAt - 1 })).toMatchObject({
        scannedOwners: 1,
        retiredLeases: 0,
        nextProbeAt: suspectAt,
      })
      expect(yield* lease(state.db, state.foreignTask.id)).toMatchObject({ state: "active" })

      proof = "alive-or-unknown"
      expect(yield* state.recovery.reconcile({ now: suspectAt })).toMatchObject({
        scannedOwners: 1,
        retiredLeases: 0,
        nextProbeAt: suspectAt + SwarmRecovery.OWNER_RECHECK_MS,
      })
      expect(yield* lease(state.db, state.foreignTask.id)).toMatchObject({ state: "active" })

      proof = "dead"
      expect(yield* state.recovery.reconcile({ now: suspectAt + 1 })).toMatchObject({
        scannedOwners: 1,
        retiredLeases: 1,
      })
      expect(yield* lease(state.db, state.foreignTask.id)).toMatchObject({
        generation: state.foreignLease.token.generation,
        state: "retiring",
        retire_reason: "lease_owner_lost",
      })
      expect(yield* lease(state.db, state.currentTask.id)).toMatchObject({
        generation: state.currentLease.token.generation,
        state: "active",
        lease_owner_process: currentID,
      })
      expect(
        yield* state.db
          .select({ retry: SwarmTaskTable.semantic_retry_count })
          .from(SwarmTaskTable)
          .where(eq(SwarmTaskTable.id, state.foreignTask.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ retry: 0 })
    }),
  )
})
