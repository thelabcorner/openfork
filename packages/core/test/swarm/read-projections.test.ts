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
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SwarmV2.node])),
)

const projectA = ProjectV2.ID.make("swarm-read-project-a")
const projectB = ProjectV2.ID.make("swarm-read-project-b")
const workspaceA = WorkspaceV2.ID.make("wrk_swarm_read_a")
const workspaceB = WorkspaceV2.ID.make("wrk_swarm_read_b")
const coordinatorSession = SessionV2.ID.make("ses_swarm_read_coordinator")
const workerSession = SessionV2.ID.make("ses_swarm_read_worker")
const foreignSession = SessionV2.ID.make("ses_swarm_read_foreign")

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
      { id: projectA, worktree: AbsolutePath.make("/swarm/read/a"), sandboxes: [] },
      { id: projectB, worktree: AbsolutePath.make("/swarm/read/b"), sandboxes: [] },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values([
      { id: workspaceA, type: "local", name: "Swarm read A", project_id: projectA, time_used: 1 },
      { id: workspaceB, type: "local", name: "Swarm read B", project_id: projectB, time_used: 1 },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      sessionRow({
        id: coordinatorSession,
        projectID: projectA,
        workspaceID: workspaceA,
        directory: "/swarm/read/a",
      }),
      sessionRow({
        id: workerSession,
        projectID: projectA,
        workspaceID: workspaceA,
        directory: "/swarm/read/a",
      }),
      sessionRow({
        id: foreignSession,
        projectID: projectB,
        workspaceID: workspaceB,
        directory: "/swarm/read/b",
      }),
    ])
    .run()
    .pipe(Effect.orDie)
})

