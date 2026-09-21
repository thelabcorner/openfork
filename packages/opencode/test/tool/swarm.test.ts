import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import type { Swarm } from "@opencode-ai/schema/swarm"
import { ToolRegistry } from "@/tool/registry"
import { SwarmMemberSessionWake } from "@/swarm/member-session-wake"
import { SessionID, MessageID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([ToolRegistry.node, Database.node, SwarmV2.node, SwarmMemberSessionWake.node]),
  ),
)

const profile = {
  agent: Agent.ID.make("build"),
  model: {
    providerID: Provider.ID.make("test"),
    id: Model.ID.make("test-model"),
  },
  permissionBoundary: [],
} satisfies Swarm.MemberExecutionProfile

function context(sessionID: SessionID, asks: string[]): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_swarm_tool"),
    callID: "call_swarm_tool",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        asks.push(request.permission)
      }),
  }
}

const toolAndServices = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const swarms = yield* SwarmV2.Service
  const { db } = yield* Database.Service
  const instance = yield* requireInstance
  const tool = (yield* registry.all()).find((item) => item.id === "swarm")
  if (!tool) return yield* Effect.die("swarm tool not registered")
  return { tool, swarms, db, instance }
})

function sessionRow(id: SessionID, projectID: ProjectV2.ID, directory: string): typeof SessionTable.$inferInsert {
  return {
    id,
    project_id: projectID,
    slug: id,
    directory,
    title: id,
    version: "test",
  }
}

describe("tool.swarm", () => {
  it.instance("is lazy and enforces the swarm.read leaf on project-scoped inspection", () =>
    Effect.gen(function* () {
      const { tool } = yield* toolAndServices
      const asks: string[] = []
      expect(tool.exposure).toBe("lazy")
      const result = yield* tool.execute({ action: "list" }, context(SessionID.make("ses_swarm_list"), asks))
      expect(asks).toEqual(["swarm.read"])
      expect(result.metadata).toMatchObject({ action: "list", permission: "swarm.read", count: 0 })
    }),
  )

  it.instance("delegates fail-closed and derives coordinator authority from the caller Session", () =>
    Effect.gen(function* () {
      const { tool, swarms, db, instance } = yield* toolAndServices
      const coordinatorSession = SessionID.make("ses_swarm_tool_coordinator")
      const peerSession = SessionID.make("ses_swarm_tool_peer")
      yield* Effect.forEach(
        [coordinatorSession, peerSession],
        (id) =>
          db
            .insert(SessionTable)
            .values(sessionRow(id, instance.project.id, instance.directory))
            .run()
            .pipe(Effect.orDie),
        { discard: true },
      )

      const asks: string[] = []
      const delegated = yield* tool.execute(
        { action: "delegate", swarmName: "tool-native swarm", coordinatorName: "lead" },
        context(coordinatorSession, asks),
      )
      expect(asks).toEqual(["swarm.member"])
      expect(delegated.metadata.status).toBe("active")
      const id = SwarmV2.ID.make(delegated.metadata.swarmId!)
      const detail = yield* swarms.get(id)
      expect(detail.swarm).toMatchObject({ name: "tool-native swarm", status: "active", revision: 1 })
      expect(detail.members).toHaveLength(1)
      expect(detail.members[0]).toMatchObject({
        id: detail.swarm.coordinatorMemberID,
        name: "lead",
        kind: "coordinator",
        sessionID: coordinatorSession,
      })

      yield* swarms.addMember({
        swarmID: id,
        name: "peer",
        kind: "external",
        role: "observer",
        sessionID: peerSession,
        workspacePolicy: { mode: "shared-read" },
      })
      const denied = yield* tool
        .execute({ action: "state", swarmId: id, status: "paused" }, context(peerSession, []))
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("recorded coordinator")
      expect((yield* swarms.get(id)).swarm.status).toBe("active")
    }),
  )

  it.instance("settles only exact Session-owned running work and routes bounded recovery through the wake seam", () =>
    Effect.gen(function* () {
      const { tool, swarms, db, instance } = yield* toolAndServices
      const coordinatorSession = SessionID.make("ses_swarm_tool_owner")
      const workerSession = SessionID.make("ses_swarm_tool_worker")
      yield* Effect.forEach(
        [coordinatorSession, workerSession],
        (id) =>
          db
            .insert(SessionTable)
            .values(sessionRow(id, instance.project.id, instance.directory))
            .run()
            .pipe(Effect.orDie),
        { discard: true },
      )

      const created = yield* swarms.create({
        projectID: instance.project.id,
        directory: instance.directory,
        name: "authority swarm",
      })
      const coordinator = yield* swarms.addMember({
        swarmID: created.id,
        name: "lead",
        kind: "coordinator",
        role: "coordinate",
        sessionID: coordinatorSession,
        workspacePolicy: { mode: "shared-read" },
      })
      const worker = yield* swarms.addMember({
        swarmID: created.id,
        name: "worker",
        kind: "managed_worker",
        role: "implement",
        sessionID: workerSession,
        desiredProfile: profile,
        workspacePolicy: { mode: "shared-read" },
      })
      yield* swarms.addMember({
        swarmID: created.id,
        name: "unbound",
        kind: "managed_worker",
        role: "recover",
        desiredProfile: profile,
        workspacePolicy: { mode: "shared-read" },
      })
      const active = yield* swarms.update({
        id: created.id,
        expectedRevision: created.revision,
        coordinatorMemberID: coordinator.id,
        status: "active",
      })
      expect(active.status).toBe("active")

      const task = yield* swarms.createTask({
        swarmID: created.id,
        title: "authority task",
        createdByMemberID: coordinator.id,
        reservedMemberID: worker.id,
      })
      const claimed = yield* swarms.claimTask({
        swarmID: created.id,
        taskID: task.id,
        memberID: worker.id,
        processOwner: "tool-test-owner",
        leaseMs: 60_000,
      })
      const run = yield* swarms.recordTaskRun({
        token: claimed.token,
        sessionInputID: SessionMessage.ID.make("msg_swarm_tool_assignment"),
      })
      yield* swarms.startTaskRun({ token: claimed.token, runID: run.id })

      const injectedAuthority = yield* tool
        .execute(
          { action: "task.settle", swarmId: created.id, taskId: task.id, settlement: "completed" },
          context(workerSession, []),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(injectedAuthority)).toBe(true)
      expect((yield* swarms.get(created.id)).tasks.find((item) => item.id === task.id)?.status).toBe("working")

      const asks: string[] = []
      const settled = yield* tool.execute(
        { action: "task.settle", swarmId: created.id, settlement: "completed" },
        context(workerSession, asks),
      )
      expect(asks).toEqual(["swarm.task"])
      expect(settled.metadata).toMatchObject({ taskId: task.id, memberId: worker.id, status: "completed" })
      expect((yield* swarms.get(created.id)).tasks.find((item) => item.id === task.id)?.status).toBe("completed")

      const wake = yield* SwarmMemberSessionWake.Service
      let requested: Swarm.ID | undefined
      const uninstall = yield* wake.install((swarmID) =>
        Effect.sync(() => {
          requested = swarmID
        }),
      )
      const recoveryAsks: string[] = []
      const recovery = yield* tool.execute(
        { action: "recover.members", swarmId: created.id },
        context(coordinatorSession, recoveryAsks),
      )
      yield* uninstall
      expect(recoveryAsks).toEqual(["swarm.member"])
      expect(requested).toBe(created.id)
      expect(recovery.metadata).toMatchObject({ count: 1, status: "requested" })
    }),
  )
})
