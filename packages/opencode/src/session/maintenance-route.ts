import { Effect, Option } from "effect"
import { OpencodeProviderRoute } from "@opencode-ai/core/plugin/provider/opencode-provider-route"
import type { ModelV2 } from "@opencode-ai/core/model"
import type { ProviderRoute } from "@opencode-ai/core/provider-route"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import type { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import type { Provider } from "@/provider/provider"

/** Minimal read-only slice of ProviderRoute needed to recover a parent route. */
export interface RecoveryBindingSource {
  readonly get: ProviderRoute.Interface["get"]
}

/**
 * Recover the parent Session's committed route attribution for one provider.
 *
 * Maintenance and recovery entry points (manual retitle, Goal audit recovery,
 * Prompt Revisor) can start outside the primary prompt turn and therefore have
 * no in-flight routed result. They must inherit the exact committed route
 * generation rather than resolving a transient route or falling back to a bare
 * `getModel` + `llm.stream` with no route, which the LLM layer satisfies from
 * ambient auth. On a hosted provider that is exactly the "OpenCode's free tier
 * can only be used from within OpenCode" admission error.
 *
 * Read-only by construction: it never binds, rebinds, or commits a durable
 * ProviderRoute row.
 */
export const accountAttributionFromBinding = Effect.fn("MaintenanceRoute.accountAttributionFromBinding")(function* (
  routes: RecoveryBindingSource,
  input: { readonly sessionID: SessionSchema.ID; readonly providerID: ProviderV2.ID },
) {
  const binding = yield* routes.get(input.sessionID, OpencodeProviderRoute.affinityDomain(input.providerID))
  if (!binding) return undefined
  return {
    sessionID: binding.sessionID,
    affinityDomain: binding.affinityDomain,
    providerID: binding.providerID,
    routeRevision: binding.routeRevision,
    routeKind: binding.routeKind,
    ...(binding.routeKind === "account" ? { accountID: binding.accountID } : {}),
  } satisfies ProviderRouteResolution.RouteAttribution
})

const usageRoute = (
  route?: ProviderRouteResolution.RouteAttribution,
): UsageRouteAttribution.Committed | undefined => {
  if (!route) return undefined
  return route.routeKind === "account"
    ? { routeKind: "account", accountID: route.accountID! }
    : { routeKind: "public" }
}

const transientUsageRoute = (routed: Provider.TransientRoutedModel): UsageRouteAttribution.Committed =>
  routed.route.route.kind === "account"
    ? { routeKind: "account", accountID: routed.route.route.accountID }
    : { routeKind: "public" }

export interface MaintenanceModelResolution {
  readonly model: Provider.Model
  readonly route?: UsageRouteAttribution.Committed
}

/**
 * Resolve one maintenance/special-agent model against a parent Session.
 *
 * Ownership invariant: this never creates, binds, rebinds, or fails over the
 * Session's durable ProviderRoute.
 *
 * - Same-provider candidates inherit the exact committed route generation via
 *   `resolveInheritedRoutedModel` (the parent attribution is the authority).
 * - An explicit cross-provider override uses a non-persistent transient route
 *   via `resolveTransientRoutedModel`; it never becomes a second durable route.
 * - A hosted provider with no authoritative route fails closed instead of
 *   spending an ambient credential / landing on the hosted Public free tier.
 * - Direct `getModel` is used only after the route owner positively reports
 *   that the provider/model is outside its domain.
 *
 * The hosted-provider policy is injected (`isHostedProvider`) so this shared
 * owner stays free of a runtime Provider import and is directly unit-testable.
 */
export const resolveMaintenanceModel = Effect.fn("MaintenanceRoute.resolveMaintenanceModel")(function* (
  provider: Provider.Interface,
  isHostedProvider: (providerID: string) => boolean,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly providerID: ProviderV2.ID
    readonly modelID: ModelV2.ID
    readonly accountID?: string
    readonly explicitAccount?: boolean
    /**
     * Explicitly configured maintenance models may own a distinct provider
     * route. Automatic/same-policy fallbacks must inherit the parent route.
     */
    readonly explicitOverride?: boolean
    readonly route?: ProviderRouteResolution.RouteAttribution
  },
): Effect.fn.Return<MaintenanceModelResolution | undefined> {
  // An explicit title/maintenance override owns a transient provider-domain
  // decision even when it names the *same* provider as the parent Session.
  // Inheriting the parent's binding here ignored the caller's account pin and
  // could incorrectly reject a valid alternate account/model.
  const restrictedParentPublic =
    input.route?.providerID === input.providerID &&
    input.route.routeKind === "public" &&
    isHostedProvider(input.providerID)
  if (input.route?.providerID === input.providerID && !input.explicitOverride && !restrictedParentPublic) {
    if (
      input.explicitAccount &&
      input.accountID &&
      (input.route.routeKind !== "account" || input.route.accountID !== input.accountID)
    ) {
      yield* Effect.logWarning("maintenance model account conflicts with committed route", {
        sessionID: input.sessionID,
        providerID: input.providerID,
        modelID: input.modelID,
        requestedAccountID: input.accountID,
        routeKind: input.route.routeKind,
        routeAccountID: input.route.accountID ?? null,
      })
      return undefined
    }
    const inherited = yield* provider
      .resolveInheritedRoutedModel({
        sessionID: input.sessionID,
        providerID: input.providerID,
        modelID: input.modelID,
        route: input.route,
        executionPurpose: "special-agent",
      })
      .pipe(Effect.option)
    if (Option.isNone(inherited)) {
      yield* Effect.logWarning("maintenance model inherited route unavailable", {
        sessionID: input.sessionID,
        providerID: input.providerID,
        modelID: input.modelID,
        routeProviderID: input.route.providerID,
        routeKind: input.route.routeKind,
      })
      return undefined
    }
    const selectedRoute = usageRoute(inherited.value.route.attribution)
    if (isHostedProvider(input.providerID) && selectedRoute?.routeKind !== "account") return undefined
    return { model: inherited.value.model, route: selectedRoute }
  }

  if (input.route && !input.explicitOverride && !restrictedParentPublic) {
    yield* Effect.logWarning("maintenance model skipped: provider differs from committed route", {
      sessionID: input.sessionID,
      providerID: input.providerID,
      modelID: input.modelID,
      routeProviderID: input.route.providerID,
      routeKind: input.route.routeKind,
    })
    return undefined
  }

  if (input.explicitOverride || restrictedParentPublic || (!input.route && isHostedProvider(input.providerID))) {
    // A configured override, or a legacy hosted Session with no persisted
    // ProviderRoute, or a parent bound to unusable hosted Public, needs an
    // independently authorized account-backed one-call route. In the
    // latter case there is no route generation to inherit; rejecting it made
    // automatic titles and manual retitles impossible for valid old Sessions.
    // This does not bind, rebind, or fail over the parent Session.
    const routed = yield* provider
      .resolveTransientRoutedModel({
        providerID: input.providerID,
        modelID: input.modelID,
        ...(input.accountID ? { accountID: input.accountID } : { routeIntent: { kind: "auto" as const } }),
        executionPurpose: "special-agent",
      })
      .pipe(Effect.option)
    if (Option.isNone(routed)) {
      yield* Effect.logWarning("maintenance override route unavailable", {
        sessionID: input.sessionID,
        providerID: input.providerID,
        modelID: input.modelID,
      })
      return undefined
    }
    if (routed.value) {
      const selectedRoute = transientUsageRoute(routed.value)
      if (isHostedProvider(input.providerID) && selectedRoute.routeKind !== "account") return undefined
      return { model: routed.value.model, route: selectedRoute }
    }
  }

  // A hosted provider always has an authoritative route owner, so reaching this
  // point means no route was granted. Fail closed instead of spending an ambient
  // credential or landing on the hosted Public free tier.
  if (isHostedProvider(input.providerID)) {
    yield* Effect.logWarning("maintenance model skipped: hosted provider has no authoritative route", {
      sessionID: input.sessionID,
      providerID: input.providerID,
      modelID: input.modelID,
    })
    return undefined
  }

  // Legacy/unrouted direct providers remain valid only when the route owner
  // explicitly reports that this provider/model is outside its domain.
  const direct = yield* provider.getModel(input.providerID, input.modelID, input.accountID).pipe(Effect.option)
  return Option.isSome(direct) ? { model: direct.value } : undefined
})

export * as MaintenanceRoute from "./maintenance-route"
