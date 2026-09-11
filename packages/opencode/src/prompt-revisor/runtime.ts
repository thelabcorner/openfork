import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM as SessionLLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { MCP } from "@/mcp"
import { PromptRevisor } from "@opencode-ai/core/prompt-revisor"
import { type ToolChoiceCapabilityIdentity } from "@opencode-ai/core/tool-choice-compatibility"
import { collectUntilTerminalTool, generateAdaptive } from "@opencode-ai/core/special-agent-completion"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { type ToolDefinition as CanonicalToolDefinition } from "@opencode-ai/llm"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { jsonSchema, tool, type Tool } from "ai"
import { canonicalMessagesToModelMessages } from "@/special-agent/model-message-bridge"
import { InstanceState } from "@/effect/instance-state"
import type { Interface as UsageInterface } from "@/usage/usage"
import * as MaintenanceUsage from "@/usage/maintenance"

const toTools = (definitions: readonly CanonicalToolDefinition[]): Record<string, Tool> =>
  Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema),
      }),
    ]),
  )

const toolChoiceIdentity = (model: Provider.Model): ToolChoiceCapabilityIdentity => ({
  providerID: model.providerID,
  modelID: model.id,
  apiNpm: model.api?.npm,
  apiURL: model.api?.url,
  apiID: model.api?.id,
})

/**
 * Production Prompt Revisor runtime. Model lookup and execution deliberately go
 * through the same Provider + Session LLM services used by ordinary chat turns.
 * No session is persisted; draft-mode calls use an ephemeral session-shaped id
 * only for plugin/telemetry request context.
 */
export const makeRuntime = (
  provider: Provider.Interface,
  llm: SessionLLM.Interface,
  mcp?: MCP.Interface,
  usage?: UsageInterface,
): PromptRevisor.Runtime => ({
  resolveModel: Effect.fn("PromptRevisorRuntime.resolveModel")(function* ({ candidates }) {
    const seen = new Set<string>()
    for (const candidate of candidates) {
      const key = `${candidate.providerID}/${candidate.id}/${candidate.variant ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      const resolved = yield* provider.getModel(candidate.providerID, candidate.id).pipe(Effect.option)
      if (resolved._tag === "Some") return { ref: candidate, value: resolved.value }
    }

    const fallbackRef = yield* provider.defaultModel().pipe(
      Effect.mapError(
        (error) =>
          new PromptRevisor.UnavailableError({
            message: `No model is available for prompt revision: ${error.message}`,
          }),
      ),
    )
    const fallback = yield* provider.getModel(fallbackRef.providerID, fallbackRef.modelID).pipe(
      Effect.mapError(
        (error) =>
          new PromptRevisor.UnavailableError({
            message: `No model is available for prompt revision: ${error.message}`,
          }),
      ),
    )
    return {
      ref: { providerID: fallbackRef.providerID, id: fallbackRef.modelID },
      value: fallback,
    }
  }),

  generate: Effect.fn("PromptRevisorRuntime.generate")(function* (request) {
    const model = request.model.value as Provider.Model
    const capability = toolChoiceIdentity(model)
    const sessionID = request.sessionID ?? SessionID.create()
    const instance = usage ? yield* InstanceState.context : undefined
    const user: SessionV1.User = {
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "prompt-revisor",
      model: {
        providerID: model.providerID,
        modelID: model.id,
        variant: request.model.ref.variant,
      },
    }
    const agent: Agent.Info = {
      name: "prompt-revisor",
      description: "Read-only prompt revision runtime",
      mode: "primary",
      native: true,
      hidden: true,
      permission: [],
      options: {},
      prompt: request.system,
      temperature: request.generation.temperature,
    }

    const collect = (toolChoice: SessionLLM.StreamInput["toolChoice"]) => {
      const startedAt = Date.now()
      const messages = canonicalMessagesToModelMessages(request.messages)
      const trackingRequest = {
        system: request.system,
        messages,
        tools: request.tools,
        toolChoice,
      }
      return collectUntilTerminalTool(
        llm.stream({
          user,
          sessionID,
          model,
          agent,
          system: [],
          messages,
          tools: toTools(request.tools),
          retries: 0,
          toolChoice,
          maxOutputTokens: request.generation.maxTokens,
        }),
        "revised_prompt",
      ).pipe(
        Effect.tap((response) =>
          response && usage
            ? MaintenanceUsage.recordResponse({
                usage,
                agent: "prompt-revisor",
                model,
                response,
                request: trackingRequest,
                sessionID,
                projectID: instance?.project.id,
                variant: request.model.ref.variant,
                startedAt,
              })
            : Effect.void,
        ),
      )
    }

    const response =
      request.toolChoice === "none"
        ? yield* collect("none").pipe(
            Effect.mapError(
              (error) =>
                new PromptRevisor.UnavailableError({
                  message: `Prompt revision failed: ${error instanceof Error ? error.message : String(error)}`,
                }),
            ),
          )
        : (yield* generateAdaptive({
            identity: capability,
            requested: request.toolChoice,
            generate: (toolChoice) => collect(toolChoice),
          }).pipe(
            Effect.mapError(
              (error) =>
                new PromptRevisor.UnavailableError({
                  message: `Prompt revision failed: ${error instanceof Error ? error.message : String(error)}`,
                }),
            ),
          )).response
    if (!response) {
      return yield* new PromptRevisor.UnavailableError({ message: "Prompt revision ended without a terminal response" })
    }
    return response
  }),

  ...(mcp
    ? {
        composerContext: Effect.fn("PromptRevisorRuntime.composerContext")(function* (request) {
          if (!request.kinds.includes("resource")) return []
          const query = request.query.trim().toLowerCase()
          // MCP resource discovery currently has a `never` typed error channel.
          // Do not manufacture an impossible typed error path here: defects still
          // surface through the surrounding runtime while normal discovery stays
          // allocation-free on the hot path.
          const resources = yield* mcp.resources()
          return Object.values(resources)
            .flatMap((item) => {
              const name = item.name?.trim() || item.uri
              const haystack = `${name} ${item.uri} ${item.description ?? ""} ${item.client}`.toLowerCase()
              if (query && !haystack.includes(query)) return []
              return [
                {
                  kind: "resource" as const,
                  name,
                  clientName: item.client,
                  uri: item.uri,
                  ...(item.mimeType ? { mimeType: item.mimeType } : {}),
                  ...(item.description ? { description: item.description } : {}),
                },
              ]
            })
            .slice(0, request.limit)
        }),
      }
    : {}),
})
