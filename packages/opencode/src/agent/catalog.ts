import { Effect } from "effect"
import { Agent } from "./agent"

export type Option = {
  readonly id: string
  readonly description?: string
  readonly mode: "subagent" | "primary" | "all"
}

export type Snapshot = {
  readonly agents: readonly Option[]
  readonly defaultAgentID: string
}

export const loadWith = Effect.fn("AgentCatalog.loadWith")(function* (
  agents: Agent.Interface,
) {
  const [available, defaultAgent] = yield* Effect.all(
    [agents.list(), agents.defaultInfo()],
    { concurrency: "unbounded" },
  )
  return {
    agents: available
      .filter((agent) => agent.hidden !== true)
      .map((agent) => ({
        id: agent.name,
        mode: agent.mode,
        ...(agent.description ? { description: agent.description } : {}),
      })),
    defaultAgentID: defaultAgent.name,
  } satisfies Snapshot
})

/**
 * Workspace-context projection of the native agent catalog. The caller owns
 * location/runtime entry; this lower owner only defines agent catalog semantics.
 */
export const load = Effect.fn("AgentCatalog.load")(function* () {
  const agents = yield* Agent.Service
  return yield* loadWith(agents)
})

export * as AgentCatalog from "./catalog"
