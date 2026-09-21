import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SwarmV2.node])),
)

const projectID = ProjectV2.ID.make("swarm-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm")
const sessionA = SessionV2.ID.make("ses_swarm_a")
const sessionB = SessionV2.ID.make("ses_swarm_b")
const sessionChild = SessionV2.ID.make("ses_swarm_child")
const sessionProducer = SessionV2.ID.make("ses_swarm_producer")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      sessionRow(sessionA),
      sessionRow(sessionB),
      { ...sessionRow(sessionChild), parent_id: sessionA },
      { ...sessionRow(sessionProducer), metadata: { scheduledTaskID: "stk_test" } },
    ])
    .run()
    .pipe(Effect.orDie)
})

function sessionRow(id: SessionV2.ID) {
  return {
    id,
    project_id: projectID,
    workspace_id: workspaceID,
    slug: id,
    directory: "/swarm/project",
    title: id,
    version: "test",
  }
}

function createSwarm(name = "native swarm") {
  return SwarmV2.Service.use((service) =>
    service.create({
      projectID,
      workspaceID,
      directory: "/swarm/project",
      name,
      now: 100,
    }),
  )
}

describe("Swarm Core service", () => {
  it.effect("atomically couples aggregate mutation to durable history and rejects stale revisions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const service = yield* SwarmV2.Service
      const created = yield* createSwarm()

      expect(created.status).toBe("creating")
      expect(created.revision).toBe(0)
      expect(
        (
          yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .all()
            .pipe(Effect.orDie)
        ).length,
      ).toBe(1)

      const active = yield* service.update({
        id: created.id,
        expectedRevision: 0,
        status: "active",
        now: 200,
      })
      expect(active.status).toBe("active")
      expect(active.revision).toBe(1)

      const stale = yield* service
        .update({
          id: created.id,
          expectedRevision: 0,
          name: "stale writer",
          now: 300,
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("Swarm.StaleRevisionError")

      const detail = yield* service.get(created.id)
      expect(detail.swarm.name).toBe("native swarm")
      expect(detail.swarm.revision).toBe(1)
      expect(
        (
          yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .all()
            .pipe(Effect.orDie)
        ).length,
      ).toBe(2)
    }),
  )

  it.effect("allows one Session in multiple Swarms while fencing rebinds and invalidating authority on stop", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SwarmV2.Service
      const a = yield* createSwarm("A")
      const b = yield* createSwarm("B")

      const memberA = yield* service.addMember({
        swarmID: a.id,
        name: "coordinator",
        kind: "coordinator",
        role: "Lead",
        sessionID: sessionA,
        workspacePolicy: { mode: "shared-read" },
        now: 110,
      })
      const memberB = yield* service.addMember({
        swarmID: b.id,
        name: "coordinator",
        kind: "coordinator",
        role: "Lead",
        sessionID: sessionA,
        workspacePolicy: { mode: "shared-read" },
        now: 110,
      })
      expect(memberA.sessionID).toBe(sessionA)
      expect(memberB.sessionID).toBe(sessionA)
      expect((yield* service.membersForSession(sessionA)).map((member) => member.swarmID)).toEqual([a.id, b.id].sort())

      const rebound = yield* service.rebindMember({
        swarmID: a.id,
        memberID: memberA.id,
        expectedBindingGeneration: 1,
        sessionID: sessionB,
        now: 120,
      })
      expect(rebound.bindingGeneration).toBe(2)
      expect(rebound.sessionID).toBe(sessionB)

      const stale = yield* service
        .rebindMember({
          swarmID: a.id,
          memberID: memberA.id,
          expectedBindingGeneration: 1,
          sessionID: sessionA,
          now: 130,
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("Swarm.StaleFenceError")

      const stopped = yield* service.setMemberLifecycle({
        swarmID: a.id,
        memberID: memberA.id,
        expectedLifecycle: "active",
        lifecycle: "stopped",
        now: 140,
      })
      expect(stopped.sessionID).toBeUndefined()
      expect(stopped.bindingGeneration).toBe(3)
      expect(stopped.lifecycle).toBe("stopped")
      expect((yield* service.membersForSession(sessionA)).map((member) => member.swarmID)).toEqual([b.id])
    }),
  )

  it.effect("rejects child and producer-owned Sessions as Swarm members", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SwarmV2.Service
      const swarm = yield* createSwarm("ownership boundary")

      for (const [name, sessionID] of [
        ["child", sessionChild],
        ["producer", sessionProducer],
      ] as const) {
        const error = yield* service
          .addMember({
            swarmID: swarm.id,
            name,
            kind: "managed_worker",
            role: "worker",
            desiredProfile: managedProfile,
            sessionID,
            workspacePolicy: { mode: "shared-read" },
          })
          .pipe(Effect.flip)
        expect(error._tag).toBe("Swarm.ValidationError")
      }
      expect(yield* service.membersForSession(sessionChild)).toEqual([])
      expect(yield* service.membersForSession(sessionProducer)).toEqual([])
    }),
  )

  it.effect("requires a recreate profile for managed workers and exposes unbound workers to recovery", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SwarmV2.Service
      const swarm = yield* createSwarm("managed recovery")

      const missing = yield* service
        .addMember({
          swarmID: swarm.id,
          name: "missing-profile",
          kind: "managed_worker",
          role: "worker",
          workspacePolicy: { mode: "shared-read" },
        })
        .pipe(Effect.flip)
      expect(missing._tag).toBe("Swarm.ValidationError")

      const worker = yield* service.addMember({
        swarmID: swarm.id,
        name: "recoverable-worker",
        kind: "managed_worker",
        role: "worker",
        desiredProfile: managedProfile,
        workspacePolicy: { mode: "shared-read" },
        now: 150,
      })
      const targets = yield* service.unboundManagedMemberTargets({ swarmID: swarm.id })
      expect(targets).toHaveLength(1)
      expect(targets[0]).toMatchObject({
        swarm: { id: swarm.id, status: "creating" },
        member: { id: worker.id, sessionID: undefined, desiredProfile: managedProfile },
      })
    }),
  )

  it.effect("reconfigures managed execution intent only after an exact stopped/unbound fence", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SwarmV2.Service
      const swarm = yield* createSwarm("profile configuration")
      const worker = yield* service.addMember({
        swarmID: swarm.id,
        name: "worker",
        kind: "managed_worker",
        role: "worker",
        desiredProfile: managedProfile,
        workspacePolicy: { mode: "shared-read" },
        sessionID: sessionA,
        now: 160,
      })

      const live = yield* service
        .configureMember({
          swarmID: swarm.id,
          memberID: worker.id,
          expectedBindingGeneration: worker.bindingGeneration,
          desiredProfile: managedProfile,
          workspacePolicy: { mode: "shared-write" },
        })
        .pipe(Effect.flip)
      expect(live._tag).toBe("Swarm.ConflictError")

      const stopped = yield* service.setMemberLifecycle({
        swarmID: swarm.id,
        memberID: worker.id,
        expectedLifecycle: "active",
        lifecycle: "stopped",
        now: 170,
      })
      expect(stopped.sessionID).toBeUndefined()

      const stale = yield* service
        .configureMember({
          swarmID: swarm.id,
          memberID: worker.id,
          expectedBindingGeneration: worker.bindingGeneration,
          desiredProfile: managedProfile,
          workspacePolicy: { mode: "shared-write" },
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("Swarm.StaleFenceError")

      const configured = yield* service.configureMember({
        swarmID: swarm.id,
        memberID: worker.id,
        expectedBindingGeneration: stopped.bindingGeneration,
        desiredProfile: managedProfile,
        workspacePolicy: { mode: "shared-write" },
        capabilities: { tags: ["reasoning"] },
        now: 180,
      })
      expect(configured.lifecycle).toBe("stopped")
      expect(configured.sessionID).toBeUndefined()
      expect(configured.bindingGeneration).toBe(stopped.bindingGeneration)
      expect(configured.workspacePolicy).toEqual({ mode: "shared-write" })
      expect(configured.capabilities).toEqual({ tags: ["reasoning"] })

      const resumed = yield* service.setMemberLifecycle({
        swarmID: swarm.id,
        memberID: worker.id,
        expectedLifecycle: "stopped",
        lifecycle: "active",
        now: 190,
      })
      expect(resumed.desiredProfile).toEqual(managedProfile)
      expect(resumed.workspacePolicy).toEqual({ mode: "shared-write" })
      expect(resumed.capabilities).toEqual({ tags: ["reasoning"] })
    }),
  )

  it.effect("materializes DAG readiness, rejects cycles, and reports compact summary counts", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SwarmV2.Service
      const swarm = yield* createSwarm()
      const coordinator = yield* service.addMember({
        swarmID: swarm.id,
        name: "lead",
        kind: "coordinator",
        role: "Lead",
        sessionID: sessionA,
        workspacePolicy: { mode: "shared-read" },
      })

      const a = yield* service.createTask({
        swarmID: swarm.id,
        title: "Foundation",
        createdByMemberID: coordinator.id,
        now: 200,
      })
      const b = yield* service.createTask({
        swarmID: swarm.id,
        title: "Integration",
        dependencies: [{ taskID: a.id, requirement: "require_success" }],
        now: 210,
      })
      expect(a.status).toBe("ready")
      expect(b.status).toBe("blocked")

      const cycle = yield* service
        .setTaskDependencies({
          swarmID: swarm.id,
          taskID: a.id,
          dependencies: [{ taskID: b.id }],
          now: 220,
        })
        .pipe(Effect.flip)
      expect(cycle._tag).toBe("Swarm.ValidationError")
      expect((yield* service.dependencies(a.id))).toEqual([])
      expect((yield* service.dependencies(b.id)).map((item) => item.dependsOnTaskID)).toEqual([a.id])

      const summary = yield* service.summary(swarm.id)
      expect(summary.memberCount).toBe(1)
      expect(summary.boundMemberCount).toBe(1)
      expect(summary.readyTaskCount).toBe(1)
      expect(summary.workingTaskCount).toBe(0)
      expect(summary.pendingDeliveryCount).toBe(0)
    }),
  )

  it.effect("selects ready assignments by hard authority before affinity and never allocates one Session twice", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SwarmV2.Service
      const swarm = yield* createSwarm("dispatch")
      const alpha = yield* service.addMember({
        swarmID: swarm.id,
        name: "alpha",
        kind: "managed_worker",
        role: "alpha implementation specialist",
        desiredProfile: managedProfile,
        sessionID: sessionA,
        workspacePolicy: { mode: "shared-write" },
        now: 110,
      })
      const beta = yield* service.addMember({
        swarmID: swarm.id,
        name: "beta",
        kind: "managed_worker",
        role: "beta verification specialist",
        desiredProfile: managedProfile,
        sessionID: sessionB,
        workspacePolicy: { mode: "shared-write" },
        now: 111,
      })
      yield* service.addMember({
        swarmID: swarm.id,
        name: "guest",
        kind: "guest",
        role: "guest",
        workspacePolicy: { mode: "shared-read" },
        now: 112,
      })
      yield* service.update({ id: swarm.id, expectedRevision: 0, status: "active", now: 120 })

      const reservedBeta = yield* service.createTask({
        swarmID: swarm.id,
        title: "alpha implementation work",
        priority: 30,
        reservedMemberID: beta.id,
        reservedUntil: 500,
        now: 130,
      })
      const unreserved = yield* service.createTask({
        swarmID: swarm.id,
        title: "alpha implementation followup",
        priority: 20,
        now: 131,
      })
      yield* service.createTask({
        swarmID: swarm.id,
        title: "third task cannot double allocate a Session",
        priority: 10,
        now: 132,
      })

      const firstBatch = yield* service.readyAssignments({ now: 140, limit: 16 })
      expect(firstBatch.map((item) => [item.task.id, item.member.id])).toEqual([
        [reservedBeta.id, beta.id],
        [unreserved.id, alpha.id],
      ])
      expect(new Set(firstBatch.map((item) => item.member.sessionID)).size).toBe(firstBatch.length)

      const busy = yield* service.createTask({ swarmID: swarm.id, title: "occupy alpha", priority: 50, now: 150 })
      yield* service.claimTask({
        swarmID: swarm.id,
        taskID: busy.id,
        memberID: alpha.id,
        processOwner: "selector-test",
        leaseMs: 1_000,
        now: 151,
      })
      const expiring = yield* service.createTask({
        swarmID: swarm.id,
        title: "beta verification after reservation expiry",
        priority: 60,
        reservedMemberID: alpha.id,
        reservedUntil: 200,
        now: 152,
      })

      const beforeExpiry = yield* service.readyAssignments({ now: 190, limit: 16 })
      expect(beforeExpiry.some((item) => item.task.id === expiring.id)).toBe(false)
      const afterExpiry = yield* service.readyAssignments({ now: 201, limit: 16 })
      expect(afterExpiry.find((item) => item.task.id === expiring.id)?.member.id).toBe(beta.id)
      expect(afterExpiry.every((item) => item.member.kind === "managed_worker")).toBe(true)
    }),
  )
})
