import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolInterrupt } from "@/tool/interrupt"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { isLazyTool, TOOL_ACCESS_ID } from "@/tool/access"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { isRecord } from "@/util/record"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { markCanonicalFindToolMap } from "./llm/tool-call-heal"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const MCP_RESOURCE_TOOL_DESCRIPTIONS = {
  [MCP_RESOURCE_TOOLS.list]:
    "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
  [MCP_RESOURCE_TOOLS.listTemplates]:
    "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
  [MCP_RESOURCE_TOOLS.read]:
    "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
} as const
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])
const MAX_EXPLICIT_LAZY_TOOL_MENTIONS = 4
const MAX_EXPLICIT_LAZY_TOOL_CONTEXT_CHARS = 48_000
const TOOL_MENTION_TOKEN = /@([A-Za-z0-9_][A-Za-z0-9_.:-]*)/g

export type CatalogItem = {
  id: string
  description: string
  exposure: "default" | "lazy"
  source: "registry" | "mcp" | "mcp-resource"
}

function compactToolDescription(value: string | undefined) {
  const line = value
    ?.split(/\r?\n/, 1)[0]
    ?.replace(/\s+/g, " ")
    .trim()
  if (!line) return ""
  return line.length > 220 ? `${line.slice(0, 217).trimEnd()}...` : line
}

/**
 * Extract explicit @tool-style tokens in source order. A mention must begin at
 * a token boundary so ordinary email/package text such as user@example.com
 * does not accidentally activate a capability.
 */
