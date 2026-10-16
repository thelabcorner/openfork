/** Shell recovery when the OXP transport is unavailable. Uses the same domain
 * containment owner as OXP; never edits database rows or replays tool calls. */
import path from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSessionProjector } from "@opencode-ai/core/swarm-session-projector"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmContainment } from "@/swarm/containment"

const args = process.argv.slice(2)
const filename = args[0]
const swarmID = args[1]
if (!filename || !path.isAbsolute(filename) || !swarmID || !args.includes("--acknowledge-external-effects")) {
  throw new Error("Usage: bun script/recover-swarm-sessions.ts <absolute database path> <swarm ID> --acknowledge-external-effects. First establish OS containment; interrupted effects are recorded as unknown.")
}
const runtime = ManagedRuntime.make(AppNodeBuilder.build(LayerNode.group([
  Database.node, EventV2.node, RuntimeOwner.node, SessionExecutionOwner.node,
  SessionProjector.node, SwarmSessionProjector.node, SwarmV2.node, SwarmContainment.node,
]), [[Database.node, Database.layerFromPath(filename)]]))
try {
  await runtime.runPromise(Effect.gen(function* () {
    const swarms = yield* SwarmV2.Service
    const containment = yield* SwarmContainment.Service
    const id = Swarm.ID.make(swarmID)
    const detail = yield* swarms.get(id)
    for (const member of detail.members) {
      if (member.kind !== "managed_worker" || !member.sessionID) continue
      const result = yield* containment.acknowledgeSession({ swarmID: id, memberID: member.id })
      const task = result.state === "task-owned"
        ? yield* containment.acknowledge({ taskID: result.taskID, generation: result.leaseGeneration })
        : undefined
      console.log(JSON.stringify({ memberID: member.id, name: member.name, sessionID: member.sessionID, result, ...(task ? { task } : {}) }))
    }
  }))
} finally {
  await runtime.dispose()
}
