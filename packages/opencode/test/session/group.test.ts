import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionGroupMemberTable, SessionGroupTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionGroup } from "@/session/group"
import { Goal } from "@opencode-ai/core/goal"
import { SessionGroup as SessionGroupModel } from "@opencode-ai/schema/session-group"
import { SwarmID } from "@opencode-ai/schema/swarm-id"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import type { Swarm } from "@opencode-ai/schema/swarm"
import { testEffect } from "../lib/effect"

const managedProfile = {
  agent: Agent.ID.make("build"),
  model: {
    providerID: Provider.ID.make("test"),
    id: Model.ID.make("test-model"),
  },
  permissionBoundary: [],
} satisfies Swarm.MemberExecutionProfile

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionGroup.node,
      SwarmV2.node,
      Goal.node,
      Database.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(
          InstanceBootstrap.Service,
          InstanceBootstrap.Service.of({ gate: Effect.void, warmup: Effect.void }),
        ),
      ],
    ],
  ),
)

it.instance("supports multiple memberships and preserves a replacement primary group", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const database = yield* Database.Service
    const session = yield* sessions.create({ title: "Grouped session" })
    const first = yield* groups.create({ name: "First" })
    const second = yield* groups.create({ name: "Second" })

    yield* groups.addSession({ groupId: first.id, sessionId: session.id })
    yield* groups.addSession({ groupId: second.id, sessionId: session.id })
    expect((yield* groups.membershipsFor(session.id)).map((detail) => detail.group.id)).toEqual([first.id, second.id])

    yield* groups.removeSession({ groupId: first.id, sessionId: session.id })
    const row = yield* database.db
      .select({ group_id: SessionTable.group_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, session.id))
      .get()
    expect(row?.group_id).toBe(second.id)
    expect((yield* groups.list()).some((group) => group.id === first.id)).toBe(false)

    yield* sessions.remove(session.id)
    expect((yield* groups.list()).some((group) => group.id === second.id)).toBe(false)
  }),
)

it.instance("enforces subagent and plugin membership ownership", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const session = yield* sessions.create({ title: "Locked session" })
    const subagents = yield* groups.create({ name: "Subagents", kind: "subagent", anchorSessionId: session.id })
    const plugin = yield* groups.create({ name: "Plugin workspace", kind: "plugin", ownerPlugin: "example-plugin" })

    yield* groups.addSession({
      groupId: subagents.id,
      sessionId: session.id,
      locked: true,
      origin: "auto_subagent",
    })
    const locked = yield* groups.removeSession({ groupId: subagents.id, sessionId: session.id }).pipe(Effect.flip)
    expect(locked._tag).toBe("SessionGroupMemberLockedError")

    yield* groups.addSession({
      groupId: plugin.id,
      sessionId: session.id,
      locked: true,
      origin: "plugin",
      originPlugin: "example-plugin",
    })
    const foreign = yield* groups
      .removeSession({ groupId: plugin.id, sessionId: session.id, ownerPlugin: "foreign" })
      .pipe(Effect.flip)
    expect(foreign._tag).toBe("SessionGroupOwnerMismatchError")
    yield* groups.removeSession({ groupId: plugin.id, sessionId: session.id, ownerPlugin: "example-plugin" })
    expect((yield* groups.list()).some((group) => group.id === plugin.id)).toBe(false)

    yield* sessions.remove(session.id)
    expect((yield* groups.list()).some((group) => group.id === subagents.id)).toBe(false)
  }),
)

it.instance("never exposes membership-empty groups", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const session = yield* sessions.create({ title: "Visible member" })
    const group = yield* groups.create({ name: "No empty flash" })

    expect((yield* groups.list()).some((item) => item.id === group.id)).toBe(false)
    expect((yield* groups.listWithSessions()).some((item) => item.group.id === group.id)).toBe(false)

    yield* groups.addSession({ groupId: group.id, sessionId: session.id })
    expect((yield* groups.list()).some((item) => item.id === group.id)).toBe(true)
    const members = (yield* groups.listWithSessions()).find((item) => item.group.id === group.id)?.sessions
    expect(members).toHaveLength(1)
    expect(members?.[0]).toMatchObject({
      id: session.id,
      slug: session.slug,
      projectID: session.projectID,
      directory: session.directory,
      title: session.title,
      version: session.version,
    })
    expect(members?.[0]?.time?.created.epochMilliseconds).toBe(session.time.created)
    expect(members?.[0]?.time?.updated.epochMilliseconds).toBeGreaterThanOrEqual(session.time.updated)

    yield* groups.removeSession({ groupId: group.id, sessionId: session.id })
    expect((yield* groups.list()).some((item) => item.id === group.id)).toBe(false)
    expect((yield* groups.listWithSessions()).some((item) => item.group.id === group.id)).toBe(false)
  }),
)

