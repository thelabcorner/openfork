import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"

import * as McpResourceTools from "@/mcp/resource-capabilities"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolInterrupt } from "@/tool/interrupt"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { isLazyTool, TOOL_ACCESS_ID } from "@/tool/access"
import { BrokerContract } from "@/tool/broker-contract"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { SessionPromptOps } from "./prompt-contract"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { Cause, Effect, Exit } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { type MessageID, PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { isRecord } from "@/util/record"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { markCanonicalFindToolMap } from "./llm/tool-call-heal"
import { Snapshot } from "@/snapshot"
import * as CapabilityInvocationGateway from "@/session/capability-invocation-gateway"
import { createToolMetadataThrottle } from "./tool-metadata-throttle"

const MCP_RESOURCE_TOOLS = McpResourceTools.IDs
const MCP_RESOURCE_TOOL_DESCRIPTIONS = McpResourceTools.DESCRIPTIONS
const MAX_EXPLICIT_TOOL_MENTIONS = 8
const MAX_EXPLICIT_LAZY_TOOL_MENTIONS = 4
const MAX_EXPLICIT_TOOL_CONTEXT_CHARS = 48_000
const TOOL_MENTION_TOKEN = /@([A-Za-z0-9_][A-Za-z0-9_.:-]*)/g

export type CatalogItem = {
  id: string
  description: string
  exposure: "default" | "lazy"
  source: "registry" | "mcp" | "mcp-resource"
}

export type StructuredMentionSpan = {
  readonly start: number
  readonly end: number
  readonly value: string
}

function finalFunctionParametersSchema(schema: ReturnType<typeof ProviderTransform.schema>) {
  const objectRoot =
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object"))
  if (!objectRoot || schema.properties !== undefined) return schema
  return { ...schema, properties: {} }
}

function abortSignalEffect(signal: AbortSignal): Effect.Effect<never> {
  return Effect.callback<never>((resume) => {
    if (signal.aborted) {
      resume(Effect.die(new DOMException("Tool execution aborted", "AbortError")))
      return
    }
    const onAbort = () => resume(Effect.die(new DOMException("Tool execution aborted", "AbortError")))
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
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
export function explicitToolMentions(
  text: string,
  options?: { readonly known?: ReadonlySet<string>; readonly exclude?: readonly StructuredMentionSpan[] },
) {
  const seen = new Set<string>()
  const result: string[] = []
  // Structured file/agent pills use a different capability namespace. Match
  // both their source span and original token, rather than globally suppressing
  // an identically named tool mentioned elsewhere in the same prompt.
  const excluded = new Map<number, StructuredMentionSpan[]>()
  for (const span of options?.exclude ?? []) {
    if (span.start < 0 || span.end > text.length || span.end <= span.start) continue
    if (text.slice(span.start, span.end) !== span.value) continue
    const list = excluded.get(span.start) ?? []
    list.push(span)
    excluded.set(span.start, list)
  }
  for (const match of text.matchAll(TOOL_MENTION_TOKEN)) {
    const index = match.index ?? 0
    const previous = index > 0 ? text[index - 1] : undefined
    if (previous && /[A-Za-z0-9_.-]/.test(previous)) continue
    const raw = match[1] ?? ""
    // '@sqlite.' ends a sentence; '@vendor.tool' is a legitimate exact ID.
    // Prefer a registered exact ID before stripping terminal punctuation.
    const id = options?.known?.has(raw) ? raw : raw.replace(/[.:]+$/, "")
    if (!id || seen.has(id)) continue
    const next = text[index + match[0].length]
    if (next === "/") continue
    const end = index + id.length + 1
    if (excluded.get(index)?.some((span) => span.end === end)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/**
 * Resolve explicit @tool mentions against the actual provider-visible manifest
 * and the lazy registry. Direct tools need only a compact routing hint: their
 * exact schemas are already supplied to the provider. Lazy tools get their
 * contracted schema so the model can skip redundant broker discovery without
 * changing the cache-sensitive manifest. Neither path grants execution rights.
 */
export const explicitToolMentionContext = Effect.fn("SessionTools.explicitToolMentionContext")(function* (input: {
  agent: Agent.Info
  text: string
  permission?: PermissionV1.Ruleset
  providerTools?: Readonly<Record<string, { description?: string }>>
  excludedMentions?: readonly StructuredMentionSpan[]
}) {
  // Avoid inventory hydration on ordinary provider steps without tool mentions.
  if (!input.text.includes("@")) return undefined
  if (explicitToolMentions(input.text, { exclude: input.excludedMentions }).length === 0) return undefined
  const registry = yield* ToolRegistry.Service
  const lazy = new Map((yield* registry.all()).filter(isLazyTool).map((item) => [item.id, item] as const))
  const direct = input.providerTools ?? {}
  if (lazy.size === 0 && Object.keys(direct).length === 0) return undefined
  const mentions = explicitToolMentions(input.text, {
    known: new Set([...lazy.keys(), ...Object.keys(direct)]),
    exclude: input.excludedMentions,
  })
  if (mentions.length === 0) return undefined

  const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
  const disabled = Permission.disabled([...lazy.keys(), ...Object.keys(direct), TOOL_ACCESS_ID], ruleset)

  const blocks: string[] = []
  let size = 0
  let lazyCount = 0
  for (const id of mentions) {
    if (blocks.length >= MAX_EXPLICIT_TOOL_MENTIONS) break
    if (disabled.has(id)) continue

    // Exact ids from SessionTools.resolve are the authority for which tools
    // the selected model can call directly. Never infer an alias from text.
    // Provider tool maps are ordinary JS records. Never treat inherited keys
    // such as constructor/toString/__proto__ as registered capabilities.
    const exposed = Object.hasOwn(direct, id) ? direct[id] : undefined
    if (exposed && id !== "StructuredOutput") {
      const block = [
        `Tool: @${id}`,
        `Description: ${compactToolDescription(exposed.description) || "Provider-visible tool"}`,
        `Invocation: call the provider-visible \`${id}\` tool directly using its existing schema. Do not delegate to a subagent or route it through the lazy \`${TOOL_ACCESS_ID}\` broker.`,
      ].join("\n")
      if (size + block.length > MAX_EXPLICIT_TOOL_CONTEXT_CHARS) continue
      blocks.push(block)
      size += block.length
      continue
    }

    if (disabled.has(TOOL_ACCESS_ID) || lazyCount >= MAX_EXPLICIT_LAZY_TOOL_MENTIONS) continue
    const target = lazy.get(id)
    if (!target) continue

    const fallback = [
      `Tool: @${target.id}`,
      `Description: ${compactToolDescription(target.description) || "Registered lazy tool"}`,
      `Invocation: call the provider-visible \`${TOOL_ACCESS_ID}\` tool with {"action":"describe","tool":"${target.id}"}; then call it with the returned exact contract and args. The descriptor was not pre-seeded.`,
    ].join("\n")
    let block = fallback
    try {
      const parameters = ToolJsonSchema.fromTool(target)
      const descriptor = BrokerContract.describe({
        broker: TOOL_ACCESS_ID,
        target: target.id,
        targetField: "tool",
        description: target.description,
        schema: parameters,
      })
      const expanded = [
        `Tool: @${target.id}`,
        `Description: ${target.description}`,
        `Parameters: ${JSON.stringify(parameters)}`,
        `Descriptor protocol: ${descriptor.protocol}`,
        `Contract: ${descriptor.contract}`,
        `Invocation: call the provider-visible \`${TOOL_ACCESS_ID}\` tool with {"action":"call","tool":"${target.id}","contract":"${descriptor.contract}","args":<object matching Parameters>}.`,
      ].join("\n")
      if (size + expanded.length <= MAX_EXPLICIT_TOOL_CONTEXT_CHARS) block = expanded
    } catch (error) {
      yield* Effect.logWarning("explicit lazy tool schema conversion failed", {
        tool: target.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (size + block.length > MAX_EXPLICIT_TOOL_CONTEXT_CHARS) continue
    blocks.push(block)
    size += block.length
    lazyCount++
  }

  if (blocks.length === 0) return undefined
  return [
    "<explicit-tool-mention-context>",
    "The preceding user request explicitly referenced registered tools. This is request-only harness capability metadata, not an additional user task, an instruction to execute every mentioned tool, or an authorization grant. Direct tools already have their schema in the provider manifest. Lazy tools with supplied contracts satisfy broker discovery; where the descriptor was not pre-seeded, describe it normally. Follow the user's actual intent and execution permissions.",
    blocks.join("\n\n"),
    "</explicit-tool-mention-context>",
  ].join("\n")
})

// Keep the legacy lazy-only symbol for callers/tests outside the production
// Session entry point while the unified mention resolver is adopted.
export const explicitLazyToolContext = explicitToolMentionContext

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

  // Ordinary MCP tools are intentionally omitted from the provider-facing
  // catalog. They remain exact capabilities discoverable/callable through Code.

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
  processor: Pick<
    SessionProcessor.Handle,
    "message" | "updateToolCall" | "completeToolCall" | "failToolCall" | "startToolCall" | "toolPartID" | "markWorkspaceMutation"
  >
  authorizedAgentNames: ReadonlySet<string>
  workerRootMessageID?: MessageID
  messages: SessionV1.WithParts[]
  promptOps: SessionPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service

  const interrupt = yield* ToolInterrupt.Service
  const snapshot = yield* Snapshot.Service
  const capabilitySnapshots = new Map<string, CapabilityInvocationGateway.CapabilitySnapshot>()
  const canonicalFind = (yield* registry.all()).find((item) => item.id === "find")
  let canonicalFindTool: AITool | undefined

  // Per-chunk output previews are cosmetic; admission/execution lifecycle
  // transitions are NOT. A silent shell can emit queueStartedAt and startedAt
  // only milliseconds apart, then produce no output for several minutes.
  // Always persist the transition while limiting ordinary progress to one
  // update per 500 ms to protect SQLite and the event/SSE pipeline.
  const acceptMetadata = createToolMetadataThrottle(500)

  const capabilitySnapshotFor = (options: ToolExecutionOptions) =>
    Effect.gen(function* () {
      const key = options.toolCallId ?? "__anonymous__"
      const cached = capabilitySnapshots.get(key)
      if (cached) return cached
      const snapshot = CapabilityInvocationGateway.fromInventory(
        yield* registry.capabilities({
          modelID: ModelV2.ID.make(input.model.api.id),
          providerID: input.model.providerID,
          agent: input.agent,
          permission: input.session.permission,
          sessionID: input.session.id,
        }),
      )
      capabilitySnapshots.set(key, snapshot)
      return snapshot
    })

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions, killable?: AbortSignal): Tool.Context => ({
    sessionID: input.session.id,
    abort: killable ?? options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    partID: options.toolCallId ? input.processor.toolPartID?.(options.toolCallId) : undefined,
    permissionRuleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
    markWorkspaceMutation: input.processor.markWorkspaceMutation,
    captureCapabilities: () =>
      capabilitySnapshotFor(options).pipe(
        Effect.map((snapshot) => ({ generation: snapshot.generation, entries: snapshot.entries })),
      ),
    extra: {
      model: input.model,
      authorizedAgentNames: input.authorizedAgentNames,
      promptOps: input.promptOps,
      workerRootMessageID: input.workerRootMessageID,
    },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) => {
      if (!acceptMetadata(options.toolCallId, val.metadata)) return Effect.void
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
    semanticAsk: (req) => {
      const wait = permission.ask({
        ...req,
        sessionID: input.session.id,
        tool: { messageID: input.processor.message.id, callID: options.toolCallId },
        ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
      })
      const abort = killable ?? options.abortSignal
      return abort ? Effect.raceFirst(wait, abortSignalEffect(abort)) : wait
    },
    ask: (req) => {
      const wait = permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie)
      const abort = killable ?? options.abortSignal
      // Tool execution crosses a Promise boundary below. A per-call kill aborts
      // the child signal while a Session/turn cancellation aborts the parent.
      // Race the permission wait against either signal so Deferred.await is
      // interrupted and its ensuring cleanup releases the pending request.
      return abort ? Effect.raceFirst(wait, abortSignalEffect(abort)) : wait
    },
    invokeCapability: (ref, nestedArgs) =>
      Effect.gen(function* () {
        const root = context(args, options, killable)
        const capabilitySnapshot = yield* capabilitySnapshotFor(options)
        const gateway = yield* CapabilityInvocationGateway.open({
          snapshot: capabilitySnapshot,
          context: root,
          caller: "broker",
        }).pipe(
          Effect.provideService(Plugin.Service, plugin),
          Effect.provideService(Permission.Service, permission),
          Effect.provideService(Snapshot.Service, snapshot),
          Effect.provideService(ToolInterrupt.Service, interrupt),
        )
        return yield* gateway.invoke({ ref, args: nestedArgs })
      }),
  })

  type ToolOutput = Parameters<SessionProcessor.Handle["completeToolCall"]>[1]
  const executeTracked = <A extends ToolOutput>(
    name: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    invoke: (ctx: Tool.Context) => Effect.Effect<A, unknown>,
  ) => {
    // The AI SDK always supplies a tool-call ID for a real provider call. If it
    // is missing here the invocation is inadmissible: never execute unowned and
    // never fabricate a durable ToolPart identity.
    if (!options.toolCallId) {
      return run.promise(Effect.die(new Error(`Tool "${name}" executed without a provider tool-call ID`)))
    }
    return run.promise(Effect.gen(function* () {
    const killable = options.toolCallId && options.abortSignal
      ? yield* interrupt.track({ sessionID: input.session.id, callID: options.toolCallId, parent: options.abortSignal })
      : undefined
    try {
      const execution = Effect.gen(function* () {
        if (options.toolCallId)
          yield* (input.processor.startToolCall?.(options.toolCallId, name, args) ?? Effect.void)
        return yield* invoke(context(args, options, killable))
      })
      return yield* (killable ? Effect.raceFirst(execution, abortSignalEffect(killable)) : execution).pipe(
        Effect.onExit((exit) => {
          if (!options.toolCallId) return Effect.void
          return Exit.isSuccess(exit)
            ? input.processor.completeToolCall(options.toolCallId, exit.value)
            : input.processor.failToolCall?.(options.toolCallId, Cause.squash(exit.cause)) ?? Effect.void
        }),
      )
    } finally {
      if (killable && options.toolCallId)
        yield* interrupt.release({ sessionID: input.session.id, callID: options.toolCallId })
    }
  }), { signal: options.abortSignal })
  }

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
  })) {
    const schema = finalFunctionParametersSchema(
      ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item)),
    )
    const wrapped = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return executeTracked(item.id, toRecord(args), options, (ctx) => Effect.gen(function* () {
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
              return output
        }))
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
    for (const definition of McpResourceTools.definitions) {
      tools[definition.id] = tool({
        description: definition.description,
        inputSchema: jsonSchema(ProviderTransform.schema(input.model, definition.inputSchema)),
        execute(args, opts) {
          return executeTracked(definition.id, toRecord(args), opts, (ctx) => Effect.gen(function* () {
              yield* plugin.trigger(
                "tool.execute.before",
                { tool: definition.id, sessionID: ctx.sessionID, callID: opts.toolCallId },
                { args },
              )
              const semantic = yield* definition.invoke(mcp, args, ctx)
              const truncated = yield* truncate.output(semantic.output, {}, input.agent, Tool.timelineOwner(ctx))
              const output = {
                title: semantic.title,
                metadata: {
                  ...semantic.metadata,
                  ...Truncate.mergeMetadata({}, truncated),
                },
                output: truncated.content,
                attachments: semantic.attachments?.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
              }
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: definition.id, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
                output,
              )
              return output
          }))
        },
      })
    }
  }

  const finalize = () => {
    if (canonicalFindTool && tools.find === canonicalFindTool) markCanonicalFindToolMap(tools)
    return tools
  }

  return finalize()
})

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

export * as SessionTools from "./tools"
