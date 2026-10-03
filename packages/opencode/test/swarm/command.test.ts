import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSchema } from "@opencode-ai/core/swarm/schema"
import { SwarmMemberTable, SwarmTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Provider } from "@opencode-ai/schema/provider"
import type { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmCommand } from "../../src/swarm/command"
import type { SwarmProfilePreflight } from "../../src/swarm/profile-preflight"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SwarmSessionProjector.node, SwarmV2.node]),
  ),
)

const projectID = ProjectV2.ID.make("swarm-command-project")
const otherProjectID = ProjectV2.ID.make("swarm-command-other-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_command")
const otherWorkspaceID = WorkspaceV2.ID.make("wrk_swarm_command_other")
const coordinatorSessionID = SessionID.make("ses_swarm_command_coordinator")
const producerCoordinatorSessionID = SessionID.make("ses_swarm_command_producer")
const childCoordinatorSessionID = SessionID.make("ses_swarm_command_child")
const wrongProjectCoordinatorSessionID = SessionID.make("ses_swarm_command_wrong_project")
const wrongWorkspaceCoordinatorSessionID = SessionID.make("ses_swarm_command_wrong_workspace")

const profile = {
  agent: Agent.ID.make("build"),
  model: {
    providerID: Provider.ID.make("test"),
    id: Model.ID.make("test-model"),
  },
  permissionBoundary: [],
} satisfies Swarm.MemberExecutionProfile

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const swarm = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values([
      { id: projectID, worktree: AbsolutePath.make("/swarm/command"), sandboxes: [] },
      { id: otherProjectID, worktree: AbsolutePath.make("/swarm/command-other"), sandboxes: [] },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values([
      { id: workspaceID, type: "local", name: "Swarm command", project_id: projectID, time_used: 1 },
      { id: otherWorkspaceID, type: "local", name: "Other workspace", project_id: projectID, time_used: 1 },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: coordinatorSessionID,
        project_id: projectID,
        workspace_id: workspaceID,
        slug: coordinatorSessionID,
        directory: "/swarm/command",
        title: "Coordinator",
        version: "test",
      },
      {
        id: producerCoordinatorSessionID,
        project_id: projectID,
        workspace_id: workspaceID,
        slug: producerCoordinatorSessionID,
        directory: "/swarm/command",
        title: "Producer coordinator",
        version: "test",
        metadata: { scheduledTaskID: "stk_swarm_command" },
      },
      {
        id: childCoordinatorSessionID,
        project_id: projectID,
        workspace_id: workspaceID,
        parent_id: coordinatorSessionID,
        slug: childCoordinatorSessionID,
        directory: "/swarm/command",
        title: "Child coordinator",
        version: "test",
      },
      {
        id: wrongProjectCoordinatorSessionID,
        project_id: otherProjectID,
        slug: wrongProjectCoordinatorSessionID,
        directory: "/swarm/command-other",
        title: "Wrong-project coordinator",
        version: "test",
      },
      {
        id: wrongWorkspaceCoordinatorSessionID,
        project_id: projectID,
        workspace_id: otherWorkspaceID,
        slug: wrongWorkspaceCoordinatorSessionID,
        directory: "/swarm/command-other-workspace",
        title: "Wrong-workspace coordinator",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
  return swarm
})

const preflightDeny = (reason: string): SwarmProfilePreflight.Interface => ({
  check: () => Effect.fail(new SwarmSchema.ValidationError({ reason })),
})

const preflightAllowingAgent =
  (allowed: string): SwarmProfilePreflight.Interface => ({
    check: (input) =>
      input.profile.agent === allowed
        ? Effect.succeed({ model: {} as never })
        : Effect.fail(new SwarmSchema.ValidationError({ reason: `Agent not found: ${input.profile.agent}` })),
  })

describe("SwarmCommand.delegate", () => {
  it.effect("preflights invalid task graphs before writing any Swarm state", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const result = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID,
        workspaceID,
        directory: "/swarm/command",
        coordinatorSessionID,
        name: "invalid",
        members: [{ name: "worker", role: "builder", desiredProfile: profile, workspacePolicy: { mode: "shared-read" } }],
        tasks: [
          { key: "a", title: "A", dependsOn: [{ key: "b" }] },
          { key: "b", title: "B", dependsOn: [{ key: "a" }] },
        ],
      }).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      expect(yield* swarm.list({ projectID })).toEqual([])
    }),
  )

  it.effect("rejects ineligible coordinator Sessions before the first durable Swarm write", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const { db } = yield* Database.Service

      for (const coordinatorSessionID of [
        producerCoordinatorSessionID,
        childCoordinatorSessionID,
        wrongProjectCoordinatorSessionID,
        wrongWorkspaceCoordinatorSessionID,
      ]) {
        const result = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
          projectID,
          workspaceID,
          directory: "/swarm/command",
          coordinatorSessionID,
          name: `invalid coordinator ${coordinatorSessionID}`,
          members: [
            {
              name: "worker",
              role: "builder",
              desiredProfile: profile,
              workspacePolicy: { mode: "shared-read" },
            },
          ],
          tasks: [{ key: "foundation", title: "Build foundation" }],
        }).pipe(Effect.exit)

        expect(result._tag).toBe("Failure")
        expect(yield* db.select().from(SwarmTable).run().pipe(Effect.orDie)).toEqual([])
        expect(yield* db.select().from(SwarmMemberTable).run().pipe(Effect.orDie)).toEqual([])
        expect(yield* db.select().from(SwarmTaskTable).run().pipe(Effect.orDie)).toEqual([])
      }
    }),
  )

  it.effect("writes zero durable Swarm, member, or task rows when a member profile is not runnable", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const { db } = yield* Database.Service
      const result = yield* SwarmCommand.delegate(swarm, preflightDeny("Agent not found: research"), {
        projectID,
        workspaceID,
        directory: "/swarm/command",
        coordinatorSessionID,
        name: "invalid profile",
        members: [
          { name: "lead", role: "plan", desiredProfile: profile, workspacePolicy: { mode: "shared-read" } },
          {
            name: "worker",
            role: "research",
            desiredProfile: { ...profile, agent: Agent.ID.make("research") },
            workspacePolicy: { mode: "shared-read" },
          },
        ],
        tasks: [{ key: "foundation", title: "Build foundation", reservedMemberName: "worker" }],
      }).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      expect(yield* db.select().from(SwarmTable).run().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(SwarmMemberTable).run().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(SwarmTaskTable).run().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("creates coordinator, managed members, DAG tasks, then activates exactly once", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const result = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID,
        workspaceID,
        directory: "/swarm/command",
        coordinatorSessionID,
        name: "native swarm",
        coordinatorName: "lead",
        coordinatorRole: "coordinate",
        members: [
          {
            name: "worker",
            role: "implement",
            desiredProfile: profile,
            workspacePolicy: { mode: "shared-read" },
            capabilities: { tags: ["typescript"] },
          },
        ],
        tasks: [
          {
            key: "foundation",
            title: "Build foundation",
            reservedMemberName: "worker",
            acceptance: { criteria: ["tests pass"] },
          },
          {
            key: "verify",
            title: "Verify result",
            dependsOn: [{ key: "foundation", requirement: "require_success" }],
          },
        ],
      })

      expect(result.swarm).toMatchObject({
        name: "native swarm",
        status: "active",
        revision: 1,
        coordinatorMemberID: result.coordinator.id,
      })
      expect(result.coordinator).toMatchObject({
        name: "lead",
        kind: "coordinator",
        sessionID: coordinatorSessionID,
      })
      expect(result.members).toHaveLength(1)
      expect(result.members[0]).toMatchObject({
        name: "worker",
        kind: "managed_worker",
        lifecycle: "active",
        capabilities: { tags: ["typescript"] },
      })
      expect(result.members[0]?.sessionID).toBeUndefined()

      const detail = yield* swarm.get(result.swarm.id)
      expect(detail.members).toHaveLength(2)
      expect(detail.tasks).toHaveLength(2)
      const foundation = detail.tasks.find((task) => task.title === "Build foundation")!
      const verify = detail.tasks.find((task) => task.title === "Verify result")!
      expect(foundation.status).toBe("ready")
      expect(foundation.reservedMemberID).toBe(result.members[0]!.id)
      expect(verify.status).toBe("blocked")
      expect(yield* swarm.dependencies(verify.id)).toEqual([
        { taskID: verify.id, dependsOnTaskID: foundation.id, requirement: "require_success" },
      ])
    }),
  )
})