it.instance("rejects generic mutation of virtual Swarm group identities before touching persisted group rows", () =>
  Effect.gen(function* () {
    const groups = yield* SessionGroup.Service
    const virtualID = SessionGroupModel.groupIDForSwarm(SwarmID.make("swr_virtual_mutation_guard"))

    const operations: ReadonlyArray<Effect.Effect<void, unknown>> = [
      groups.rename({ id: virtualID, name: "Nope" }),
      groups.reorder({ id: virtualID, position: 1 }),
      groups.addSession({ groupId: virtualID, sessionId: "ses_missing" }),
      groups.removeSession({ groupId: virtualID, sessionId: "ses_missing" }),
      groups.setPolicy({
        id: virtualID,
        policy: { autoAddDescendants: false, lockAdded: false, autoDeleteWhenEmpty: false },
      }),
      groups.reorderMembers({ id: virtualID, sessionIds: [] }),
      groups.remove(virtualID),
    ]

    for (const operation of operations) {
      const error = yield* operation.pipe(Effect.flip)
      expect((error as { _tag?: string })._tag).toBe("SessionGroupManagedProjectionError")
      if ((error as { _tag?: string })._tag === "SessionGroupManagedProjectionError") {
        expect((error as { code?: string }).code).toBe("session_group.managed_projection")
        expect((error as { groupID?: string }).groupID).toBe(virtualID)
      }
    }
  }),
)

it.instance("projects Swarm membership as a read-only virtual SessionGroup without materializing group state", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const swarms = yield* SwarmV2.Service
    const database = yield* Database.Service
    const coordinator = yield* sessions.create({ title: "Native coordinator" })
    const worker = yield* sessions.create({ title: "Native worker" })
    const coordinatorRow = yield* database.db
      .select({ id: SessionTable.id, projectID: SessionTable.project_id, directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.id, coordinator.id))
      .get()
      .pipe(Effect.orDie)
    if (!coordinatorRow) throw new Error("coordinator Session row missing")

    const swarm = yield* swarms.create({
      projectID: coordinatorRow.projectID,
      directory: coordinatorRow.directory,
      name: "Native Swarm",
      now: 1_000,
    })
    const coordinatorMember = yield* swarms.addMember({
      swarmID: swarm.id,
      name: "coordinator",
      kind: "coordinator",
      role: "Lead",
      sessionID: coordinatorRow.id,
      workspacePolicy: { mode: "shared-read" },
      now: 1_010,
    })
    const workerRow = yield* database.db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, worker.id))
      .get()
      .pipe(Effect.orDie)
    if (!workerRow) throw new Error("worker Session row missing")
    const workerMember = yield* swarms.addMember({
      swarmID: swarm.id,
      name: "worker",
      kind: "managed_worker",
      role: "Implementer",
      desiredProfile: managedProfile,
      sessionID: workerRow.id,
      workspacePolicy: { mode: "shared-read" },
      now: 1_020,
    })
    yield* swarms.update({
      id: swarm.id,
      expectedRevision: 0,
      coordinatorMemberID: coordinatorMember.id,
      now: 1_030,
    })

    const virtualID = SessionGroupModel.groupIDForSwarm(swarm.id)
    const detail = yield* groups.getWithSessions(virtualID)
    expect(detail.group).toMatchObject({
      id: virtualID,
      kind: "swarm",
      name: "Native Swarm",
      ownerRef: swarm.id,
      anchorSessionID: coordinator.id,
      position: 1_000,
    })
    expect(detail.group.ownerPlugin).toBeUndefined()
    expect(detail.sessions).toHaveLength(2)
    expect(detail.sessions[0]).toMatchObject({
      id: coordinator.id,
      locked: true,
      origin: "swarm",
      originRef: coordinatorMember.id,
      position: 0,
    })
    expect(detail.sessions[1]).toMatchObject({
      id: worker.id,
      locked: true,
      origin: "swarm",
      originRef: workerMember.id,
      position: 1,
    })

    expect((yield* groups.list()).find((item) => item.id === virtualID)).toMatchObject({ kind: "swarm" })
    expect((yield* groups.membershipsFor(worker.id)).map((item) => item.group.id)).toContain(virtualID)
    expect(yield* database.db.select().from(SessionGroupTable).all().pipe(Effect.orDie)).toEqual([])
    expect(yield* database.db.select().from(SessionGroupMemberTable).all().pipe(Effect.orDie)).toEqual([])
    expect(
      yield* database.db
        .select({ groupID: SessionTable.group_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, worker.id))
        .get()
        .pipe(Effect.orDie),
    ).toEqual({ groupID: null })

    yield* swarms.setMemberLifecycle({
      swarmID: swarm.id,
      memberID: coordinatorMember.id,
      expectedLifecycle: "active",
      lifecycle: "stopped",
      now: 1_040,
    })
    const withoutCoordinator = yield* groups.getWithSessions(virtualID)
    expect(withoutCoordinator.group.id).toBe(virtualID)
    expect(withoutCoordinator.group.anchorSessionID).toBeUndefined()
    expect(withoutCoordinator.sessions.map((item) => item.id)).toEqual([worker.id])
    expect((yield* groups.list()).some((item) => item.id === virtualID)).toBe(true)
  }),
)

