import { Context, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Node } from "@opencode-ai/core/effect/app-node"
import type { OxpRuntimeV1 } from "./runtime-v1"

export type Target = OxpRuntimeV1.Target

export type Model = {
  readonly providerID: string
  readonly providerName: string
  readonly modelID: string
  readonly name: string
  readonly family?: string
  readonly status: string
  readonly variants: readonly string[]
}

export type Snapshot = {
  readonly models: readonly Model[]
}

export interface Interface {
  readonly list: (target: Target) => Effect.Effect<Snapshot, Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpModelCatalog",
) {}

/** Tier-2 workspace model-catalog port. Production binds the lazy V1 adapter. */
export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as OxpModelCatalog from "./model-catalog"