export function explicitToolMentions(text: string) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of text.matchAll(TOOL_MENTION_TOKEN)) {
    const index = match.index ?? 0
    const previous = index > 0 ? text[index - 1] : undefined
    if (previous && /[A-Za-z0-9_.-]/.test(previous)) continue
    const id = match[1]
    if (!id || seen.has(id)) continue
    const next = text[index + match[0].length]
    if (next === "/") continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * Pre-seed schemas for explicitly mentioned lazy tools without changing the
 * provider-visible tool manifest. The returned text is intended to be appended
 * as request-only user-role capability metadata next to the triggering turn,
 * preserving the stable tool-prefix cache while removing the broker's usual
 * list/describe discovery round trip.
 */
export const explicitLazyToolContext = Effect.fn("SessionTools.explicitLazyToolContext")(function* (input: {
  agent: Agent.Info
  text: string
  permission?: PermissionV1.Ruleset
}) {
  const mentions = explicitToolMentions(input.text)
  if (mentions.length === 0) return undefined

  const registry = yield* ToolRegistry.Service
  const lazy = new Map((yield* registry.all()).filter(isLazyTool).map((item) => [item.id, item] as const))
  if (lazy.size === 0) return undefined

  const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
  const disabled = Permission.disabled([...lazy.keys(), TOOL_ACCESS_ID], ruleset)
  if (disabled.has(TOOL_ACCESS_ID)) return undefined

  const blocks: string[] = []
  let size = 0
  for (const id of mentions) {
    if (blocks.length >= MAX_EXPLICIT_LAZY_TOOL_MENTIONS) break
    const target = lazy.get(id)
    if (!target || disabled.has(id)) continue

    let parameters: unknown
    try {
      parameters = ToolJsonSchema.fromTool(target)
    } catch (error) {
      yield* Effect.logWarning("explicit lazy tool schema conversion failed", {
        tool: target.id,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    const block = [
      `Tool: @${target.id}`,
      `Description: ${target.description}`,
      `Parameters: ${JSON.stringify(parameters)}`,
      `Invocation: call the provider-visible \`${TOOL_ACCESS_ID}\` tool with {"action":"call","tool":"${target.id}","args":<object matching Parameters>}.`,
    ].join("\n")
    if (size + block.length > MAX_EXPLICIT_LAZY_TOOL_CONTEXT_CHARS) continue
    blocks.push(block)
    size += block.length
  }

  if (blocks.length === 0) return undefined
  return [
    "<explicit-tool-mention-context>",
    "The immediately preceding user request explicitly referenced the lazy tool(s) below. This is harness-generated capability metadata, not an additional user task. The schemas are already supplied here, so do not spend a tool call listing or describing these capabilities before use. Invoke the stable `tool` broker directly when the request calls for them.",
    blocks.join("\n\n"),
    "</explicit-tool-mention-context>",
  ].join("\n")
})

/**
 * Resolve the lightweight, user-discoverable catalog for an agent/model without
 * materializing JSON schemas. This mirrors the tool sources used by `resolve`:
 * registry tools, MCP resource helpers, connected MCP tools, plus brokered lazy
 * registry tools. Canonical IDs are retained so composer mentions never depend
 * on a display label or a guessed alias.
 */
export const catalog = Effect.fn("SessionTools.catalog")(function* (input: {
  agent: Agent.Info
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  permission?: PermissionV1.Ruleset
}) {
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const flags = yield* RuntimeFlags.Service
  const items = new Map<string, CatalogItem>()

  const direct = yield* registry.tools({
    providerID: input.providerID,
    modelID: input.modelID,
    agent: input.agent,
  })
  for (const item of direct) {
    if (item.id === "invalid") continue
    items.set(item.id, {
      id: item.id,
      description: compactToolDescription(item.description),
      exposure: "default",
      source: "registry",
    })
  }

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    for (const id of Object.values(MCP_RESOURCE_TOOLS)) {
      items.set(id, {
        id,
        description: compactToolDescription(MCP_RESOURCE_TOOL_DESCRIPTIONS[id]),
        exposure: "default",
        source: "mcp-resource",
      })
    }
  }

  // SessionTools.resolve intentionally omits ordinary MCP tools in code mode.
  if (!flags.experimentalCodeMode) {
    for (const [id, entry] of Object.entries(yield* mcp.tools())) {
      items.set(id, {
        id,
        description: compactToolDescription(entry.def.description),
        exposure: "default",
        source: "mcp",
      })
    }
  }

  // Lazy tools are deliberately absent from registry.tools() because their
  // schemas are brokered through the stable `tool` capability. They still
  // belong in discovery so an explicit @sqlite/@refactor mention can identify
  // the exact capability without globally expanding the provider manifest.
  for (const item of (yield* registry.all()).filter(isLazyTool)) {
    if (item.id === "invalid" || items.has(item.id)) continue
    items.set(item.id, {
      id: item.id,
      description: compactToolDescription(item.description),
      exposure: "lazy",
      source: "registry",
    })
  }

  const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
  const disabled = Permission.disabled([...items.keys()], ruleset)
  const lazyBrokerAvailable = items.has(TOOL_ACCESS_ID) && !disabled.has(TOOL_ACCESS_ID)
  return [...items.values()]
    .filter((item) => !disabled.has(item.id) && (item.exposure !== "lazy" || lazyBrokerAvailable))
    .sort((a, b) => a.id.localeCompare(b.id))
})

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const flags = yield* RuntimeFlags.Service
  const interrupt = yield* ToolInterrupt.Service
  const canonicalFind = (yield* registry.all()).find((item) => item.id === "find")
  let canonicalFindTool: AITool | undefined

  // Throttle for per-chunk tool progress metadata below. Chatty tools (shell
  // spewing build/test output calls ctx.metadata once per stdout chunk) each
  // cost a DB read + conditional DB write + event publish + full SSE fan-out
  // per call. With several concurrent sessions that is thousands of durable
  // publishes per second on the shared sqlite connection and the event pipe.
  // Progress previews are cosmetic — tool completion always publishes the
  // final state via completeToolCall — so lossy coalescing here is safe:
  // first update per call goes through immediately, the rest at most every
  // METADATA_THROTTLE_MS.
  const METADATA_THROTTLE_MS = 500
  const lastMetadataAt = new Map<string, number>()

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions, killable?: AbortSignal): Tool.Context => ({
    sessionID: input.session.id,
    abort: killable ?? options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) => {
      // Lossy throttle: drop progress updates inside the window. Calls without
      // a toolCallId bypass the throttle (no key to coalesce on).
      const key = options.toolCallId
      if (key !== undefined) {
        const now = Date.now()
        if (now - (lastMetadataAt.get(key) ?? 0) < METADATA_THROTTLE_MS) return Effect.void
        lastMetadataAt.set(key, now)
        if (lastMetadataAt.size > 2000) {
          for (const [entry, at] of lastMetadataAt) {
            if (now - at > METADATA_THROTTLE_MS * 2) lastMetadataAt.delete(entry)
          }
        }
      }
      return input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: match.state.status === "running" ? match.state.time : { start: Date.now() },
          },
        }
      })
    },
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    const wrapped = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const killable =
              options.toolCallId && options.abortSignal
                ? yield* interrupt.track({
                    sessionID: input.session.id,
                    callID: options.toolCallId,
                    parent: options.abortSignal,
                  })
                : undefined
            const ctx = context(toRecord(args), options, killable)
            try {
              yield* plugin.trigger(
                "tool.execute.before",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                { args },
              )
              const result = yield* item.execute(args, ctx)
              const output = {
                ...result,
                attachments: result.attachments?.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
              }
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                output,
              )
              if (options.abortSignal?.aborted) {
                yield* input.processor.completeToolCall(options.toolCallId, output)
              }
              return output
            } finally {
              if (killable && options.toolCallId)
                yield* interrupt.release({ sessionID: input.session.id, callID: options.toolCallId })
            }
          }),
        )
      },
    })
    tools[item.id] = wrapped
    if (item.id === "find") {
      canonicalFindTool = item.execute === canonicalFind?.execute ? wrapped : undefined
    }
  }

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    tools[MCP_RESOURCE_TOOLS.list] = tool({
      description: MCP_RESOURCE_TOOL_DESCRIPTIONS[MCP_RESOURCE_TOOLS.list],
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Optional MCP server name. When omitted, lists resources from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(parsed.server))
            const filtered = resources
              .filter((resource) => !parsed.server || resource.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.listTemplates] = tool({
      description: MCP_RESOURCE_TOOL_DESCRIPTIONS[MCP_RESOURCE_TOOLS.listTemplates],
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "Optional MCP server name. When omitted, lists resource templates from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const templates = Object.values(yield* mcp.resourceTemplates(parsed.server))
            const filtered = templates
              .filter((template) => !parsed.server || template.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
                ),
              )
            const content = JSON.stringify({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.read] = tool({
      description: MCP_RESOURCE_TOOL_DESCRIPTIONS[MCP_RESOURCE_TOOLS.read],
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "MCP server name exactly as returned by list_mcp_resources.",
            },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseReadMcpResourceArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  const finalize = () => {
    if (canonicalFindTool && tools.find === canonicalFindTool) markCanonicalFindToolMap(tools)
    return tools
  }

  if (flags.experimentalCodeMode) return finalize()

  for (const [key, entry] of Object.entries(yield* mcp.tools())) {
    const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout)
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                const mime = resource.mimeType ?? "application/octet-stream"
                const size = base64Size(resource.blob)
                if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
                  )
                  continue
                }
                if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                  )
                  continue
                }
                attachments.push({
                  type: "file",
                  mime,
                  url: `data:${mime};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return finalize()
})

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"
