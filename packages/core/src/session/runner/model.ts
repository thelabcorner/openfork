export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { type Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { produce } from "immer"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import * as CredentialResolver from "../../credential/resolver"
import { httpClient as httpClientNode } from "../../effect/app-node-platform"
import { FSUtil } from "../../fs-util"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { ProviderRoute } from "../../provider-route"
import { ProviderRouteHealth } from "../../provider-route-health"
import type { ProviderRouteResolution } from "../../provider-route-resolution"
import { ProviderRouteIntentRuntime } from "../../provider-route-intent"
import { OpencodeAccountModel } from "../../plugin/provider/opencode-account-model"
import { projectCredential as projectOpencodeCredential } from "../../plugin/provider/opencode-provider-account"
import { OpencodeProviderRoute } from "../../plugin/provider/opencode-provider-route"
import type { ExecutionMaterialization } from "../../plugin/provider/opencode-route-candidates"
import { currentHostedCatalog, isHostedPublicModel, refreshHostedCatalog } from "../../plugin/provider/opencode-hosted"
import { isTrustedPublicCost } from "../../plugin/provider/opencode"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export class RouteUnavailableError extends Schema.TaggedErrorClass<RouteUnavailableError>()(
  "SessionRunnerModel.RouteUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    reason: Schema.String,
  },
) {
  override get message() {
    return `Provider route unavailable for ${this.providerID}/${this.modelID}: ${this.reason}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | RouteUnavailableError
  | Integration.AuthorizationError

export interface ResolvedInfo {
  readonly model: Model
  readonly name: string
  /** Secret-free durable attribution for settlement/inspection. */
  readonly route?: ProviderRouteResolution.RouteAttribution
  /**
   * Ephemeral exact execution generation. Never persist this object: the opaque
   * credential handle/revision exists only so internal maintenance execution can
   * prove it is using the same committed generation that materialized the model.
   */
  readonly lease?: ProviderRouteResolution.ProviderRouteLease
}

export interface MaintenanceOptions {
  /**
   * Explicit caller/config selection (a requested model, an agent-configured
   * model, a configured small_model). Explicit overrides always resolve a
   * transient route in the ref's own provider domain and never inherit the
   * parent Session's durable binding. Automatic same-provider fallbacks pass
   * false (or omit) so the existing exact route generation is inherited.
   */
  readonly explicitOverride?: boolean
}

export interface Interface {
  readonly resolve: (
    session: SessionSchema.Info,
    routeIntent?: ProviderRouteIntent.Info,
  ) => Effect.Effect<Model, Error>
  readonly resolveRef: (ref: ModelV2.Ref) => Effect.Effect<Model, Error>
  readonly resolveWithInfo: (
    session: SessionSchema.Info,
    routeIntent?: ProviderRouteIntent.Info,
  ) => Effect.Effect<ResolvedInfo, Error>
  /**
   * Host-owned maintenance/special-agent resolution. Never selects, binds,
   * rebinds, or fails over the parent Session's durable ProviderRoute:
   *
   * - same-provider, existing binding, non-explicit: inherit the exact route
   *   generation via compileExisting (fail closed on staleness);
   * - no binding, explicit override, or no session: resolve one
   *   transient/non-persistent route;
   * - the route owner returning undefined positively means outside its routing
   *   domain, and only then is direct provider lookup allowed.
   *
   * An undefined ref inherits the session's current worker selection (its
   * model, else the catalog default/first supported model), always as
   * non-explicit maintenance. Missing session and ref fails closed.
   *
   * Preserves the ref's accountID/variant and returns secret-free route
   * attribution where applicable. The transient attribution carries
   * routeRevision 0 to mark "no durable generation".
   */
  readonly resolveMaintenanceWithInfo: (
    session: SessionSchema.Info | undefined,
    ref: ModelV2.Ref | undefined,
    options?: MaintenanceOptions,
  ) => Effect.Effect<ResolvedInfo, Error>
  readonly resolveMaintenanceRef: (
    session: SessionSchema.Info | undefined,
    ref: ModelV2.Ref | undefined,
    options?: MaintenanceOptions,
  ) => Effect.Effect<Model, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying model resolvers directly. */
export const layerWith = (resolve: Interface["resolve"], resolveRef?: Interface["resolveRef"]) => {
  const refResolver =
    resolveRef ?? (() => Effect.die("SessionRunnerModel.resolveRef is unavailable in this test layer"))
  const maintenanceWithInfo: Interface["resolveMaintenanceWithInfo"] = (session, ref) =>
    (
      session
        ? resolve(ref ? { ...session, model: ref } : session)
        : ref
          ? refResolver(ref)
          : Effect.die("SessionRunnerModel.resolveMaintenance requires a session or model ref")
    ).pipe(Effect.map((model) => ({ model, name: model.id })))
  return Layer.succeed(
    Service,
    Service.of({
      resolve,
      resolveRef: refResolver,
      resolveWithInfo: (session, routeIntent) =>
        resolve(session, routeIntent).pipe(Effect.map((model) => ({ model, name: model.id }))),
      resolveMaintenanceWithInfo: maintenanceWithInfo,
      resolveMaintenanceRef: (session, ref, options) =>
        maintenanceWithInfo(session, ref, options).pipe(Effect.map((value) => value.model)),
    }),
  )
}

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolveWithVariant = (
  variant: ModelV2.VariantID | undefined,
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError | VariantUnavailableError> =>
  withVariant(model, variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  resolveWithVariant(session.model?.variant, model, credential)

export const supported = (model: ModelV2.Info) =>
  ModelV2.isLanguageModel(model.providerID, model) &&
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const credentialResolver = yield* CredentialResolver.Service
    const routes = yield* ProviderRoute.Service
    const routeHealth = yield* ProviderRouteHealth.Service
    const http = yield* HttpClient.HttpClient
    const fs = yield* FSUtil.Service
    const providerRoutes = OpencodeProviderRoute.make({
      realm: "openfork:standalone",
      credentials,
      resolver: credentialResolver,
      http,
      routes,
      assessHealth: (input) =>
        routeHealth
          .assessAccount({
            providerID: input.providerID,
            accountID: input.account.accountID,
            modelID: input.modelID,
            credentialRevision: input.credentialRevision,
          })
          .pipe(
            Effect.map((health) => ({
              admissible: health.admissible,
              healthRank: health.healthRank,
              ...(health.ineligibleReason ? { ineligibleReason: health.ineligibleReason } : {}),
              ...(health.resetAt === undefined ? {} : { resetAt: health.resetAt }),
            })),
          ),
    })

    const routeReason = (cause: unknown) =>
      cause instanceof Error ? cause.message : String(cause)

    const canonicalLegacyAccountID = Effect.fnUntraced(function* (accountID: string | undefined) {
      if (!accountID?.startsWith("cred_")) return accountID
      const stored = yield* credentials.get(Credential.ID.make(accountID))
      return stored ? projectOpencodeCredential(stored)?.accountID : undefined
    })

    const publicEligibility = Effect.fnUntraced(function* (model: ModelV2.Info | undefined) {
      if (!model || model.providerID !== ProviderV2.ID.opencode || !isTrustedPublicCost(model)) return false
      let hosted = currentHostedCatalog()
      if (hosted.state === "expired" || hosted.state === "unavailable") {
        yield* refreshHostedCatalog(http, fs).pipe(Effect.catch(() => Effect.void))
        hosted = currentHostedCatalog()
      }
      if (!isHostedPublicModel({ id: model.id, apiID: model.api.id }, hosted)) return false
      return yield* routeHealth
        .assessPublic({
          providerID: model.providerID,
          modelID: model.id,
        })
        .pipe(
          Effect.map((health) => health.available),
          Effect.orDie,
        )
    })

    const publicModel = (model: ModelV2.Info) =>
      produce(model, (draft) => {
        draft.request.headers = Object.fromEntries(
          Object.entries(draft.request.headers).filter(
            ([key]) =>
              !["authorization", "proxy-authorization", "x-api-key", "api-key"].includes(key.toLowerCase()),
          ),
        )
        draft.request.body = Object.fromEntries(
          Object.entries(draft.request.body).filter(
            ([key]) => key.replaceAll(/[-_]/g, "").toLowerCase() !== "apikey",
          ),
        )
        draft.request.body.apiKey = "public"
      })

    const resolveRef = Effect.fn("SessionRunnerModel.resolveRef")(function* (ref: ModelV2.Ref) {
      const selected = (yield* catalog.model.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (!selected)
        return yield* new ModelUnavailableError({
          providerID: ref.providerID,
          modelID: ref.id,
        })
      const provider = yield* catalog.provider.get(selected.providerID)
      const connection = yield* integrations.connection.active(
        provider?.integrationID ?? Integration.ID.make(selected.providerID),
      )
      const variant = yield* withVariant(selected, ref.variant)
      return yield* fromCatalogModel(
        variant,
        connection ? yield* integrations.connection.resolve(connection) : undefined,
      )
    })
    const resolveWithInfo = Effect.fn("SessionRunnerModel.resolveWithInfo")(function* (
      session: SessionSchema.Info,
      requestedRouteIntent?: ProviderRouteIntent.Info,
    ) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })

        const legacyAccountID = yield* canonicalLegacyAccountID(session.model?.accountID)
        if (session.model?.accountID?.startsWith("cred_") && legacyAccountID === undefined) {
          return yield* new RouteUnavailableError({
            providerID: selected.providerID,
            modelID: selected.id,
            reason: "Selected OpenCode credential cannot be projected to a stable ProviderAccount identity",
          })
        }
        const routeIntent = yield* ProviderRouteIntentRuntime.normalize({
          routeIntent: requestedRouteIntent ?? session.model?.routeIntent,
          ...(legacyAccountID ? { legacyAccountID } : {}),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new RouteUnavailableError({
                providerID: selected.providerID,
                modelID: selected.id,
                reason: routeReason(cause),
              }),
          ),
        )
        const allowPublic = selected.providerID === ProviderV2.ID.opencode
        const publicEligible = allowPublic ? yield* publicEligibility(selected) : false
        const affinityDomain = OpencodeProviderRoute.affinityDomain(selected.providerID)
        let routed = yield* providerRoutes
          .resolveIfApplicable({
            sessionID: session.id,
            providerID: selected.providerID,
            modelID: selected.id,
            affinityDomain,
            routeIntent,
            mode: OpencodeProviderRoute.routingMode(selected.providerID, routeIntent),
            freeRoutePreference: OpencodeProviderRoute.freeRoutePreference(selected.providerID, routeIntent),
            allowPublic,
            publicEligible,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteUnavailableError({
                  providerID: selected.providerID,
                  modelID: selected.id,
                  reason: routeReason(cause),
                }),
            ),
          )

        if (routed?.lease.route.kind === "public") {
          if (!publicEligible) {
            return yield* new RouteUnavailableError({
              providerID: selected.providerID,
              modelID: selected.id,
              reason: "Committed Public route is not eligible for this hosted model",
            })
          }
          const model = yield* resolve(session, publicModel(selected))
          return {
            model,
            name: selected.name,
            route: routed.attribution,
            lease: routed.lease,
          } satisfies ResolvedInfo
        }

        if (routed?.lease.route.kind === "account") {
          const lease = routed.lease.route
          let execution = yield* providerRoutes
            .resolveExecution({
              providerID: lease.providerID,
              accountID: lease.accountID,
              credentialHandle: lease.credentialHandle,
              modelID: selected.id,
              expectedCredentialRevision: lease.credentialRevision,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new RouteUnavailableError({
                    providerID: selected.providerID,
                    modelID: selected.id,
                    reason: routeReason(cause),
                  }),
              ),
            )
          if (!execution) {
            // Refresh may advance credential revision without changing the
            // durable ProviderRoute. Recompile that same binding once from P2,
            // then materialize the new exact generation. Existing route
            // stickiness means this does not perform a second account choice.
            const refreshed = yield* providerRoutes
              .compileExisting({
                sessionID: session.id,
                providerID: selected.providerID,
                modelID: selected.id,
                affinityDomain,
                // The committed attribution is now the authority. P2 may
                // advance credential revision, but this refresh is not allowed
                // to re-enter account/public selection or failover.
                routeIntent: { kind: "auto" },
                mode: "concentrate",
                freeRoutePreference: "public-first-for-free",
                allowPublic,
                publicEligible,
                expected: routed.attribution,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new RouteUnavailableError({
                      providerID: selected.providerID,
                      modelID: selected.id,
                      reason: routeReason(cause),
                    }),
                ),
              )
            if (refreshed.lease.route.kind !== "account") {
              return yield* new RouteUnavailableError({
                providerID: selected.providerID,
                modelID: selected.id,
                reason: "Committed account route changed kind during exact transport materialization",
              })
            }
            routed = refreshed
            execution = yield* providerRoutes
              .resolveExecution({
                providerID: refreshed.lease.route.providerID,
                accountID: refreshed.lease.route.accountID,
                credentialHandle: refreshed.lease.route.credentialHandle,
                modelID: selected.id,
                expectedCredentialRevision: refreshed.lease.route.credentialRevision,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new RouteUnavailableError({
                      providerID: selected.providerID,
                      modelID: selected.id,
                      reason: routeReason(cause),
                    }),
                ),
              )
          }
          if (!execution) {
            return yield* new RouteUnavailableError({
              providerID: selected.providerID,
              modelID: selected.id,
              reason: "Committed account lease changed before exact transport materialization",
            })
          }
          const capability = execution.capabilities.providers[selected.providerID]
          const exact = capability ? OpencodeAccountModel.compile(selected, capability, selected.id) : undefined
          if (!exact) {
            return yield* new RouteUnavailableError({
              providerID: selected.providerID,
              modelID: selected.id,
              reason: "Committed account no longer serves the selected model",
            })
          }
          const model = yield* resolve(session, exact, execution.credential)
          return {
            model,
            name: selected.name,
            route: routed.attribution,
            lease: routed.lease,
          } satisfies ResolvedInfo
        }

        const model = yield* resolve(
          session,
          selected,
          yield* directCredential(selected.providerID),
        )
        return { model, name: selected.name } satisfies ResolvedInfo
      })
    const directCredential = Effect.fnUntraced(function* (providerID: ProviderV2.ID) {
      const provider = yield* catalog.provider.get(providerID)
      const connection = yield* integrations.connection.active(
        provider?.integrationID ?? Integration.ID.make(providerID),
      )
      return connection ? yield* integrations.connection.resolve(connection) : undefined
    })

    /**
     * Non-durable session identity for transient maintenance attribution when
     * no parent Session exists. Never persisted: settlement only reads
     * routeKind/accountID, and revision 0 marks "no durable generation".
     */
    const TRANSIENT_MAINTENANCE_SESSION_ID = SessionSchema.ID.make("ses_maintenance_transient")

    // Names the session's current worker selection for model-less maintenance:
    // catalog default, then first supported model. Mirrors worker selection so
    // the authority stays in one place; always non-explicit maintenance.
    const inheritWorkerSelection = Effect.fnUntraced(function* (session: SessionSchema.Info | undefined) {
      if (session === undefined)
        return yield* Effect.die("SessionRunnerModel.resolveMaintenance requires a session or model ref")
      const catalogDefault = yield* catalog.model.default()
      const usable = (model: ModelV2.Info | undefined) =>
        model !== undefined && supported(model) ? model : undefined
      const fallback =
        (usable(catalogDefault) ? catalogDefault : undefined) ??
        (yield* catalog.model.available()).find((model) => usable(model))
      if (!fallback) return yield* new ModelNotSelectedError({ sessionID: session.id })
      return ModelV2.Ref.make({ providerID: fallback.providerID, id: fallback.id })
    })

    const resolveMaintenanceWithInfo = Effect.fn("SessionRunnerModel.resolveMaintenanceWithInfo")(function* (
      session: SessionSchema.Info | undefined,
      ref: ModelV2.Ref | undefined,
      options?: MaintenanceOptions,
    ) {
        const explicitOverride = ref !== undefined && (options?.explicitOverride ?? false)
        // A missing ref inherits the session's current worker selection,
        // always as non-explicit maintenance.
        ref = ref ?? session?.model ?? (yield* inheritWorkerSelection(session))
        const selected = (yield* catalog.model.available()).find(
          (model) => model.providerID === ref.providerID && model.id === ref.id,
        )
        if (!selected)
          return yield* new ModelUnavailableError({
            providerID: ref.providerID,
            modelID: ref.id,
          })

        const failRoute = (reason: string) =>
          new RouteUnavailableError({
            providerID: selected.providerID,
            modelID: selected.id,
            reason,
          })
        const legacyAccountID = yield* canonicalLegacyAccountID(ref.accountID)
        if (ref.accountID?.startsWith("cred_") && legacyAccountID === undefined) {
          return yield* failRoute(
            "Selected OpenCode credential cannot be projected to a stable ProviderAccount identity",
          )
        }
        const routeIntent = yield* ProviderRouteIntentRuntime.normalize({
          ...(legacyAccountID ? { legacyAccountID } : {}),
        }).pipe(Effect.mapError((cause) => failRoute(routeReason(cause))))
        const affinityDomain = OpencodeProviderRoute.affinityDomain(selected.providerID)
        // Unlike worker turns, host-owned maintenance cannot use the upstream
        // OpenCode-only Public/free tier. Preserve all account-backed routes.
        const allowPublic = false
        const publicEligible = allowPublic ? yield* publicEligibility(selected) : false

        // Exact transport materialization for an already-resolved account
        // lease. Returns undefined when the lease no longer materializes so
        // the caller can refresh once from the same binding; never binds,
        // rebinds, or fails over.
        const resolveAccountExecution = (input: {
          readonly providerID: string
          readonly accountID: string
          readonly credentialHandle: string
          readonly credentialRevision: number
        }) =>
          providerRoutes
            .resolveExecution({
              providerID: input.providerID,
              accountID: input.accountID,
              credentialHandle: input.credentialHandle,
              modelID: selected.id,
              expectedCredentialRevision: input.credentialRevision,
            })
            .pipe(Effect.mapError((cause) => failRoute(routeReason(cause))))
        const compileAccountModel = (execution: ExecutionMaterialization) => {
          const capability = execution.capabilities.providers[selected.providerID]
          return capability ? OpencodeAccountModel.compile(selected, capability, selected.id) : undefined
        }

        // Host-owned maintenance inherits the parent Session's existing exact
        // route generation. The committed attribution is the authority: this
        // path never re-enters account/public selection or failover.
        if (session && !explicitOverride) {
          const current = yield* routes.get(session.id, affinityDomain)
          if (current !== undefined &&
              !(selected.providerID === ProviderV2.ID.opencode && current.routeKind === "public")) {
            const pinnedAccountID = legacyAccountID ?? ref.accountID
            if (
              pinnedAccountID !== undefined &&
              (current.routeKind !== "account" || current.accountID !== pinnedAccountID)
            ) {
              return yield* failRoute("Maintenance model account pin does not match the committed session route")
            }
            const expected = {
              sessionID: session.id,
              affinityDomain,
              providerID: selected.providerID,
              routeRevision: current.routeRevision,
              routeKind: current.routeKind,
              ...(current.routeKind === "account" ? { accountID: current.accountID } : {}),
            } satisfies ProviderRouteResolution.RouteAttribution
            const compileArgs = {
              sessionID: session.id,
              providerID: selected.providerID,
              modelID: selected.id,
              affinityDomain,
              // The committed attribution is now the authority. This inherit
              // is not allowed to re-enter account/public selection or
              // failover.
              routeIntent: { kind: "auto" },
              mode: "concentrate",
              freeRoutePreference: "public-first-for-free",
              allowPublic,
              publicEligible,
            } as const
            const inherited = yield* providerRoutes
              .compileExisting({ ...compileArgs, expected })
              .pipe(Effect.mapError((cause) => failRoute(routeReason(cause))))

            if (inherited.lease.route.kind === "public") {
              if (selected.providerID === ProviderV2.ID.opencode)
                return yield* failRoute("Hosted Public free tier cannot execute OpenFork special agents")
              if (!publicEligible) {
                return yield* failRoute("Committed Public route is not eligible for this hosted model")
              }
              const model = yield* resolveWithVariant(ref.variant, publicModel(selected), undefined)
              return {
                model,
                name: selected.name,
                route: inherited.attribution,
                lease: inherited.lease,
              } satisfies ResolvedInfo
            }

            const inheritAccount = inherited.lease.route
            if (inheritAccount.kind !== "account") {
              return yield* failRoute("Committed account route changed kind during exact transport materialization")
            }
            let attribution = inherited.attribution
            let lease = inherited.lease
            let execution = yield* resolveAccountExecution(inheritAccount)
            if (!execution) {
              // Refresh may advance credential revision without changing the
              // durable ProviderRoute. Recompile that same binding once from
              // the inherited attribution, then materialize the new exact
              // generation. Existing route stickiness means this does not
              // perform a second account choice.
              const refreshed = yield* providerRoutes
                .compileExisting({ ...compileArgs, expected: inherited.attribution })
                .pipe(Effect.mapError((cause) => failRoute(routeReason(cause))))
              const refreshAccount = refreshed.lease.route
              if (refreshAccount.kind !== "account") {
                return yield* failRoute("Committed account route changed kind during exact transport materialization")
              }
              attribution = refreshed.attribution
              lease = refreshed.lease
              execution = yield* resolveAccountExecution(refreshAccount)
            }
            if (!execution) {
              return yield* failRoute("Committed account lease changed before exact transport materialization")
            }
            const exact = compileAccountModel(execution)
            if (!exact) {
              return yield* failRoute("Committed account no longer serves the selected model")
            }
            const model = yield* resolveWithVariant(ref.variant, exact, execution.credential)
            return {
              model,
              name: selected.name,
              route: attribution,
              lease,
            } satisfies ResolvedInfo
          }
        }

        // No binding to inherit (or an explicit override, or no session): one
        // non-persistent route in the ref's own provider domain. This creates
        // no durable row, revision, cursor, or sticky affinity.
        const transient = yield* providerRoutes
          .resolveTransient({
            providerID: selected.providerID,
            modelID: selected.id,
            routeIntent,
            mode: "concentrate",
            freeRoutePreference: "public-first-for-free",
            allowPublic,
            publicEligible,
          })
          .pipe(Effect.mapError((cause) => failRoute(routeReason(cause))))

        if (transient === undefined) {
          if (selected.providerID === ProviderV2.ID.opencode || selected.providerID === ProviderV2.ID.make("opencode-go"))
            return yield* failRoute("No account-backed hosted route is available for this OpenFork special agent")
          // The route owner positively declines this provider/model: it is
          // outside the routing domain. Only then may maintenance use direct
          // provider lookup; hosted models never fall back to ambient auth.
          const model = yield* resolveWithVariant(
            ref.variant,
            selected,
            yield* directCredential(selected.providerID),
          )
          return { model, name: selected.name } satisfies ResolvedInfo
        }

        const transientAttribution = {
          sessionID: session?.id ?? TRANSIENT_MAINTENANCE_SESSION_ID,
          affinityDomain,
          providerID: selected.providerID,
          routeRevision: 0,
          routeKind: transient.route.kind,
          ...(transient.route.kind === "account" ? { accountID: transient.route.accountID } : {}),
        } satisfies ProviderRouteResolution.RouteAttribution

        if (transient.route.kind === "public") {
          if (selected.providerID === ProviderV2.ID.opencode)
            return yield* failRoute("Hosted Public free tier cannot execute OpenFork special agents")
          const model = yield* resolveWithVariant(ref.variant, publicModel(selected), undefined)
          return { model, name: selected.name, route: transientAttribution } satisfies ResolvedInfo
        }
        const transientAccount = transient.route
        if (transientAccount.kind !== "account") {
          return yield* failRoute("Transient route changed kind during exact transport materialization")
        }
        const execution = yield* resolveAccountExecution(transientAccount)
        if (!execution) {
          return yield* failRoute("Transient account lease changed before exact transport materialization")
        }
        const exact = compileAccountModel(execution)
        if (!exact) {
          return yield* failRoute("Transient account no longer serves the maintenance model")
        }
        const model = yield* resolveWithVariant(ref.variant, exact, execution.credential)
        return { model, name: selected.name, route: transientAttribution } satisfies ResolvedInfo
      })
    const resolveMaintenanceRef: Interface["resolveMaintenanceRef"] = (session, ref, options) =>
      resolveMaintenanceWithInfo(session, ref, options).pipe(Effect.map((value) => value.model))
    return Service.of({
      resolve: (session, routeIntent) =>
        resolveWithInfo(session, routeIntent).pipe(Effect.map((value) => value.model)),
      resolveWithInfo,
      resolveRef,
      resolveMaintenanceWithInfo,
      resolveMaintenanceRef,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [
    Catalog.node,
    Integration.node,
    Credential.node,
    CredentialResolver.node,
    ProviderRoute.node,
    ProviderRouteHealth.node,
    FSUtil.node,
    httpClientNode,
  ],
})
