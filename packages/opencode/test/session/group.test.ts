import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionGroup } from "@/session/group"
import { Goal } from "@opencode-ai/core/goal"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionGroup.node,
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
    const plugin = yield* groups.create({ name: "Swarm", kind: "plugin", ownerPlugin: "openswarm" })

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
      originPlugin: "openswarm",
    })
    const foreign = yield* groups
      .removeSession({ groupId: plugin.id, sessionId: session.id, ownerPlugin: "foreign" })
      .pipe(Effect.flip)
    expect(foreign._tag).toBe("SessionGroupOwnerMismatchError")
    yield* groups.removeSession({ groupId: plugin.id, sessionId: session.id, ownerPlugin: "openswarm" })
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

it.instance("keeps plugin groups distinct by stable owner ref and can re-anchor one in place", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const groups = yield* SessionGroup.Service
    const firstCoordinator = yield* sessions.create({ title: "Coordinator A" })
    const secondCoordinator = yield* sessions.create({ title: "Coordinator B" })

    const first = yield* groups.resolveOrCreate({
      name: "Swarm A",
      kind: "plugin",
      ownerPlugin: "openswarm",
      ownerRef: "swarm-a",
      anchorSessionId: firstCoordinator.id,
    })
    const second = yield* groups.resolveOrCreate({
      name: "Swarm B",
      kind: "plugin",
      ownerPlugin: "openswarm",
      ownerRef: "swarm-b",
      anchorSessionId: firstCoordinator.id,
    })
    expect(first.id).not.toBe(second.id)

    yield* groups.addSession({
      groupId: first.id,
      sessionId: firstCoordinator.id,
      origin: "plugin",
      originPlugin: "openswarm",
    })
    yield* groups.addSession({
      groupId: second.id,
      sessionId: firstCoordinator.id,
      origin: "plugin",
      originPlugin: "openswarm",
    })

    const rebound = yield* groups.resolveOrCreate({
      name: "Swarm A renamed",
      kind: "plugin",
      ownerPlugin: "openswarm",
      ownerRef: "swarm-a",
      anchorSessionId: secondCoordinator.id,
    })
    expect(rebound.id).toBe(first.id)
    expect(rebound.anchorSessionID).toBe(secondCoordinator.id)
    expect(rebound.name).toBe("Swarm A renamed")
    expect(rebound.ownerRef).toBe("swarm-a")
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
