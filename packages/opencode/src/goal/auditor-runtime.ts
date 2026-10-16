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

type MaintenanceRoute =
  | { readonly routeKind: "public" }
  | { readonly routeKind: "account"; readonly accountID: string }

const usageRoute = (route?: ProviderRouteResolution.RouteAttribution): MaintenanceRoute | undefined =>
  route?.routeKind === "account"
    ? { routeKind: "account", accountID: route.accountID! }
    : route?.routeKind === "public"
      ? { routeKind: "public" }
      : undefined

const transientUsageRoute = (routed: Provider.TransientRoutedModel): MaintenanceRoute =>
  routed.route.route.kind === "account"
    ? { routeKind: "account", accountID: routed.route.route.accountID }
    : { routeKind: "public" }

const routedRef = (ref: ModelV2.Ref, route?: MaintenanceRoute) =>
  route?.routeKind === "account"
    ? ModelV2.Ref.make({ ...ref, accountID: route.accountID })
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
      let selectedRoute: MaintenanceRoute | undefined

      const restrictedParentPublic =
        parentRoute?.route.providerID === candidate.providerID &&
        parentRoute.route.routeKind === "public" &&
        Provider.isHostedZenProvider(candidate.providerID)
      if (parentRoute?.route.providerID === candidate.providerID && !restrictedParentPublic) {
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
            executionPurpose: "special-agent",
          })
          .pipe(Effect.option)
        if (inherited._tag === "None") continue
        model = inherited.value.model
        selectedRoute = usageRoute(inherited.value.route.attribution)
        if (Provider.isHostedZenProvider(candidate.providerID) && selectedRoute?.routeKind !== "account") continue
      } else {
        // A configured cross-provider auditor model is an explicit maintenance
        // override, but it still must not create a second durable route on the
        // parent Session. Likewise, legacy/no-parent-route audits must not fall
        // back to ambient hosted auth. Resolve one non-persistent route and only
        // use direct provider lookup when the route owner positively declines.
        if (parentRoute && !input.configured && !restrictedParentPublic) continue
        const transient = yield* provider
          .resolveTransientRoutedModel({
            providerID: candidate.providerID,
            modelID: candidate.id,
            ...(candidate.accountID
              ? { accountID: candidate.accountID }
              : { routeIntent: { kind: "auto" as const } }),
            executionPurpose: "special-agent",
          })
          .pipe(Effect.option)
        if (transient._tag === "None") continue
        if (transient.value) {
          model = transient.value.model
          selectedRoute = transientUsageRoute(transient.value)
          if (Provider.isHostedZenProvider(candidate.providerID) && selectedRoute.routeKind !== "account") continue
        } else {
          // A hosted provider always has an authoritative route owner. Carry the
          // route owner's refusal into a fail-closed skip instead of spending an
          // ambient hosted credential through a bare catalog lookup.
          if (Provider.isHostedZenProvider(candidate.providerID)) continue
          const direct = yield* provider
            .getModel(candidate.providerID, candidate.id, candidate.accountID)
            .pipe(Effect.option)
          if (direct._tag === "None") continue
          model = direct.value
        }
      }

      const ref = routedRef(candidate, selectedRoute)
      return {
        ref,
        value: model,
        ...(selectedRoute ? { route: selectedRoute } : {}),
        capability: capability(model),
        outputLimit: model.limit.output,
      } satisfies GoalAuditor.ResolvedModel
    }

    if (input.configured) {
      return yield* new GoalAuditor.RuntimeUnavailableError({
        message: `Configured Goal auditor model is unavailable: ${input.configured.providerID}/${input.configured.id}` +
          (Provider.isHostedZenProvider(input.configured.providerID)
            ? ". OpenFork special agents require an eligible account-backed hosted model; upstream Public/free tier cannot be used."
            : ""),
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
      const fallbackRouted = yield* provider
        .resolveTransientRoutedModel({
          providerID: fallbackRef.providerID,
          modelID: fallbackRef.modelID,
          routeIntent: { kind: "auto" },
          executionPurpose: "special-agent",
        })
        .pipe(
          Effect.mapError(
            (error) => new GoalAuditor.RuntimeUnavailableError({ message: `No Goal auditor model is available: ${error.message}` }),
          ),
        )
      if (Provider.isHostedZenProvider(fallbackRef.providerID) &&
          (!fallbackRouted || fallbackRouted.route.route.kind !== "account")) {
        return yield* new GoalAuditor.RuntimeUnavailableError({
          message: `No Goal auditor model is available: ${fallbackRef.providerID}/${fallbackRef.modelID} has no eligible account-backed route; upstream Public/free tier is unavailable to OpenFork special agents.`,
        })
      }
      const fallback = fallbackRouted?.model ??
        (yield* provider.getModel(fallbackRef.providerID, fallbackRef.modelID).pipe(
          Effect.mapError(
            (error) => new GoalAuditor.RuntimeUnavailableError({ message: `No Goal auditor model is available: ${error.message}` }),
          ),
        ))
      const route = fallbackRouted ? transientUsageRoute(fallbackRouted) : undefined
      return {
        ref: routedRef({ providerID: fallbackRef.providerID, id: fallbackRef.modelID }, route),
        value: fallback,
        ...(route ? { route } : {}),
        capability: capability(fallback),
        outputLimit: fallback.limit.output,
      } satisfies GoalAuditor.ResolvedModel
    }

    const inherited = input.workerModel ?? input.session?.model
    return yield* new GoalAuditor.RuntimeUnavailableError({
      message: `Worker model is unavailable to the Goal auditor: ${inherited!.providerID}/${inherited!.id}` +
        (Provider.isHostedZenProvider(inherited!.providerID)
          ? ". No account-backed route is eligible; the parent Public/free tier cannot execute OpenFork special agents. Configure an eligible Goal Auditor model."
          : ""),
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
