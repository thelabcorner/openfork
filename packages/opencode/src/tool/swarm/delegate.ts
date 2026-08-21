import { Effect } from "effect"
import {
  resolveSwarmTarget,
  spawnMembersAtomic,
  type SwarmStore,
  type MemberInput,
} from "./self-heal"

export interface DelegateInput {
  name: string
  members: MemberInput[]
  tasks: unknown[]
  policies?: unknown
}

export interface DelegateResult {
  title: string
  output: string
}

export function delegate(
  store: SwarmStore,
  input: DelegateInput,
  ctx: { coordinator: { model: { providerID: string; modelID: string } } },
): Effect.Effect<DelegateResult, Error> {
  return Effect.gen(function* () {
    const swarm = yield* resolveSwarmTarget(store, input.name, {
      coordinator: ctx.coordinator,
      createIfMissing: true,
      autoRevive: true,
    })
    const memberCount = Array.isArray(input.members) ? input.members.length : 0
    const taskCount = Array.isArray(input.tasks) ? input.tasks.length : 0
    const result = memberCount
      ? yield* spawnMembersAtomic(store, swarm, input.members ?? [])
      : { spawned: [], skipped: [], evicted: [], recovered: [] }
    const notes: string[] = []
    if (result.recovered.length) notes.push(`auto-recovered: ${result.recovered.join(", ")}`)
    if (result.evicted.length) notes.push(`auto-evicted dead to free slots: ${result.evicted.join(", ")}`)
    if (result.skipped.length) notes.push(`skipped existing: ${result.skipped.join(", ")}`)
    yield* Effect.logInfo(
      `swarm '${input.name}' active (${swarm.status}); ${result.spawned.length} spawned, ${taskCount} tasks`,
    )
    return {
      title: `swarm ${input.name} ready`,
      output:
        `Swarm '${input.name}' (${swarm.id}) is active.\n` +
        `Members: ${result.spawned.length} spawned (${result.spawned.join(", ") || "none new"}).\n` +
        `Tasks: ${taskCount} seeded.\n` +
        (notes.length ? notes.join("\n") + "\n" : "") +
        `The scheduler assigns ready tasks to idle members automatically; you will be notified as they complete.`,
    }
  })
}
