import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import type { Swarm } from "@opencode-ai/schema/swarm"
import { ToolRegistry } from "@/tool/registry"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([ToolRegistry.node, Database.node, SwarmV2.node]),
  ),
)

const runnableProfile = {
  agent: Agent.ID.make("build"),
  model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") },
  permissionBoundary: [],
} satisfies Swarm.MemberExecutionProfile

/**
 * The refusal a preflight can prove without any catalog: the agent does not
 * exist. Every other preflight rejection is checked after this one, so this
 * profile is the deterministic "cannot run" case.
 */
const unrunnableProfile = {
  ...runnableProfile,
  agent: Agent.ID.make("swarm-absent-agent"),
} satisfies Swarm.MemberExecutionProfile

function context(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_swarm_member_preflight"),
    callID: "call_swarm_member_preflight",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.swarm member.add profile preflight", () => {
  it.instance("refuses an unrunnable execution profile before writing any member row", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const swarms = yield* SwarmV2.Service
      const { db } = yield* Database.Service
      const instance = yield* requireInstance
      const tool = (yield* registry.all()).find((item) => item.id === "swarm")
      if (!tool) return yield* Effect.die("swarm tool not registered")

      const coordinatorSession = SessionID.make("ses_swarm_member_preflight")
      yield* db
        .insert(SessionTable)
        .values({
          id: coordinatorSession,
          project_id: instance.project.id,
          slug: coordinatorSession,
          directory: instance.directory,
          title: "Preflight coordinator",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const created = yield* swarms.create({
        projectID: instance.project.id,
        directory: instance.directory,
        name: "member preflight swarm",
      })
      const coordinator = yield* swarms.addMember({
        swarmID: created.id,
        name: "lead",
        kind: "coordinator",
        role: "coordinate",
        sessionID: coordinatorSession,
        workspacePolicy: { mode: "shared-read" },
      })
      yield* swarms.update({
        id: created.id,
        expectedRevision: created.revision,
        coordinatorMemberID: coordinator.id,
        status: "active",
      })

      const refused = yield* tool
        .execute(
          {
            action: "member.add",
            swarmId: created.id,
            memberName: "impossible",
            memberRole: "implement",
            desiredProfile: unrunnableProfile,
            workspacePolicy: { mode: "shared-read" },
          },
          context(coordinatorSession),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) {
        const reported = Cause.pretty(refused.cause)
        expect(reported).toContain("swarm-absent-agent")
      }

      // Negative invariant: the refusal must leave zero durable member rows
      // behind, not a permanently unbound managed worker.
      const detail = yield* swarms.get(created.id)
      expect(detail.members.map((member) => member.name)).toEqual(["lead"])
      expect(detail.members.some((member) => member.kind === "managed_worker")).toBe(false)
    }),
  )
})