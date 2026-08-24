import { Effect } from "effect"
import {
  resolveSwarmTarget,
  normalizeSwarmId,
  type SwarmStore,
} from "./self-heal"

export type PermissionResponse = "once" | "always" | "reject"

export interface PermissionsReplyInput {
  swarmId: string
  permissionId: string
  response: PermissionResponse
  rule?: string
}

export interface PermissionsResult {
  title: string
  output: string
}

export function reply(
  store: SwarmStore,
  rawInput: PermissionsReplyInput,
  ctx: { coordinator: { model: { providerID: string; modelID: string } } },
): Effect.Effect<PermissionsResult, Error> {
  const input = normalizeSwarmId(rawInput as unknown as Record<string, unknown>) as unknown as PermissionsReplyInput
  return Effect.gen(function* () {
    const swarm = yield* resolveSwarmTarget(store, input.swarmId, {
      coordinator: ctx.coordinator,
      createIfMissing: false,
      autoRevive: false,
    })
    if (store.replyPermission) {
      const outcome = yield* store.replyPermission(swarm, input.permissionId, input.response)
      if (outcome === "answered") {
        return {
          title: "permission answered",
          output: `Granted '${input.response}' for prompt ${input.permissionId}. The member is unblocked.`,
        }
      }
      if (outcome === "expired" || outcome === "gone") {
        if (store.allowRule && input.rule) {
          yield* store.allowRule(swarm, input.rule, input.response)
          return {
            title: "standing allow rule added",
            output:
              `Prompt ${input.permissionId} had already expired, so it could not be answered directly. ` +
              `To stop the member from hitting the same wall again, I added a standing allow rule for '${input.rule}' (${input.response}). ` +
              `The member will retry the blocked action and now pass automatically.`,
          }
        }
        return {
          title: "permission prompt gone",
          output:
            `Prompt ${input.permissionId} had already expired or been answered — nothing to answer now. ` +
            `The member will re-prompt with a FRESH permissionId on its next blocked action; grant that one. ` +
            `To pre-approve a recurring pattern, pass 'rule' (e.g. "C:/Users/slooshied/**") with response 'always'.`,
        }
      }
    }
    return {
      title: "permission replied",
      output: `Recorded '${input.response}' for prompt ${input.permissionId} on swarm '${input.swarmId}'.`,
    }
  })
}