it.instance("allows one Session in multiple virtual Swarm groups and hides zero-bound Swarms without deleting them", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const swarms = yield* SwarmV2.Service
    const database = yield* Database.Service
    const session = yield* sessions.create({ title: "Shared coordinator" })
    const row = yield* database.db
      .select({ id: SessionTable.id, projectID: SessionTable.project_id, directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.id, session.id))
      .get()
      .pipe(Effect.orDie)
    if (!row) throw new Error("Session row missing")

    const a = yield* swarms.create({ projectID: row.projectID, directory: row.directory, name: "A", now: 2_000 })
    const b = yield* swarms.create({ projectID: row.projectID, directory: row.directory, name: "B", now: 2_100 })
    const empty = yield* swarms.create({ projectID: row.projectID, directory: row.directory, name: "Empty", now: 2_200 })
    const memberA = yield* swarms.addMember({
      swarmID: a.id,
      name: "shared-a",
      kind: "coordinator",
      role: "Lead",
      sessionID: row.id,
      workspacePolicy: { mode: "shared-read" },
    })
    yield* swarms.addMember({
      swarmID: b.id,
      name: "shared-b",
      kind: "coordinator",
      role: "Lead",
      sessionID: row.id,
      workspacePolicy: { mode: "shared-read" },
    })

    const memberships = yield* groups.membershipsFor(session.id)
    expect(memberships.map((item) => item.group.id)).toEqual([
      SessionGroupModel.groupIDForSwarm(a.id),
      SessionGroupModel.groupIDForSwarm(b.id),
    ])
    expect((yield* groups.list()).some((item) => item.id === SessionGroupModel.groupIDForSwarm(empty.id))).toBe(false)

    yield* swarms.setMemberLifecycle({
      swarmID: a.id,
      memberID: memberA.id,
      expectedLifecycle: "active",
      lifecycle: "stopped",
      now: 2_300,
    })
    expect((yield* groups.list()).some((item) => item.id === SessionGroupModel.groupIDForSwarm(a.id))).toBe(false)
    expect((yield* swarms.get(a.id)).swarm.id).toBe(a.id)
  }),
)

it.instance("refreshes a Swarm coordinator rebind immediately without changing the virtual group identity", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const swarms = yield* SwarmV2.Service
    const database = yield* Database.Service
    const first = yield* sessions.create({ title: "Coordinator one" })
    const second = yield* sessions.create({ title: "Coordinator two" })
    const rows = yield* database.db
      .select({ id: SessionTable.id, projectID: SessionTable.project_id, directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.project_id, first.projectID))
      .all()
      .pipe(Effect.orDie)
    const firstRow = rows.find((row) => row.id === first.id)
    const secondRow = rows.find((row) => row.id === second.id)
    if (!firstRow || !secondRow) throw new Error("coordinator Session rows missing")

    const swarm = yield* swarms.create({
      projectID: firstRow.projectID,
      directory: firstRow.directory,
      name: "Rebind",
      now: 3_000,
    })
    const member = yield* swarms.addMember({
      swarmID: swarm.id,
      name: "coordinator",
      kind: "coordinator",
      role: "Lead",
      sessionID: firstRow.id,
      workspacePolicy: { mode: "shared-read" },
      now: 3_010,
    })
    yield* swarms.update({ id: swarm.id, expectedRevision: 0, coordinatorMemberID: member.id, now: 3_020 })

    const virtualID = SessionGroupModel.groupIDForSwarm(swarm.id)
    expect((yield* groups.getWithSessions(virtualID)).group.anchorSessionID).toBe(first.id)
    yield* groups.listWithSessions()

    yield* swarms.rebindMember({
      swarmID: swarm.id,
      memberID: member.id,
      expectedBindingGeneration: 1,
      sessionID: secondRow.id,
      now: 3_030,
    })

    const rebound = yield* groups.getWithSessions(virtualID)
    expect(rebound.group.id).toBe(virtualID)
    expect(rebound.group.anchorSessionID).toBe(second.id)
    expect(rebound.sessions.map((item) => item.id)).toEqual([second.id])
  }),
)