const createRunnable = Effect.fn("test.createRunnableSwarm")(function* (name: string, now = 100) {
  const swarms = yield* SwarmV2.Service
  const swarm = yield* swarms.create({
    projectID: projectA,
    workspaceID: workspaceA,
    directory: "/swarm/read/a",
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

describe("Swarm bounded public read projections", () => {
  it.effect("scopes summary catalogs by project/workspace/status and bounds the requested window", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const first = yield* createRunnable("first", 100)
      const paused = yield* swarms.create({
        projectID: projectA,
        workspaceID: workspaceA,
        directory: "/swarm/read/a",
        name: "paused",
        now: 200,
      })
      yield* swarms.update({ id: paused.id, expectedRevision: paused.revision, status: "paused", now: 201 })
      const foreign = yield* swarms.create({
        projectID: projectB,
        workspaceID: workspaceB,
        directory: "/swarm/read/b",
        name: "foreign",
        now: 300,
      })
      yield* swarms.addMember({
        swarmID: foreign.id,
        name: "foreign coordinator",
        kind: "coordinator",
        role: "Lead",
        sessionID: foreignSession,
        workspacePolicy: { mode: "shared-read" },
        now: 301,
      })

      expect((yield* swarms.summaries({ projectID: projectA })).map((item) => item.swarm.id)).toEqual([
        first.swarm.id,
        paused.id,
      ])
      expect((yield* swarms.summaries({ workspaceID: workspaceB })).map((item) => item.swarm.id)).toEqual([
        foreign.id,
      ])
      expect((yield* swarms.summaries({ projectID: projectA, status: "active" })).map((item) => item.swarm.id)).toEqual([
        first.swarm.id,
      ])
      expect((yield* swarms.summaries({ projectID: projectA, limit: 1 })).map((item) => item.swarm.id)).toEqual([
        first.swarm.id,
      ])

      const summary = (yield* swarms.summaries({ projectID: projectA, status: "active" }))[0]!
      expect(summary).toMatchObject({
        memberCount: 2,
        boundMemberCount: 2,
        readyTaskCount: 0,
        workingTaskCount: 0,
        pendingDeliveryCount: 0,
      })
    }),
  )

  it.effect("pages messages, runs, blackboard, claims, and deliverables without cross-Swarm leakage", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const { swarm, coordinator, worker } = yield* createRunnable("history", 400)

      const messages = []
      for (let index = 0; index < 3; index++) {
        messages.push(
          yield* swarms.enqueueMessage({
            swarmID: swarm.id,
            senderMemberID: coordinator.id,
            target: { type: "member", memberID: worker.id },
            kind: "message",
            body: "message " + index,
            now: 1_000 + index,
          }),
        )
      }
      const messagePage1 = yield* swarms.messageHistory({ swarmID: swarm.id, limit: 2 })
      expect(messagePage1.items.map((item) => item.message.id)).toEqual([
        messages[2]!.message.id,
        messages[1]!.message.id,
      ])
      expect(messagePage1.items.every((item) => item.deliveries.length === 1)).toBe(true)
      expect(messagePage1.items.every((item) => item.deliveries[0]?.recipientMemberID === worker.id)).toBe(true)
      expect(messagePage1.more).toBe(true)
      expect(messagePage1.next).toEqual({
        createdAt: 1_001,
        id: messages[1]!.message.id,
      })
      const messagePage2 = yield* swarms.messageHistory({
        swarmID: swarm.id,
        limit: 2,
        before: messagePage1.next,
      })
      expect(messagePage2.items.map((item) => item.message.id)).toEqual([messages[0]!.message.id])
      expect(messagePage2.more).toBe(false)
      expect(messagePage2.next).toBeUndefined()

      const runs = []
      const tasks = []
      for (let index = 0; index < 2; index++) {
        const task = yield* swarms.createTask({
          swarmID: swarm.id,
          title: "task " + index,
          now: 2_000 + index * 10,
        })
        tasks.push(task)
        const claimed = yield* swarms.claimTask({
          swarmID: swarm.id,
          taskID: task.id,
          memberID: worker.id,
          processOwner: "read-projection-test",
          leaseMs: 10_000,
          now: 2_001 + index * 10,
        })
        const run = yield* swarms.recordTaskRun({
          token: claimed.token,
          sessionInputID: SessionMessage.ID.make("msg_swarm_read_run_" + index),
          admittedAt: 2_002 + index * 10,
          now: 2_002 + index * 10,
        })
        runs.push(run)
        yield* swarms.startTaskRun({ token: claimed.token, runID: run.id, now: 2_003 + index * 10 })
        yield* swarms.settleTask({
          token: claimed.token,
          runID: run.id,
          settlement: { type: "completed" },
          now: 2_004 + index * 10,
        })
      }
      const runPage1 = yield* swarms.taskRunHistory({ swarmID: swarm.id, limit: 1 })
      expect(runPage1.items.map((item) => item.id)).toEqual([runs[1]!.id])
      expect(runPage1.more).toBe(true)
      const runPage2 = yield* swarms.taskRunHistory({ swarmID: swarm.id, limit: 1, before: runPage1.next })
      expect(runPage2.items.map((item) => item.id)).toEqual([runs[0]!.id])
      expect(runPage2.more).toBe(false)
      expect((yield* swarms.taskRunHistory({ swarmID: swarm.id, taskID: tasks[0]!.id })).items.map((item) => item.id)).toEqual([
        runs[0]!.id,
      ])

      for (const [index, key] of ["alpha", "beta", "gamma"].entries()) {
        yield* swarms.putBlackboard({
          swarmID: swarm.id,
          key,
          value: { index },
          contentType: "application/json",
          authorMemberID: coordinator.id,
          now: 3_000 + index,
        })
      }
      const blackboard1 = yield* swarms.blackboardPage({ swarmID: swarm.id, limit: 2 })
      expect(blackboard1.items.map((item) => item.key)).toEqual(["alpha", "beta"])
      expect(blackboard1).toMatchObject({ more: true, nextKey: "beta" })
      const blackboard2 = yield* swarms.blackboardPage({
        swarmID: swarm.id,
        limit: 2,
        afterKey: blackboard1.nextKey,
      })
      expect(blackboard2.items.map((item) => item.key)).toEqual(["gamma"])
      expect(blackboard2.more).toBe(false)

      for (const [index, scope] of ["scope:a", "scope:b", "scope:c"].entries()) {
        yield* swarms.acquireClaim({
          swarmID: swarm.id,
          memberID: worker.id,
          scope,
          now: 4_000 + index,
        })
      }
      const claim1 = yield* swarms.claimPage({ swarmID: swarm.id, limit: 2 })
      expect(claim1.items.map((item) => item.scope)).toEqual(["scope:a", "scope:b"])
      expect(claim1.more).toBe(true)
      const claim2 = yield* swarms.claimPage({ swarmID: swarm.id, limit: 2, after: claim1.next })
      expect(claim2.items.map((item) => item.scope)).toEqual(["scope:c"])
      expect(claim2.more).toBe(false)

      const deliverables = []
      for (let index = 0; index < 3; index++) {
        deliverables.push(
          yield* swarms.publishDeliverable({
            swarmID: swarm.id,
            memberID: worker.id,
            summary: "deliverable " + index,
            refs: ["ref:" + index],
            now: 5_000 + index,
          }),
        )
      }
      const deliverable1 = yield* swarms.deliverableHistory({ swarmID: swarm.id, limit: 2 })
      expect(deliverable1.items.map((item) => item.id)).toEqual([deliverables[2]!.id, deliverables[1]!.id])
      expect(deliverable1.more).toBe(true)
      const deliverable2 = yield* swarms.deliverableHistory({
        swarmID: swarm.id,
        limit: 2,
        before: deliverable1.next,
      })
      expect(deliverable2.items.map((item) => item.id)).toEqual([deliverables[0]!.id])
      expect(deliverable2.more).toBe(false)

      const foreign = yield* swarms.create({
        projectID: projectB,
        workspaceID: workspaceB,
        directory: "/swarm/read/b",
        name: "foreign history",
        now: 6_000,
      })
      expect((yield* swarms.messageHistory({ swarmID: foreign.id })).items).toEqual([])
      expect((yield* swarms.taskRunHistory({ swarmID: foreign.id })).items).toEqual([])
      expect((yield* swarms.blackboardPage({ swarmID: foreign.id })).items).toEqual([])
      expect((yield* swarms.claimPage({ swarmID: foreign.id })).items).toEqual([])
      expect((yield* swarms.deliverableHistory({ swarmID: foreign.id })).items).toEqual([])
    }),
  )
})
