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
import { SwarmCreationKey } from "../../src/swarm/creation-key"
import { SwarmTaskBatch } from "../../src/swarm/task-batch"
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
  it.effect("rechecks external authorization before every initial mutation and leaves revoked bootstrap non-runnable", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      let grants = 0
      const revoked = yield* SwarmCommand.delegatePartial(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, name: "Revoked during bootstrap",
        requestKey: "bootstrap-revoked-1",
        members: [
          { name: "accepted", role: "builder", desiredProfile: profile, workspacePolicy: { mode: "shared-read" } },
          { name: "never-added", role: "builder", desiredProfile: profile, workspacePolicy: { mode: "shared-read" } },
        ],
        tasks: [{ key: "never-task", title: "Never runnable" }],
        beforeWrite: () => Effect.suspend(() => {
          grants++
          return grants < 4
            ? Effect.void
            : Effect.fail(new SwarmSchema.ConflictError({
                code: "swarm.delegate_authority_changed",
                reason: "connector grant revoked",
              }))
        }),
      }).pipe(Effect.flip)
      expect((revoked as Error).message).toContain("connector grant revoked")
      expect(grants).toBe(4)
      const found = yield* SwarmCreationKey.lookup(swarm, {
        projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, requestKey: "bootstrap-revoked-1",
      })
      expect(found).toMatchObject({
        found: true, status: "creating", setup: "incomplete",
        managedMembers: 1, taskCounts: { total: 0 },
      })
    }),
  )

  it.effect("does not cascade a transient failed profile preflight to independent identical-profile workers", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      let calls = 0
      const flaky: SwarmProfilePreflight.Interface = {
        check: () => Effect.suspend(() => {
          calls++
          return calls === 1
            ? Effect.fail(new SwarmSchema.ValidationError({ reason: "Transient provider-catalog error" }))
            : Effect.succeed({ model: {} as never })
        }),
      }
      const members = ["first", "second", "third"].map((name) => ({
        name,
        role: "implement",
        desiredProfile: { ...profile, model: { ...profile.model } },
        workspacePolicy: { mode: "shared-read" as const },
      }))
      const admitted = yield* SwarmCommand.delegatePartial(swarm, flaky, {
        projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, name: "Transient negative must not cascade",
        members,
      })
      expect(calls).toBe(3)
      expect(admitted.members.map((member) => member.name)).toEqual(["second", "third"])
      expect(admitted.admission.failures.map((failure) => failure.index)).toEqual([0])
      expect(admitted.admission.complete).toBe(false)
    }),
  )

  it.effect("does not cache failed identical-profile checks across staged workers", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const created = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, name: "Transient staged preflight",
      })
      let calls = 0
      const flaky: SwarmProfilePreflight.Interface = {
        check: () => Effect.suspend(() => {
          calls++
          return calls === 1
            ? Effect.fail(new SwarmSchema.ValidationError({ reason: "Transient catalog error" }))
            : Effect.succeed({ model: {} as never })
        }),
      }
      const admitted = yield* SwarmCommand.addMembersPartial(swarm, flaky, {
        swarmID: created.swarm.id,
        members: ["first", "second"].map((name) => ({
          name, role: "research",
          desiredProfile: { ...profile, model: { ...profile.model } },
          workspacePolicy: { mode: "shared-read" as const },
        })),
      })
      expect(calls).toBe(2)
      expect(admitted.receipts.map((receipt) => receipt.status)).toEqual(["failed", "created"])
      expect((yield* swarm.get(created.swarm.id)).members.map((member) => member.name))
        .toEqual(["coordinator", "second"])
    }),
  )

  it.effect("reuses exact profile preflight across eight staged members without losing individual receipts", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, name: "Stage profile reuse",
      })
      let preflightCalls = 0
      const check: SwarmProfilePreflight.Interface = {
        check: () => Effect.sync(() => {
          preflightCalls++
          return { model: {} as never }
        }),
      }
      const result = yield* SwarmCommand.addMembersPartial(swarm, check, {
        swarmID: initial.swarm.id,
        members: Array.from({ length: 8 }, (_, index) => ({
          name: "stage-" + index, role: "implementer",
          desiredProfile: { ...profile, model: { ...profile.model } },
          workspacePolicy: { mode: "shared-read" as const },
        })),
      })
      expect(preflightCalls).toBe(1)
      expect(result).toMatchObject({ created: 8, satisfied: 0, failed: 0 })
      expect(new Set(result.receipts.map((receipt) => receipt.memberId)).size).toBe(8)
      expect((yield* swarm.get(initial.swarm.id)).members).toHaveLength(9)
    }),
  )

  it.effect("bounds independent profile preflights at four concurrent checks without repeating them at activation", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      let started = 0
      let running = 0
      let peak = 0
      const check: SwarmProfilePreflight.Interface = {
        check: () => Effect.gen(function* () {
          started++
          running++
          peak = Math.max(peak, running)
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
          running--
          return { model: {} as never }
        }),
      }
      const members = Array.from({ length: 8 }, (_, index) => ({
        name: "worker-" + index,
        role: "reviewer",
        desiredProfile: { ...profile, model: { ...profile.model, id: Model.ID.make("model-" + index) } },
        workspacePolicy: { mode: "shared-read" as const },
      }))
      const created = yield* SwarmCommand.delegatePartial(swarm, check, {
        projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, name: "Parallel profile preflight",
        members,
      })
      expect(peak).toBe(4)
      expect(started).toBe(8) // not 16: no redundant second catalog traversal
      expect(created.admission.complete).toBe(true)
      expect(created.members).toHaveLength(8)
      expect(running).toBe(0)
    }),
  )

  it.effect("deduplicates semantically identical per-worker model preflights without merging their roster records", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      let modelChecks = 0
      const checked: SwarmProfilePreflight.Interface = {
        check: () => Effect.sync(() => {
          modelChecks++
          return { model: {} as never }
        }),
      }
      const members = Array.from({ length: 8 }, (_, index) => ({
        name: "same-model-" + index,
        role: "builder",
        desiredProfile: {
          ...profile,
          model: { ...profile.model },
          permissionBoundary: [...profile.permissionBoundary],
        },
        workspacePolicy: { mode: "shared-read" as const },
      }))
      const created = yield* SwarmCommand.delegatePartial(swarm, checked, {
        projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, name: "One catalog resolution, eight unique workers",
        members,
      })
      expect(modelChecks).toBe(1) // previously sixteen serial checks
      expect(created.members).toHaveLength(8)
      expect(created.admission.complete).toBe(true)
      expect(new Set(created.members.map((m) => m.id)).size).toBe(8)
    }),
  )

  it.effect("reconciles a lost keyed-creation reply without writing, leaking another principal, or claiming execution", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const scope = { projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, requestKey: "lookup-case-1" }
      const missing = yield* SwarmCreationKey.lookup(swarm, scope)
      expect(missing).toMatchObject({ found: false, swarmId: SwarmCreationKey.id(scope) })
      const created = yield* SwarmCommand.delegatePartial(swarm, preflightAllowingAgent(profile.agent), {
        ...scope, name: "Reconcile", tasks: [{ key: "base", title: "Base" }],
      })
      const found = yield* SwarmCreationKey.lookup(swarm, scope)
      expect(found).toMatchObject({
        found: true, swarmId: created.swarm.id, status: "active", setup: "durable",
        managedMembers: 0, taskCounts: { total: 1, ready: 1, blocked: 0 },
      })
      if (found.found) expect(found.execution).toContain("NOT verified")
      const foreign = yield* SwarmCreationKey.lookup(swarm, {
        ...scope, coordinatorSessionID: producerCoordinatorSessionID,
      })
      expect(foreign.found).toBe(false)
      expect((yield* swarm.list({ projectID })).map((row) => row.id)).toEqual([created.swarm.id])
    }),
  )

  it.effect("distinguishes a durably reserved but incomplete creation from active execution", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const scope = { projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, requestKey: "crash-during-creation" }
      const entry = yield* swarm.create({
        id: SwarmCreationKey.id(scope), projectID, workspaceID, directory: scope.directory,
        name: "Interrupted bootstrap",
      })
      const found = yield* SwarmCreationKey.lookup(swarm, scope)
      expect(found).toMatchObject({ found: true, swarmId: entry.id, status: "creating",
        setup: "incomplete", coordinatorRecorded: false })
      if (found.found) expect(found.nextAction).toContain("NOT create another Swarm")
    }),
  )
  it.effect("scopes deterministic creation identity by trusted principal, project, workspace and key", () =>
    Effect.sync(() => {
      const base = {
        projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, requestKey: "repeat", name: "Fixture",
      }
      const id = SwarmCreationKey.id(base)
      expect(id).toBe(SwarmCreationKey.id(base))
      expect(id).not.toBe(SwarmCreationKey.id({ ...base, requestKey: "other" }))
      expect(id).not.toBe(SwarmCreationKey.id({ ...base, coordinatorSessionID: producerCoordinatorSessionID }))
      expect(id).not.toBe(SwarmCreationKey.id({ ...base, workspaceID: otherWorkspaceID }))
      expect(id).not.toBe(SwarmCreationKey.id({ ...base, projectID: otherProjectID }))
      expect(id).not.toBe(SwarmCreationKey.id({
        ...base, coordinatorSessionID: undefined,
        coordinatorCapabilities: { tags: ["oxp:connector:trusted-connector"] },
      }))
    }),
  )
  it.effect("uses a principal-scoped at-most-once creation key and reports existing Swarm ID on retry", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const request = {
        projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID,
        requestKey: "research-run.2026-10-09", name: "Research swarm",
        tasks: [{ key: "foundation", title: "Foundation" }],
      }
      const first = yield* SwarmCommand.delegatePartial(swarm, preflightAllowingAgent(profile.agent), request)
      expect(first.swarm.status).toBe("active")
      expect(first.swarm.id.startsWith("swr_k_")).toBe(true)
      const retried = yield* SwarmCommand.delegatePartial(swarm, preflightAllowingAgent(profile.agent), request).pipe(Effect.flip)
      expect(retried._tag).toBe("Swarm.ConflictError")
      if (retried._tag === "Swarm.ConflictError") expect(retried.reason).toContain(first.swarm.id)
      const altered = yield* SwarmCommand.delegatePartial(swarm, preflightAllowingAgent(profile.agent), {
        ...request, name: "Changed intent",
      }).pipe(Effect.flip)
      expect(altered._tag).toBe("Swarm.ConflictError")
      expect((yield* swarm.list({ projectID })).map((entry) => entry.id)).toEqual([first.swarm.id])
      expect((yield* swarm.get(first.swarm.id)).tasks).toHaveLength(1)
    }),
  )

  it.effect("validates creation key and principal before writes", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      for (const key of ["", "bad key", "x".repeat(129)]) {
        const invalid = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
          projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID,
          requestKey: key, name: "No write",
        }).pipe(Effect.flip)
        expect(invalid._tag).toBe("Swarm.ValidationError")
      }
      const missingPrincipal = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command",
        requestKey: "unique", name: "No principal",
      }).pipe(Effect.flip)
      expect(missingPrincipal._tag).toBe("Swarm.ValidationError")
      expect(yield* swarm.list({ projectID })).toEqual([])
    }),
  )
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

  it.effect("keeps valid members and independent DAG components while reporting rejected items", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const denied = { ...profile, model: { ...profile.model, id: Model.ID.make("unavailable") } }
      const preflight: SwarmProfilePreflight.Interface = {
        check: ({ profile: requested }) => requested.model.id === denied.model.id
          ? Effect.fail(new SwarmSchema.ValidationError({ reason: "Model unavailable" }))
          : Effect.succeed({ model: {} as never }),
      }
      const created = yield* SwarmCommand.delegatePartial(swarm, preflight, {
        projectID,
        workspaceID,
        directory: "/swarm/command",
        coordinatorSessionID,
        name: "partially accepted",
        members: [
          { name: "good", role: "implement", desiredProfile: profile, workspacePolicy: { mode: "shared-read" } },
          { name: "bad", role: "research", desiredProfile: denied, workspacePolicy: { mode: "shared-read" } },
          { name: "good", role: "duplicate", desiredProfile: profile, workspacePolicy: { mode: "shared-read" } },
        ],
        tasks: [
          { key: "foundation", title: "Foundation", reservedMemberName: "good" },
          { key: "rejected", title: "Unavailable worker", reservedMemberName: "bad" },
          { key: "dependent", title: "Dependent", dependsOn: [{ key: "rejected" }] },
          { key: "cycleA", title: "Cycle A", dependsOn: [{ key: "cycleB" }] },
          { key: "cycleB", title: "Cycle B", dependsOn: [{ key: "cycleA" }] },
          { key: "independent", title: "Independent", dependsOn: [{ key: "foundation" }] },
        ],
      })

      expect(created.swarm.status).toBe("active")
      expect(created.members.map((item) => item.name)).toEqual(["good"])
      expect(created.tasks.map((task) => task.title)).toEqual(["Foundation", "Independent"])
      expect(created.admission.acceptedMembers).toEqual(["good"])
      expect(created.admission.failures.map((item) => [item.kind, item.key])).toEqual([
        ["member", "bad"],
        ["member", "good"],
        ["task", "rejected"],
        ["task", "dependent"],
        ["task", "cycleA"],
        ["task", "cycleB"],
      ])
      const detail = yield* swarm.get(created.swarm.id)
      expect(detail.members).toHaveLength(2)
      expect(detail.tasks).toHaveLength(2)
      expect(detail.tasks.find((task) => task.title === "Independent")?.status).toBe("blocked")
    }),
  )

  it.effect("rejects a long prerequisite chain in linear traversal without discarding independent tasks", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const chain = Array.from({ length: 1024 }, (_, index) => ({
        key: `chain-${index}`,
        title: `Chain ${index}`,
        ...(index === 0
          ? { reservedMemberName: "nonexistent" }
          : { dependsOn: [{ key: `chain-${index - 1}` }] }),
      }))
      const created = yield* SwarmCommand.delegatePartial(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command",
        coordinatorSessionID, name: "long chain",
        tasks: [...chain, { key: "safe", title: "Independent task" }],
      })
      expect(created.admission.failures).toHaveLength(1024)
      expect(created.admission.acceptedTasks).toEqual(["safe"])
      expect(created.tasks.map((task) => task.title)).toEqual(["Independent task"])
      expect((yield* swarm.get(created.swarm.id)).tasks).toHaveLength(1)
    }),
  )

  it.effect("stages members with independent failures and idempotent satisfied retries", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID,
        workspaceID,
        directory: "/swarm/command",
        coordinatorSessionID,
        name: "staged members",
      })
      const managedProfile = { ...profile, agent: Agent.ID.make("swarm-m") }
      const accepted = { name: "builder", role: "implement", desiredProfile: managedProfile, workspacePolicy: { mode: "shared-read" as const } }
      const unavailable = { ...profile, model: { ...profile.model, id: Model.ID.make("unavailable") } }
      const preflight: SwarmProfilePreflight.Interface = {
        check: ({ profile: requested }) => requested.model.id === unavailable.model.id
          ? Effect.fail(new SwarmSchema.ValidationError({ reason: "Model unavailable" }))
          : Effect.succeed({ model: {} as never }),
      }
      const stage = yield* SwarmCommand.addMembersPartial(swarm, preflight, {
        swarmID: initial.swarm.id,
        members: [
          accepted,
          { name: "offline", role: "research", desiredProfile: unavailable, workspacePolicy: { mode: "shared-read" } },
          { name: "reviewer", role: "review", desiredProfile: managedProfile, workspacePolicy: { mode: "shared-read" } },
          accepted,
          { ...accepted, role: "conflicting-role" },
        ],
      })
      expect([stage.created, stage.satisfied, stage.failed]).toEqual([2, 1, 2])
      expect(stage.receipts.map((item) => item.status)).toEqual([
        "created", "failed", "created", "satisfied", "failed",
      ])
      expect(stage.receipts[0]?.memberId).toBe(stage.receipts[3]?.memberId)
      const retry = yield* SwarmCommand.addMembersPartial(swarm, preflight, {
        swarmID: initial.swarm.id,
        members: [accepted],
      })
      expect([retry.created, retry.satisfied, retry.failed]).toEqual([0, 1, 0])
      expect((yield* swarm.get(initial.swarm.id)).members).toHaveLength(3)
    }),
  )

  it.effect("does not satisfy a stopped member or silently start a duplicate", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID, name: "lifecycle retry",
      })
      const worker = {
        name: "stoppable", role: "build",
        desiredProfile: { ...profile, agent: Agent.ID.make("swarm-m") },
        workspacePolicy: { mode: "shared-read" as const },
      }
      const first = yield* SwarmCommand.addMembersPartial(swarm, preflightAllowingAgent(worker.desiredProfile.agent), {
        swarmID: initial.swarm.id, members: [worker],
      })
      const memberID = first.receipts[0]!.memberId!
      yield* swarm.setMemberLifecycle({
        swarmID: initial.swarm.id, memberID, expectedLifecycle: "active", lifecycle: "stopped",
      })
      const retry = yield* SwarmCommand.addMembersPartial(swarm, preflightAllowingAgent(worker.desiredProfile.agent), {
        swarmID: initial.swarm.id, members: [worker],
      })
      expect(retry).toMatchObject({
        created: 0, satisfied: 0, failed: 1,
        receipts: [{ key: "stoppable", index: 0, status: "failed", memberId: memberID }],
      })
      expect(retry.receipts[0]?.reason).toContain("member.resume")
      expect((yield* swarm.get(initial.swarm.id)).members).toHaveLength(2)
    }),
  )

  it.effect("guards the member transaction against a lifecycle change after preflight", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID, name: "transaction status fence",
      })
      const worker = {
        name: "late-worker", role: "build",
        desiredProfile: { ...profile, agent: Agent.ID.make("swarm-m") },
        workspacePolicy: { mode: "shared-read" as const },
      }
      const outcome = yield* SwarmCommand.addMembersPartial(swarm, preflightAllowingAgent(worker.desiredProfile.agent), {
        swarmID: initial.swarm.id, members: [worker, { ...worker, name: "later-worker" }],
        beforeWrite: () => swarm.update({
          id: initial.swarm.id, expectedRevision: initial.swarm.revision, status: "completed",
        }).pipe(Effect.asVoid),
      })
      expect(outcome).toMatchObject({
        created: 0, satisfied: 0, failed: 2,
        receipts: [
          { key: "late-worker", index: 0, status: "failed" },
          { key: "later-worker", index: 1, status: "failed" },
        ],
      })
      expect(outcome.receipts[0]?.reason).toContain("requires active or paused")
      expect(outcome.receipts[1]?.reason).toContain("no longer accepts")
      expect((yield* swarm.get(initial.swarm.id)).members).toHaveLength(1)
      expect((yield* swarm.info(initial.swarm.id)).status).toBe("completed")
    }),
  )

  it.effect("stops on authority revocation after committed siblings and permits exact safe replay", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID, name: "revoked stage",
      })
      const worker = (name: string) => ({
        name, role: "build",
        desiredProfile: { ...profile, agent: Agent.ID.make("swarm-m") },
        workspacePolicy: { mode: "shared-read" as const },
      })
      let writes = 0
      const failure = yield* SwarmCommand.addMembersPartial(swarm, preflightAllowingAgent("swarm-m"), {
        swarmID: initial.swarm.id, members: [worker("first"), worker("second")],
        beforeWrite: () => Effect.sync(() => ++writes).pipe(
          Effect.flatMap((attempt) => attempt === 2 ? Effect.fail(new Error("grant revoked")) : Effect.void),
        ),
      }).pipe(Effect.flip)
      expect(failure instanceof Error && failure.message).toContain("grant revoked")
      expect(writes).toBe(2)
      expect((yield* swarm.get(initial.swarm.id)).members.map((member) => member.name)).toEqual([
        "coordinator", "first",
      ])
      const replay = yield* SwarmCommand.addMembersPartial(swarm, preflightAllowingAgent("swarm-m"), {
        swarmID: initial.swarm.id, members: [worker("first"), worker("second")],
      })
      expect(replay.receipts.map((receipt) => receipt.status)).toEqual(["satisfied", "created"])
      expect((yield* swarm.get(initial.swarm.id)).members).toHaveLength(3)
    }),
  )

  it.effect("stages independent tasks, preserves complete DAG edges, and replays committed keys without duplication", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID, name: "staged task DAG",
      })
      const tasks = [
        { key: "verify", title: "Verify", dependsOn: [{ key: "build", requirement: "require_success" as const }] },
        { key: "broken", title: "Broken", dependsOn: [{ key: "missing" }] },
        { key: "build", title: "Build" },
        { key: "blocked", title: "Blocked", dependsOn: [{ key: "broken" }] },
        { key: "cycle-A", title: "Cycle A", dependsOn: [{ key: "cycle-B" }] },
        { key: "cycle-B", title: "Cycle B", dependsOn: [{ key: "cycle-A" }] },
      ]
      const stage = yield* SwarmTaskBatch.add(swarm, {
        swarmID: initial.swarm.id, createdByMemberID: initial.coordinator.id, tasks,
      })
      expect([stage.created, stage.satisfied, stage.failed]).toEqual([2, 0, 4])
      expect(stage.receipts.map((r) => r.status)).toEqual([
        "created", "failed", "created", "failed", "failed", "failed",
      ])
      const verifyID = stage.receipts[0]!.taskId!
      const buildID = stage.receipts[2]!.taskId!
      expect(yield* swarm.dependencies(verifyID)).toEqual([
        { taskID: verifyID, dependsOnTaskID: buildID, requirement: "require_success" },
      ])
      expect((yield* swarm.get(initial.swarm.id)).tasks.find((task) => task.id === verifyID)?.status).toBe("blocked")
      const replay = yield* SwarmTaskBatch.add(swarm, {
        swarmID: initial.swarm.id, createdByMemberID: initial.coordinator.id, tasks: [tasks[0]!, tasks[2]!],
      })
      expect([replay.created, replay.satisfied, replay.failed]).toEqual([0, 2, 0])
      expect((yield* swarm.get(initial.swarm.id)).tasks).toHaveLength(2)
      const conflict = yield* SwarmTaskBatch.add(swarm, {
        swarmID: initial.swarm.id, createdByMemberID: initial.coordinator.id,
        tasks: [{ key: "build", title: "Changed build intent" }],
      })
      expect(conflict.receipts[0]).toMatchObject({ status: "failed", taskId: buildID })
      const next = yield* SwarmTaskBatch.add(swarm, {
        swarmID: initial.swarm.id, createdByMemberID: initial.coordinator.id,
        tasks: [{ key: "next", title: "Next stage", dependsOn: [{ key: "verify" }] }],
      })
      expect(next.receipts[0]?.status).toBe("created")
      expect((yield* swarm.get(initial.swarm.id)).tasks).toHaveLength(3)
    }),
  )

  it.effect("fences task insertion after a lifecycle change and preserves safe receipts", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID, name: "task status fence",
      })
      const tasks = [{ key: "first", title: "First" }, { key: "second", title: "Second" }]
      const stage = yield* SwarmTaskBatch.add(swarm, {
        swarmID: initial.swarm.id, createdByMemberID: initial.coordinator.id, tasks,
        beforeWrite: () => swarm.update({
          id: initial.swarm.id, expectedRevision: initial.swarm.revision, status: "completed",
        }).pipe(Effect.asVoid),
      })
      expect(stage.receipts.map((r) => r.status)).toEqual(["failed", "failed"])
      expect((yield* swarm.get(initial.swarm.id)).tasks).toHaveLength(0)
      expect((yield* swarm.info(initial.swarm.id)).status).toBe("completed")
    }),
  )

  it.effect("preserves committed tasks if coordinator authority is revoked mid-stage", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID, name: "task revoked",
      })
      let attempts = 0
      const tasks = [{ key: "a", title: "A" }, { key: "b", title: "B" }]
      const denied = yield* SwarmTaskBatch.add(swarm, {
        swarmID: initial.swarm.id, createdByMemberID: initial.coordinator.id, tasks,
        beforeWrite: () => Effect.sync(() => ++attempts).pipe(Effect.flatMap((count) =>
          count === 2 ? Effect.fail(new Error("grant revoked")) : Effect.void)),
      }).pipe(Effect.flip)
      expect(denied instanceof Error && denied.message).toContain("grant revoked")
      expect((yield* swarm.get(initial.swarm.id)).tasks).toHaveLength(1)
      const replay = yield* SwarmTaskBatch.add(swarm, {
        swarmID: initial.swarm.id, createdByMemberID: initial.coordinator.id, tasks,
      })
      expect(replay.receipts.map((r) => r.status)).toEqual(["satisfied", "created"])
      expect((yield* swarm.get(initial.swarm.id)).tasks).toHaveLength(2)
    }),
  )

  it.effect("accepts staged dependencies on initial creation's symbolic task keys", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID, name: "initial then stage",
        tasks: [{ key: "foundation", title: "Foundation" }],
      })
      const stage = yield* SwarmTaskBatch.add(swarm, {
        swarmID: initial.swarm.id, createdByMemberID: initial.coordinator.id,
        tasks: [{ key: "followup", title: "Follow-up", dependsOn: [{ key: "foundation" }] }],
      })
      expect(stage.receipts[0]?.status).toBe("created")
      const followup = stage.receipts[0]!.taskId!
      expect(yield* swarm.dependencies(followup)).toEqual([
        { taskID: followup, dependsOnTaskID: initial.tasks[0]!.id, requirement: "require_success" },
      ])
      expect((yield* swarm.get(initial.swarm.id)).tasks.find((task) => task.id === followup)?.status).toBe("blocked")
    }),
  )

  it.effect("rejects blank reservation and preserves unrelated runnable tasks", () =>
    Effect.gen(function* () {
      const swarm = yield* setup
      const initial = yield* SwarmCommand.delegate(swarm, preflightAllowingAgent(profile.agent), {
        projectID, workspaceID, directory: "/swarm/command", coordinatorSessionID, name: "blank reservation",
      })
      const result = yield* SwarmTaskBatch.add(swarm, {
        swarmID: initial.swarm.id, createdByMemberID: initial.coordinator.id,
        tasks: [
          { key: "bad", title: "Bad", reservedMemberName: " " },
          { key: "good", title: "Good" },
        ],
      })
      expect(result.receipts.map((r) => r.status)).toEqual(["failed", "created"])
      expect((yield* swarm.get(initial.swarm.id)).tasks).toHaveLength(1)
    }),
  )
})
