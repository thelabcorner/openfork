import { Effect } from "effect"
import {
  resolveSwarmTarget,
  wakeMemberSelfHeal,
  normalizeSwarmId,
  MemberNotFoundError,
  type SwarmStore,
} from "./self-heal"

export interface WakeInput {
  swarmId: string
  member: string
}

export interface WakeToolResult {
  title: string
  output: string
}

export function wake(
  store: SwarmStore,
  rawInput: WakeInput,
  ctx: { coordinator: { model: { providerID: string; modelID: string } } },
): Effect.Effect<WakeToolResult, Error> {
  const input = normalizeSwarmId(rawInput as unknown as Record<string, unknown>) as unknown as WakeInput
  return Effect.gen(function* () {
    const swarm = yield* resolveSwarmTarget(store, input.swarmId, {
      coordinator: ctx.coordinator,
      createIfMissing: false,
      autoRevive: false,
    })
    let result
    try {
      result = yield* wakeMemberSelfHeal(store, swarm, input.member)
    } catch (e) {
      if (e instanceof MemberNotFoundError) {
        return yield* Effect.fail(
          new Error(`${e.message} List members with swarm_status detail=members.`),
        )
      }
      return yield* Effect.fail(e as Error)
    }
    if (result.recovered) {
      return {
        title: `recovered ${input.member}`,
        output:
          `member '${input.member}' was ${result.before} — auto-recovered to working. ` +
          `It will resume picking up tasks; no re-spawn needed.`,
      }
    }
    return {
      title: `woke ${input.member}`,
      output: `member '${input.member}' is ${result.status} and was woken.`,
    }
  })
}
