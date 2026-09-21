import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM as SessionLLM } from "@/session/llm"
import { MessageID } from "@/session/schema"
import { canonicalMessagesToModelMessages } from "@/special-agent/model-message-bridge"
import { makeV1SpecialAgentAnchor } from "@/special-agent/v1-anchor"
import { GoalAuditor } from "@opencode-ai/core/goal/auditor"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { collectUntilTerminalTool } from "@opencode-ai/core/special-agent-completion"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"
import { type ToolDefinition as CanonicalToolDefinition } from "@opencode-ai/llm"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { jsonSchema, tool, type Tool } from "ai"

const AUDIT_VERDICT = "audit_verdict"

const toTools = (definitions: readonly CanonicalToolDefinition[]): Record<string, Tool> =>
  Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(ToolJsonSchema.fromJsonSchema(definition.inputSchema as JSONSchema7)),
      }),
    ]),
  )

const capability = (model: Provider.Model) => ({
  providerID: model.providerID,
  modelID: model.id,
  apiNpm: model.api?.npm,
  apiURL: model.api?.url,
  apiID: model.api?.id,
})

function candidates(input: {
  configured?: ModelV2.Ref
  workerModel?: ModelV2.Ref
  session?: { model?: ModelV2.Ref }
}) {
  if (input.configured) return [input.configured]
  const inherited = input.workerModel ?? input.session?.model
  if (!inherited) return []
  const parts = splitModelIDForProvider(inherited.id, inherited.providerID)
  if (parts.baseModelID === inherited.id) return [inherited]
  return [
    inherited,
    {
      ...inherited,
      id: ModelV2.ID.make(parts.baseModelID),
    },
  ] satisfies ModelV2.Ref[]
}

/**
 * Production Goal Auditor runtime.
 *
 * Model lookup and generation go through the exact same Provider + Session LLM
 * stack as ordinary worker turns. Core still owns audit protocol, read-only
 * tool execution, transcript publication, leases and verdict semantics.
 */
export const makeRuntime = (provider: Provider.Interface, llm: SessionLLM.Interface): GoalAuditor.Runtime => ({
  resolveModel: Effect.fn("GoalAuditorRuntime.resolveModel")(function* (input) {
    const attempted = new Set<string>()
    for (const candidate of candidates(input)) {
      const key = `${candidate.providerID}/${candidate.id}/${candidate.variant ?? ""}`
      if (attempted.has(key)) continue
      attempted.add(key)
      const found = yield* provider.getModel(candidate.providerID, candidate.id).pipe(Effect.option)
      if (found._tag === "None") continue
      return {
        ref: candidate,
        value: found.value,
        capability: capability(found.value),
        outputLimit: found.value.limit.output,
      } satisfies GoalAuditor.ResolvedModel
    }

    if (input.configured) {
      return yield* new GoalAuditor.RuntimeUnavailableError({
        message: `Configured Goal auditor model is unavailable: ${input.configured.providerID}/${input.configured.id}`,
      })
    }

    // No inherited model exists (for example a legacy Session without model
    // provenance). Only then use the same workspace default normal chat would.
    if (!input.workerModel && !input.session?.model) {
      const fallbackRef = yield* provider.defaultModel().pipe(
        Effect.mapError(
          (error) => new GoalAuditor.RuntimeUnavailableError({ message: `No Goal auditor model is available: ${error.message}` }),
        ),
      )
      const fallback = yield* provider.getModel(fallbackRef.providerID, fallbackRef.modelID).pipe(
        Effect.mapError(
          (error) => new GoalAuditor.RuntimeUnavailableError({ message: `No Goal auditor model is available: ${error.message}` }),
        ),
      )
      return {
        ref: { providerID: fallbackRef.providerID, id: fallbackRef.modelID },
        value: fallback,
        capability: capability(fallback),
        outputLimit: fallback.limit.output,
      } satisfies GoalAuditor.ResolvedModel
    }

    const inherited = input.workerModel ?? input.session?.model
    return yield* new GoalAuditor.RuntimeUnavailableError({
      message: `Worker model is unavailable to the Goal auditor: ${inherited!.providerID}/${inherited!.id}`,
    })
  }),

  generate: Effect.fn("GoalAuditorRuntime.generate")(function* (request) {
    const model = request.model.value as Provider.Model
    const user = makeV1SpecialAgentAnchor({
      sessionID: request.sessionID,
      agent: "goal_auditor",
      model: {
        providerID: model.providerID,
        modelID: model.id,
        variant: request.model.ref.variant,
      },
    })
    const agent: Agent.Info = {
      name: "goal-auditor",
      description: "Read-only Goal verification runtime",
      mode: "primary",
      native: true,
      hidden: true,
      permission: [],
      options: {},
      prompt: request.system,
      temperature: request.generation.temperature,
    }

    const response = yield* collectUntilTerminalTool(
      llm
        .stream({
          user,
          sessionID: request.sessionID,
          model,
          agent,
          system: [],
          messages: canonicalMessagesToModelMessages(request.messages),
          tools: toTools(request.tools),
          retries: 0,
          toolChoice: request.toolChoice,
          maxOutputTokens: request.generation.maxTokens,
        })
        .pipe(Stream.tap((event) => request.publish(event))),
      AUDIT_VERDICT,
    ).pipe(
      Effect.mapError(
        (error) =>
          new GoalAuditor.RuntimeUnavailableError({
            message: `Goal audit provider request failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      ),
    )
    if (!response) return yield* new GoalAuditor.RuntimeUnavailableError({ message: "Goal audit ended without a terminal response" })
    return response
  }),
})
