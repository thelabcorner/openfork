import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM as SessionLLM } from "@/session/llm"
import { MessageID } from "@/session/schema"
import { canonicalMessagesToModelMessages } from "@/special-agent/model-message-bridge"
import { makeV1SpecialAgentAnchor } from "@/special-agent/v1-anchor"
import { GoalAuditor } from "@opencode-ai/core/goal/auditor"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { SessionSchema as CoreSessionSchema } from "@opencode-ai/core/session/schema"
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

const usageRoute = (route?: ProviderRouteResolution.RouteAttribution) =>
  route?.routeKind === "account"
    ? ({ routeKind: "account", accountID: route.accountID! } as const)
    : route?.routeKind === "public"
      ? ({ routeKind: "public" } as const)
      : undefined

const routedRef = (ref: ModelV2.Ref, route?: ProviderRouteResolution.RouteAttribution) =>
  route?.routeKind === "account"
    ? ModelV2.Ref.make({ ...ref, accountID: route.accountID! })
    : route?.routeKind === "public"
      ? ModelV2.Ref.make({
          providerID: ref.providerID,
          id: ref.id,
          ...(ref.variant ? { variant: ref.variant } : {}),
        })
      : ref

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
export const makeRuntime = (
  provider: Provider.Interface,
  llm: SessionLLM.Interface,
  parentRoute?: {
    sessionID: CoreSessionSchema.ID
    route: ProviderRouteResolution.RouteAttribution
  },
): GoalAuditor.Runtime => ({
  resolveModel: Effect.fn("GoalAuditorRuntime.resolveModel")(function* (input) {
    const attempted = new Set<string>()
    for (const candidate of candidates(input)) {
      const key = `${candidate.providerID}/${candidate.id}/${candidate.variant ?? ""}`
      if (attempted.has(key)) continue
      attempted.add(key)
      let model: Provider.Model | undefined
      let selectedRoute: ProviderRouteResolution.RouteAttribution | undefined

      if (parentRoute?.route.providerID === candidate.providerID) {
        if (
          candidate.accountID &&
          (parentRoute.route.routeKind !== "account" || parentRoute.route.accountID !== candidate.accountID)
        ) {
          continue
        }
        const inherited = yield* provider
          .resolveInheritedRoutedModel({
            sessionID: parentRoute.sessionID,
            providerID: candidate.providerID,
            modelID: candidate.id,
            route: parentRoute.route,
          })
          .pipe(Effect.option)
        if (inherited._tag === "None") continue
        model = inherited.value.model
        selectedRoute = inherited.value.route.attribution
      } else if (parentRoute) {
        // candidates() returns only the configured model when one exists, so a
        // different provider here is a true explicit maintenance override.
        if (!input.configured) continue
        const routed = yield* provider
          .resolveRoutedModel({
            sessionID: parentRoute.sessionID,
            providerID: candidate.providerID,
            modelID: candidate.id,
            ...(candidate.accountID ? { accountID: candidate.accountID } : {}),
          })
          .pipe(Effect.option)
        if (routed._tag === "None") continue
        if (routed.value) {
          model = routed.value.model
          selectedRoute = routed.value.route.attribution
        } else {
          const direct = yield* provider
            .getModel(candidate.providerID, candidate.id, candidate.accountID)
            .pipe(Effect.option)
          if (direct._tag === "None") continue
          model = direct.value
        }
      } else {
        const direct = yield* provider
          .getModel(candidate.providerID, candidate.id, candidate.accountID)
          .pipe(Effect.option)
        if (direct._tag === "None") continue
        model = direct.value
      }

      const ref = routedRef(candidate, selectedRoute)
      return {
        ref,
        value: model,
        ...(selectedRoute ? { route: usageRoute(selectedRoute) } : {}),
        capability: capability(model),
        outputLimit: model.limit.output,
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
          ...(request.model.route?.routeKind === "account"
            ? { accountID: request.model.route.accountID }
            : request.model.ref.accountID
              ? { accountID: request.model.ref.accountID }
              : {}),
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
          ...(request.model.route ? { route: request.model.route } : {}),
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
