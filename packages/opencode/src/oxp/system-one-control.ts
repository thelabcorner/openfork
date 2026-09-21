import { Context, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Node } from "@opencode-ai/core/effect/app-node"
import { SystemOne as Contract } from "@opencode-ai/schema/system-one"
import type { OxpRuntimeV1 } from "./runtime-v1"

export type Target = OxpRuntimeV1.Target

export interface Interface {
  readonly infer: (
    target: Target,
    input: Contract.InferInput,
  ) => Effect.Effect<Contract.InferResult, Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpSystemOneControl",
) {}

/**
 * Tier-3 semantic-provider execution port. OXP owns authority/result projection;
 * production binds this port to the V1 SystemOne service without exposing V1
 * runtime details or provider credentials to the capability surface.
 */
export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as OxpSystemOneControl from "./system-one-control"
