import { Context, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Node } from "@opencode-ai/core/effect/app-node"
import type { OxpRuntimeV1 } from "./runtime-v1"

export type Target = OxpRuntimeV1.Target

export interface Tool {
  readonly server: string
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
  /** Untrusted MCP server annotation; never use as mutation/retry authority. */
  readonly readOnlyHint: boolean
}

export interface CallResult {
  readonly content: readonly unknown[]
  readonly structuredContent?: unknown
}

export class ToolNotFound extends Error {
  override readonly name = "OxpMcpToolNotFound"
  constructor(
    readonly server: string,
    readonly tool: string,
  ) {
    super(`MCP tool ${server}/${tool} is no longer available`)
  }
}

export interface Interface {
  readonly list: (target: Target) => Effect.Effect<readonly Tool[], Error>
  readonly call: (
    target: Target,
    input: {
      readonly server: string
      readonly tool: string
      readonly args: unknown
      readonly signal?: AbortSignal
    },
  ) => Effect.Effect<CallResult, ToolNotFound | Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/OxpMcpControl",
) {}

/**
 * Tier-3 location-scoped port. The OXP capability broker depends only on this
 * shape; the production host binds it to the existing native MCP.Service.
 */
export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as OxpMcpControl from "./mcp-control"
