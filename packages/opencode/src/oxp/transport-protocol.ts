/**
 * Protocol-only MCP transport plane.
 *
 * This module intentionally imports no runtime, capability, root, permission,
 * Session, or worker services. It owns MCP-era negotiation, stateless tool
 * listing, output validation and after-HTTP-response handoff only.
 * The injected executable callback remains the independently authorized OXP
 * owner and MUST revalidate permissions on every call.
 */
import { createMcpHandler, fromJsonSchema, Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server"
import { OXP_STATIC_TRANSPORT } from "./transport-manifest"

type Phase = "tool_boundary" | "result_validation" | "result_projection"
type AfterResponse = () => void | Promise<void>

export interface ExecutedCall {
  readonly result: CallToolResult
  readonly afterResponse?: AfterResponse
}
export interface ProtocolOptions {
  /** Should reject stale/mismatched cursors, never rely on caller-provided name alone. */
  readonly paginate: (tools: readonly Tool[], cursor?: string) => { tools: Tool[]; nextCursor?: string }
  /** Register the immutable legacy projection for bounded pagination. */
  readonly registerLegacy: (tools: readonly Tool[]) => readonly Tool[]
  readonly execute: (name: string, args: unknown, meta: Readonly<Record<string, unknown>> | undefined, signal: AbortSignal) => Promise<ExecutedCall>
  readonly internalError: (cause: unknown, phase: Phase, name?: string, action?: string) => CallToolResult
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

export function createOxpTransportProtocol(options: ProtocolOptions) {
  const afterResponses = new WeakMap<Request, AfterResponse>()
  let legacyTools: readonly Tool[] | undefined
  let modernOutputValidator: ReturnType<typeof fromJsonSchema> | undefined
  let legacyOutputValidator: ReturnType<typeof fromJsonSchema> | undefined

  const handler = createMcpHandler(
    (requestContext) => {
      const legacy = requestContext.era === "legacy"
      const outputSchema = legacy
        ? OXP_STATIC_TRANSPORT.legacyOutputSchema
        : OXP_STATIC_TRANSPORT.outputSchema
      const tools = legacy
        ? (legacyTools ??= options.registerLegacy(Object.freeze(
            OXP_STATIC_TRANSPORT.tools.map((tool) => Object.freeze({ ...tool, outputSchema })),
          )))
        : OXP_STATIC_TRANSPORT.tools
      const mcp = new Server(
        { name: "OpenFork OXP", version: `0.1.0+schema.${OXP_STATIC_TRANSPORT.fingerprint.slice(0, 12)}` },
        { capabilities: { tools: {} }, instructions: OXP_STATIC_TRANSPORT.instructions },
      )
      const outputValidator = legacy
        ? (legacyOutputValidator ??= fromJsonSchema(outputSchema))
        : (modernOutputValidator ??= fromJsonSchema(outputSchema))
      mcp.setRequestHandler("tools/list", async (request) => options.paginate(tools, request.params?.cursor))
      mcp.setRequestHandler("tools/call", async (request, ctx) => {
        const params = record(request.params) ?? {}
        const name = typeof params.name === "string" ? params.name : undefined
        const args = params.arguments ?? {}
        const action = record(args)?.action
        let phase: Phase = "tool_boundary"
        try {
          if (!name) throw new Error("Missing MCP tool name")
          const executed = await options.execute(name, args, record(params._meta), ctx.mcpReq.signal)
          const result = executed.result
          if (executed.afterResponse && requestContext.requestInfo) {
            afterResponses.set(requestContext.requestInfo, executed.afterResponse)
          }
          if (result.structuredContent !== undefined) {
            phase = "result_validation"
            const validation = await outputValidator["~standard"].validate(result.structuredContent)
            if (validation.issues?.length) {
              return options.internalError(
                new Error("Structured result violated the active output schema"),
                phase,
                name,
                typeof action === "string" ? action : undefined,
              )
            }
          }
          phase = "result_projection"
          return mcp.projectCallToolResult(result, outputSchema)
        } catch (cause) {
          return options.internalError(cause, phase, name, typeof action === "string" ? action : undefined)
        }
      })
      return mcp
    },
    { legacy: "stateless" },
  )

  return {
    handler,
    takeAfterResponse(request: Request) {
      const after = afterResponses.get(request)
      afterResponses.delete(request)
      return after
    },
  }
}
