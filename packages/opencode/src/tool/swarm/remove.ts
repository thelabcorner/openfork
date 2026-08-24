import { Effect } from "effect"
import {
  resolveSwarmTarget,
  batchRemove,
  normalizeSwarmId,
  type SwarmStore,
} from "./self-heal"

export interface RemoveInput {
  swarmId: string
  member: string | string[]
}

export interface RemoveToolResult {
  title: string
  output: string
}

export function remove(
  store: SwarmStore,
  rawInput: RemoveInput,
  ctx: { coordinator: { model: { providerID: string; modelID: string } } },
): Effect.Effect<RemoveToolResult, Error> {
  const input = normalizeSwarmId(rawInput as unknown as Record<string, unknown>) as unknown as RemoveInput
  return Effect.gen(function* () {
    const swarm = yield* resolveSwarmTarget(store, input.swarmId, {
      coordinator: ctx.coordinator,
      createIfMissing: false,
      autoRevive: false,
    })
    const names = Array.isArray(input.member) ? input.member : [input.member]
    const result = yield* batchRemove(store, swarm, names)
    const notes: string[] = []
    if (result.removed.length) notes.push(`removed: ${result.removed.join(", ")}`)
    if (result.missing.length) notes.push(`not found (skipped): ${result.missing.join(", ")}`)
    return {
      title: `removed ${result.removed.length} member(s)`,
      output:
        `Swarm '${input.swarmId}' (${swarm.id}).\n` +
        (notes.join("\n") || "no members specified") +
        `\nRoster slots freed.`,
    }
  })
}