it.instance("keeps plugin groups distinct by stable owner ref and can re-anchor one in place", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const firstCoordinator = yield* sessions.create({ title: "Coordinator A" })
    const secondCoordinator = yield* sessions.create({ title: "Coordinator B" })

    const first = yield* groups.resolveOrCreate({
      name: "Plugin collection A",
      kind: "plugin",
      ownerPlugin: "example-plugin",
      ownerRef: "collection-a",
      anchorSessionId: firstCoordinator.id,
    })
    const second = yield* groups.resolveOrCreate({
      name: "Plugin collection B",
      kind: "plugin",
      ownerPlugin: "example-plugin",
      ownerRef: "collection-b",
      anchorSessionId: firstCoordinator.id,
    })
    expect(first.id).not.toBe(second.id)

    yield* groups.addSession({
      groupId: first.id,
      sessionId: firstCoordinator.id,
      origin: "plugin",
      originPlugin: "example-plugin",
    })
    yield* groups.addSession({
      groupId: second.id,
      sessionId: firstCoordinator.id,
      origin: "plugin",
      originPlugin: "example-plugin",
    })

    const rebound = yield* groups.resolveOrCreate({
      name: "Plugin collection A renamed",
      kind: "plugin",
      ownerPlugin: "example-plugin",
      ownerRef: "collection-a",
      anchorSessionId: secondCoordinator.id,
    })
    expect(rebound.id).toBe(first.id)
    expect(rebound.anchorSessionID).toBe(secondCoordinator.id)
    expect(rebound.name).toBe("Plugin collection A renamed")
    expect(rebound.ownerRef).toBe("collection-a")
  }),
)

it.instance("inherits focused Goal into a child before first use and annotates its subagent membership", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const goals = yield* Goal.Service
    const parent = yield* sessions.create({ title: "Goal owner" })
    const created = yield* goals
      .create({
        projectID: parent.projectID,
        workspaceID: parent.workspaceID,
        title: "Delegated Goal",
        objective: "Delegate one unit of work",
        criteria: ["Worker receives Goal context"],
      })
      .pipe(Effect.orDie)
    const active = yield* goals
      .transition({ id: created.goal.id, expectedRevision: 0, action: "start" })
      .pipe(Effect.orDie)
    yield* goals.focus({ goalID: active.goal.id, sessionID: parent.id }).pipe(Effect.orDie)

    const child = yield* sessions.create({ parentID: parent.id, title: "Goal worker" })
    expect(yield* goals.focused(child.id)).toMatchObject({
      focus: { goalID: created.goal.id, role: "worker" },
    })

    // Group placement is intentionally off the create() critical path. Give the
    // already-started fork one scheduler turn, then prove it records the Goal
    // association without inventing a second grouping subsystem.
    yield* Effect.sleep("25 millis")
    const memberships = yield* groups.membershipsFor(child.id)
    const worker = memberships.flatMap((detail) => detail.sessions).find((member) => member.id === child.id)
    expect(worker).toMatchObject({
      locked: true,
      origin: "auto_subagent",
      originRef: `goal:${created.goal.id}`,
    })
  }),
)

