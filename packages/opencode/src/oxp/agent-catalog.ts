import { Context, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Node } from "@opencode-ai/core/effect/app-node"
import type { OxpRuntimeV1 } from "./runtime-v1"

export type Target = OxpRuntimeV1.Target

export type Agent = {
  readonly id: string
  readonly description?: string
  readonly mode: "subagent" | "primary" | "all"
}

export type Snapshot = {
  readonly agents: readonly Agent[]
  readonly nativeDefaultAgent: string
}

export interface Interface {
  readonly list: (target: Target) => Effect.Effect<Snapshot, Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpAgentCatalog",
) {}

/** Tier-2 workspace catalog port. Production binds the lazy V1 adapter. */
export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as OxpAgentCatalog from "./agent-catalog"
