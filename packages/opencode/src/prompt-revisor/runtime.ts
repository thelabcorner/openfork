import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM as SessionLLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { MCP } from "@/mcp"
import { ModelV2 } from "@opencode-ai/core/model"
import { PromptRevisor } from "@opencode-ai/core/prompt-revisor"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { OpencodeProviderRoute } from "@opencode-ai/core/plugin/provider/opencode-provider-route"
import { type ToolChoiceCapabilityIdentity } from "@opencode-ai/core/tool-choice-compatibility"
import { collectUntilTerminalTool } from "@opencode-ai/core/special-agent-completion"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { type ToolDefinition as CanonicalToolDefinition } from "@opencode-ai/llm"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { jsonSchema, tool, type Tool } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { ToolJsonSchema } from "@/tool/json-schema"
import { canonicalMessagesToModelMessages } from "@/special-agent/model-message-bridge"
import { makeV1SpecialAgentAnchor } from "@/special-agent/v1-anchor"

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

const toolChoiceIdentity = (model: Provider.Model): ToolChoiceCapabilityIdentity => ({
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

type MaintenanceRoute =
  | { readonly routeKind: "public" }
  | { readonly routeKind: "account"; readonly accountID: string }

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

const bindingAttribution = (binding: ProviderRoute.Binding): ProviderRouteResolution.RouteAttribution => ({
  sessionID: binding.sessionID,
  affinityDomain: binding.affinityDomain,
  providerID: binding.providerID,
  routeRevision: binding.routeRevision,
  routeKind: binding.routeKind,
  ...(binding.routeKind === "account" ? { accountID: binding.accountID } : {}),
})

const transientUsageRoute = (routed: Provider.TransientRoutedModel): MaintenanceRoute =>
  routed.route.route.kind === "account"
    ? { routeKind: "account", accountID: routed.route.route.accountID }
    : { routeKind: "public" }

/**
 * Production Prompt Revisor runtime. Model lookup and execution deliberately go
 * through the same Provider + Session LLM services used by ordinary chat turns.
 * No session is persisted; draft-mode calls use an ephemeral session-shaped id
 * only for plugin/telemetry request context.
 */
export const makeRuntime = (
  provider: Provider.Interface,
  llm: SessionLLM.Interface,
  agents: Agent.Interface,
  mcp?: MCP.Interface,
  routes?: ProviderRoute.Interface,
): PromptRevisor.Runtime => ({
  resolveModel: Effect.fn("PromptRevisorRuntime.resolveModel")(function* ({
    candidates,
    explicitCandidates = [],
    session,
  }) {
    const candidateKey = (candidate: ModelV2.Ref) =>
      `${candidate.providerID}/${candidate.id}/${candidate.accountID ?? ""}/${candidate.variant ?? ""}`
    const explicit = new Set(explicitCandidates.map(candidateKey))
    const sessionModelKey = session?.model ? candidateKey(session.model) : undefined
    const seen = new Set<string>()
    for (const candidate of candidates) {
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)

      const explicitOverride = explicit.has(key)
      const inheritedProvider = session?.model === undefined || candidate.providerID === session.model.providerID
      if (session && !explicitOverride && !inheritedProvider) continue

      // Automatic same-provider fallbacks must not hard-pin stale account
      // metadata. The actual Session model and explicit one-shot overrides keep
      // their account intent.
      const accountID = !session || explicitOverride || key === sessionModelKey ? candidate.accountID : undefined

      if (session && routes) {
        const binding = yield* routes.get(session.id, OpencodeProviderRoute.affinityDomain(candidate.providerID))
        // Hosted Public may be a valid parent worker binding, but it is not an
        // OpenFork special-agent transport. Resolve an account-backed transient
        // route instead, without changing that parent binding.
        if (binding && !(Provider.isHostedZenProvider(candidate.providerID) && binding.routeKind === "public")) {
          if (accountID && (binding.routeKind !== "account" || binding.accountID !== accountID)) continue
          const route = bindingAttribution(binding)
          const inherited = yield* provider
            .resolveInheritedRoutedModel({
              sessionID: session.id,
              providerID: candidate.providerID,
              modelID: candidate.id,
              route,
              executionPurpose: "special-agent",
            })
            .pipe(Effect.option)
          if (inherited._tag === "None") continue
          if (Provider.isHostedZenProvider(candidate.providerID) && inherited.value.route.attribution?.routeKind !== "account") continue
          return {
            ref: routedRef(candidate, usageRoute(inherited.value.route.attribution)),
            value: inherited.value.model,
            route: usageRoute(inherited.value.route.attribution),
            capability: toolChoiceIdentity(inherited.value.model),
          }
        }
      }

      // A committed route for this provider exists only for the owning primary
      // turn. When it is absent, maintenance must not become the route owner:
      // resolve a one-call route that materializes the exact Public/account
      // transport without creating or rebinding durable Session affinity.
      // Draft mode has no Session at all, but a hosted provider still requires a
      // real route decision instead of ambient auth.
      const shouldRouteTransiently = session !== undefined || Provider.isHostedZenProvider(candidate.providerID)
      if (shouldRouteTransiently && typeof provider.resolveTransientRoutedModel === "function") {
        const transient = yield* provider
          .resolveTransientRoutedModel({
            providerID: candidate.providerID,
            modelID: candidate.id,
            ...(accountID ? { accountID } : { routeIntent: { kind: "auto" as const } }),
            executionPurpose: "special-agent",
          })
          .pipe(Effect.option)
        if (transient._tag === "None") continue
        if (transient.value) {
          const route = transientUsageRoute(transient.value)
          if (Provider.isHostedZenProvider(candidate.providerID) && route.routeKind !== "account") continue
          return {
            ref: routedRef(candidate, route),
            value: transient.value.model,
            route,
            capability: toolChoiceIdentity(transient.value.model),
          }
        }
        // A successful undefined result is the route owner's positive statement
        // that this provider/model belongs to the legacy direct-provider path.
      }

      // A hosted provider always has an authoritative route owner. If the
      // transient resolution above produced nothing, maintenance must fail
      // closed rather than spend an ambient credential (or land on the hosted
      // Public free tier) through a bare catalog lookup.
      if (Provider.isHostedZenProvider(candidate.providerID)) continue

      const resolved = yield* provider
        .getModel(candidate.providerID, candidate.id, accountID)
        .pipe(Effect.option)
      if (resolved._tag === "Some") {
        return { ref: routedRef(candidate), value: resolved.value, capability: toolChoiceIdentity(resolved.value) }
      }
    }

    // Match ordinary session semantics: an explicit model chain is authoritative.
    // If every requested candidate is unavailable, do not silently jump to an
    // unrelated provider default (which can cross account/auth boundaries, e.g.
    // into Console's public free tier). The caller already supplies the ordered
    // special-agent -> composer -> session fallback chain.
    if (candidates.length > 0) {
      const requested = candidates
        .map((candidate) => `${candidate.providerID}/${candidate.id}${candidate.accountID ? `@${candidate.accountID}` : ""}`)
        .join(", ")
      return yield* new PromptRevisor.UnavailableError({
        message: `No requested model is available for prompt revision: ${requested}` +
          (candidates.some((item) => Provider.isHostedZenProvider(item.providerID))
            ? ". Hosted OpenCode Public/free tier cannot execute OpenFork special agents; select an eligible account-backed model."
            : ""),
      })
    }

    const unavailable = (error: { readonly message: string }) =>
      new PromptRevisor.UnavailableError({
        message: `No model is available for prompt revision: ${error.message}`,
      })

    const fallbackRef = yield* provider.defaultModel().pipe(Effect.mapError(unavailable))
    const fallbackCandidate = ModelV2.Ref.make({
      providerID: fallbackRef.providerID,
      id: fallbackRef.modelID,
    })

    // The provider default is a real streaming selection, not catalog metadata.
    // It obeys the same invariant as an explicit candidate: a hosted provider
    // must reach llm.stream through an actual route decision, so it fails closed
    // instead of spending an ambient credential or landing on the hosted Public
    // free tier through a bare catalog lookup.
    const shouldRouteFallbackTransiently =
      session !== undefined || Provider.isHostedZenProvider(fallbackRef.providerID)
    if (shouldRouteFallbackTransiently && typeof provider.resolveTransientRoutedModel === "function") {
      const transient = yield* provider
        .resolveTransientRoutedModel({
          providerID: fallbackRef.providerID,
          modelID: fallbackRef.modelID,
          routeIntent: { kind: "auto" },
          executionPurpose: "special-agent",
        })
        .pipe(Effect.mapError(unavailable))
      if (transient) {
        const route = transientUsageRoute(transient)
        if (Provider.isHostedZenProvider(fallbackRef.providerID) && route.routeKind !== "account") {
          return yield* new PromptRevisor.UnavailableError({
            message: "OpenCode Public free tier cannot execute an OpenFork special agent; select an account-backed model",
          })
        }
        return {
          ref: routedRef(fallbackCandidate, route),
          value: transient.model,
          route,
          capability: toolChoiceIdentity(transient.model),
        }
      }
      // A successful undefined result is the route owner's positive statement
      // that this provider/model belongs to the legacy direct-provider path.
    }

    // A hosted provider always has an authoritative route owner: without one,
    // maintenance must fail closed rather than stream with no route at all.
    if (Provider.isHostedZenProvider(fallbackRef.providerID)) {
      return yield* new PromptRevisor.UnavailableError({
        message: `No model is available for prompt revision: ${fallbackRef.providerID}/${fallbackRef.modelID} has no authoritative route`,
      })
    }

    const fallback = yield* provider.getModel(fallbackRef.providerID, fallbackRef.modelID).pipe(
      Effect.mapError(unavailable),
    )
    return {
      ref: fallbackCandidate,
      value: fallback,
      capability: toolChoiceIdentity(fallback),
    }
  }),

  generate: Effect.fn("PromptRevisorRuntime.generate")(function* (request) {
    const model = request.model.value as Provider.Model
    const sessionID = request.sessionID ?? SessionID.create()
    const baseAgent = yield* agents.get("prompt-revisor")
    if (!baseAgent) {
      return yield* new PromptRevisor.UnavailableError({
        message: "The canonical prompt-revisor agent is unavailable",
      })
    }
    const user = makeV1SpecialAgentAnchor({
      sessionID,
      agent: request.specialAgent,
        model: {
          providerID: request.model.ref.providerID,
          modelID: request.model.ref.id,
          ...(request.model.route?.routeKind === "account"
            ? { accountID: request.model.route.accountID }
            : request.model.ref.accountID
              ? { accountID: request.model.ref.accountID }
              : {}),
          variant: request.model.ref.variant,
        },
    })
    // Prompt revision is a real built-in agent, not a synthetic request-local
    // Agent.Info. Preserve its configured model options, permissions, variant,
    // plugin identity, and any user overrides; only the operation-owned policy
    // and bounded generation temperature are request-specific.
    const agent: Agent.Info = {
      ...baseAgent,
      prompt: request.system,
      temperature: request.generation.temperature ?? baseAgent.temperature,
    }

    const collect = (toolChoice: SessionLLM.StreamInput["toolChoice"]) => {
      const messages = canonicalMessagesToModelMessages(request.messages)
      // Provider events are forwarded to the owning special-agent transcript so
      // this turn is durable in exactly the same pipeline normal chat uses.
      // Maintenance accounting is owned by that same Core session, not the host.
      return collectUntilTerminalTool(
        llm
          .stream({
            user,
            sessionID,
            model,
            ...(request.model.route ? { route: request.model.route } : {}),
            agent,
            system: [],
            continuity: "isolated",
            messages,
            tools: toTools(request.tools),
            retries: 0,
            toolChoice,
            maxOutputTokens: request.generation.maxTokens,
          })
          .pipe(Stream.tap((event) => (request.publish ? request.publish(event) : Effect.void))),
        "revised_prompt",
      )
    }

    const response = yield* collect(request.toolChoice).pipe(
      Effect.mapError(
        (error) =>
          new PromptRevisor.UnavailableError({
            message: `Prompt revision failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      ),
    )
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
