import { Effect, Schema } from "effect"
import { Plugin } from "@/plugin"
import { ToolJsonSchema } from "./json-schema"
import { normalizeBrokerArgs, withContractedBrokerArgsSchema } from "./broker-args"
import { BrokerContract } from "./broker-contract"
import * as Tool from "./tool"

export const TOOL_ACCESS_ID = "tool"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "describe", "call"]).annotate({
    description:
      "list lazy capabilities, describe one capability's full instructions/schema/contract, or call it. Every call requires the current contract returned by describe unless that exact descriptor was harness-preseeded for an explicit @tool mention.",
  }),
  tool: Schema.optional(Schema.String).annotate({
    description: "Lazy tool id returned by list. Required for describe and call.",
  }),
  contract: BrokerContract.Parameter,
  args: Schema.optional(Schema.Unknown).annotate({
    description:
      "Arguments forwarded to the selected lazy tool for call. Pass a JSON object matching the described schema. A current descriptor contract is required before every call.",
  }),
})

const ProviderParameters = withContractedBrokerArgsSchema(ToolJsonSchema.fromSchema(Parameters))

type Metadata = {
  brokerAction: "list" | "describe" | "call"
  tool?: string
  delegatedTool?: string
  [key: string]: unknown
}

function requireTool(catalog: ReadonlyMap<string, Tool.Def>, id: string | undefined) {
  if (!id) throw new Error("tool is required for describe and call")
  const target = catalog.get(id)
  if (target) return target
  const available = [...catalog.keys()].sort().join(", ") || "none"
  throw new Error(`Unknown lazy tool: ${id}. Available lazy tools: ${available}`)
}

function summary(tool: Tool.Def) {
  const first = tool.description.split(/\r?\n/, 1)[0]?.trim() ?? ""
  return first.length > 220 ? `${first.slice(0, 217)}...` : first
}

/**
 * Build the one provider-visible broker for internally registered lazy tools.
 * Its own schema is intentionally fixed and tiny. Describing or invoking a
 * lazy capability happens through ordinary tool result content, never by
 * mutating the provider's tool manifest between model steps.
 */
export function createToolAccessTool(
  lazyTools: readonly Tool.Def[],
  plugin: Plugin.Interface,
): Tool.Def<typeof Parameters, Metadata> {
  const catalog = new Map(lazyTools.map((tool) => [tool.id, tool] as const))
  const decode = Schema.decodeUnknownEffect(Parameters)

  return {
    id: TOOL_ACCESS_ID,
    description:
      "Access optional heavy tools without expanding the default tool schema. This is a strict two-phase broker: before action=call, the exact delegated instructions/schema MUST already be loaded via action=describe, and the returned contract MUST be echoed on the call. Use list only when the lazy tool id itself is unknown. If the user explicitly references @<tool-id>, treat it as the exact registered id; the harness may pre-seed that tool's full descriptor plus contract into the turn context, which satisfies the describe phase without an extra tool call.",
    parameters: Parameters,
    jsonSchema: ProviderParameters,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        const params = yield* decode(input).pipe(
          Effect.mapError(
            (error) =>
              new Tool.InvalidArgumentsError({
                tool: TOOL_ACCESS_ID,
                detail: String(error),
              }),
          ),
        )

        if (params.action === "list") {
          const items = [...catalog.values()]
            .toSorted((a, b) => a.id.localeCompare(b.id))
            .map((tool) => `- ${tool.id}: ${summary(tool)}`)
          return {
            title: "Lazy tools",
            output:
              items.length > 0
                ? `Available lazy tools:\n${items.join("\n")}\n\nBefore calling a listed tool, use action=describe for its exact instructions, input schema, and current contract.`
                : "No lazy tools are registered.",
            metadata: { brokerAction: "list" as const },
          }
        }

        const target = requireTool(catalog, params.tool)
        if (params.action === "describe") {
          const parameters = ToolJsonSchema.fromTool(target)
          const descriptor = BrokerContract.describe({
            broker: TOOL_ACCESS_ID,
            target: target.id,
            targetField: "tool",
            description: target.description,
            schema: parameters,
          })
          return {
            title: `Describe ${target.id}`,
            output: JSON.stringify(
              {
                ...descriptor,
                tool: target.id,
                parameters,
                usage: `Call ${TOOL_ACCESS_ID} with action="call", tool="${target.id}", contract set to the exact value above, and args set to a JSON object satisfying inputSchema/parameters.`,
              },
              null,
              2,
            ),
            metadata: { brokerAction: "describe" as const, tool: target.id },
          }
        }

        const parameters = ToolJsonSchema.fromTool(target)
        BrokerContract.assertCurrent({
          broker: TOOL_ACCESS_ID,
          target: target.id,
          description: target.description,
          schema: parameters,
          contract: params.contract,
          discovery: `Call ${TOOL_ACCESS_ID} with action="describe" and tool="${target.id}"`,
        })
        const args = normalizeBrokerArgs(params.args, { broker: "tool" })
        yield* plugin.trigger(
          "tool.execute.before",
          { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID },
          { args },
        )
        const result = yield* target.execute(args, ctx)
        const output = {
          ...result,
          metadata: {
            ...result.metadata,
            brokerAction: "call" as const,
            delegatedTool: target.id,
          },
        }
        yield* plugin.trigger(
          "tool.execute.after",
          { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
          output,
        )
        return output
      }).pipe(
        Effect.orDie,
        Effect.withSpan("Tool.execute", {
          attributes: {
            "tool.name": TOOL_ACCESS_ID,
            "session.id": ctx.sessionID,
            "message.id": ctx.messageID,
            ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
          },
        }),
      ),
  }
}

export function isLazyTool(tool: Tool.Def) {
  return tool.exposure === "lazy"
}
