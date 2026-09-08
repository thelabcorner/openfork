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
    expect((yield* groups.listWithSessions()).find((item) => item.group.id === group.id)?.sessions).toHaveLength(1)

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
