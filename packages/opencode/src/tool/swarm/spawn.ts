import { Effect } from "effect"
import {
  resolveSwarmTarget,
  spawnMembersAtomic,
  normalizeSwarmId,
  SwarmNotFoundError,
  type SwarmStore,
  type MemberInput,
} from "./self-heal"

export interface SpawnInput {
  swarmId: string
  members: MemberInput[]
  replace?: boolean
}

export interface SpawnToolResult {
  title: string
  output: string
}

export function spawn(
  store: SwarmStore,
  rawInput: SpawnInput,
  ctx: { coordinator: { model: { providerID: string; modelID: string } } },
): Effect.Effect<SpawnToolResult, Error> {
  const input = normalizeSwarmId(rawInput as unknown as Record<string, unknown>) as SpawnInput
  return Effect.gen(function* () {
    let swarm
    try {
      swarm = yield* resolveSwarmTarget(store, input.swarmId, {
        coordinator: ctx.coordinator,
        createIfMissing: false,
        autoRevive: true,
      })
    } catch (e) {
      if (e instanceof SwarmNotFoundError) {
        return yield* Effect.fail(
          new Error(
            `swarm '${input.swarmId}' does not exist yet. Create it first with swarm_delegate (which creates + spawns in one call), then add members with swarm_spawn.`,
          ),
        )
      }
      return yield* Effect.fail(e as Error)
    }
    const result = yield* spawnMembersAtomic(store, swarm, input.members ?? [], undefined, {
      replace: input.replace,
    })
    const notes: string[] = []
    if (result.recovered.length)
      notes.push(`auto-recovered interrupted members: ${result.recovered.join(", ")}`)
    if (result.evicted.length) notes.push(`auto-evicted dead members to free slots: ${result.evicted.join(", ")}`)
    if (result.skipped.length) notes.push(`skipped (already present): ${result.skipped.join(", ")}`)
    return {
      title: `spawned ${result.spawned.length} member(s)`,
      output:
        `Swarm '${input.swarmId}' (${swarm.id}) is active.\n` +
        `Spawned ${result.spawned.length} member(s): ${result.spawned.join(", ") || "(none new)"}.\n` +
        (notes.length ? notes.join("\n") + "\n" : "") +
        `Members pick up ready tasks from the scheduler automatically.`,
    }
  })
}
