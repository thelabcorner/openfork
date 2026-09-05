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
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionGroup.node,
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

    yield* sessions.remove(session.id)
    yield* groups.remove(first.id)
    yield* groups.remove(second.id)
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

    yield* sessions.remove(session.id)
    yield* groups.remove(subagents.id)
    yield* groups.remove(plugin.id)
  }),
)