it.instance("couples the reusable Goal Auditor child into the parent subagent group as an irremovable member", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const goals = yield* Goal.Service
    const parent = yield* sessions.create({ title: "Audited Goal owner" })
    const created = yield* goals
      .create({
        projectID: parent.projectID,
        workspaceID: parent.workspaceID,
        title: "Audited Goal",
        objective: "Keep one durable auditor transcript",
        criteria: ["Auditor is coupled to the parent Session"],
        continuationPolicy: { mode: "auto_continue" },
      })
      .pipe(Effect.orDie)
    const active = yield* goals
      .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
      .pipe(Effect.orDie)
    yield* goals.focus({ goalID: active.goal.id, sessionID: parent.id }).pipe(Effect.orDie)

    const auditor = yield* goals.auditorSession({ parentSessionID: parent.id, goalID: active.goal.id }).pipe(Effect.orDie)
    const reused = yield* goals.auditorSession({ parentSessionID: parent.id, goalID: active.goal.id }).pipe(Effect.orDie)
    expect(reused).toBe(auditor)

    // Group attachment is event-driven and intentionally outside child creation's
    // critical path, matching ordinary automatic subagent grouping.
    yield* Effect.sleep("25 millis")
    const memberships = yield* groups.membershipsFor(auditor)
    const detail = memberships.find((item) => item.sessions.some((member) => member.id === auditor))
    expect(detail?.group).toMatchObject({ kind: "subagent", anchorSessionID: parent.id })
    const parentMember = detail?.sessions.find((member) => member.id === parent.id)
    const auditorMember = detail?.sessions.find((member) => member.id === auditor)
    expect(parentMember).toMatchObject({ origin: "auto_subagent" })
    expect(auditorMember).toMatchObject({
      locked: true,
      origin: "goal_auditor",
      originRef: `goal:${active.goal.id}`,
      parentID: parent.id,
    })

    if (!detail) throw new Error("Goal Auditor group was not attached")
    const removal = yield* groups.removeSession({ groupId: detail.group.id, sessionId: auditor }).pipe(Effect.flip)
    expect(removal._tag).toBe("SessionGroupMemberLockedError")
  }),
)

it.instance("couples generic special-agent children as locked special_agent members", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const parent = yield* sessions.create({ title: "Special agent owner" })
    const revisor = yield* sessions.create({
      parentID: parent.id,
      title: "Prompt Revisor",
      metadata: { specialAgent: "prompt_revisor", specialAgentOwnerID: "owner-1" },
    })
    const titler = yield* sessions.create({
      parentID: parent.id,
      title: "Session Title",
      metadata: { specialAgent: "session_title" },
    })
    const spadAuditor = yield* sessions.create({
      parentID: parent.id,
      title: "SPAD auditor",
      metadata: { specialAgent: "spad_auditor", specialAgentOwnerKind: "session", specialAgentOwnerID: parent.id },
    })

    // Group attachment is event-driven and intentionally outside child creation's
    // critical path, matching ordinary automatic subagent grouping.
    yield* Effect.sleep("25 millis")

    const revisorDetail = (yield* groups.membershipsFor(revisor.id)).find((item) =>
      item.sessions.some((member) => member.id === revisor.id),
    )
    expect(revisorDetail?.group).toMatchObject({ kind: "subagent", anchorSessionID: parent.id })
    expect(revisorDetail?.sessions.find((member) => member.id === parent.id)).toMatchObject({ origin: "auto_subagent" })
    expect(revisorDetail?.sessions.find((member) => member.id === revisor.id)).toMatchObject({
      locked: true,
      origin: "special_agent",
      originRef: "prompt_revisor:owner-1",
      parentID: parent.id,
    })

    const titlerDetail = (yield* groups.membershipsFor(titler.id)).find((item) =>
      item.sessions.some((member) => member.id === titler.id),
    )
    expect(titlerDetail?.group).toMatchObject({ kind: "subagent", anchorSessionID: parent.id })
    expect(titlerDetail?.sessions.find((member) => member.id === titler.id)).toMatchObject({
      locked: true,
      origin: "special_agent",
      originRef: `session_title:${titler.id}`,
      parentID: parent.id,
    })

    const spadDetail = (yield* groups.membershipsFor(spadAuditor.id)).find((item) =>
      item.sessions.some((member) => member.id === spadAuditor.id),
    )
    expect(spadDetail?.group).toMatchObject({ kind: "subagent", anchorSessionID: parent.id })
    expect(spadDetail?.sessions.find((member) => member.id === spadAuditor.id)).toMatchObject({
      locked: true,
      origin: "special_agent",
      originRef: `spad_auditor:${parent.id}`,
      parentID: parent.id,
    })

    if (!revisorDetail) throw new Error("Prompt Revisor group was not attached")
    const removal = yield* groups.removeSession({ groupId: revisorDetail.group.id, sessionId: revisor.id }).pipe(Effect.flip)
    expect(removal._tag).toBe("SessionGroupMemberLockedError")
  }),
)
