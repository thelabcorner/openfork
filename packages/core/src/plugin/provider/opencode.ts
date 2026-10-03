import { Effect, Schema, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import type { CredentialValue } from "@opencode-ai/sdk/v2/types"
import { HttpClient } from "effect/unstable/http"
import { EventV2 } from "../../event"
import { FSUtil } from "../../fs-util"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { ConfigProviderV1 } from "../../v1/config/provider"
import { ConfigProviderOptionsV1 } from "../../v1/config/provider-options"
import { ConfigV1 } from "../../v1/config/config"
import { DEFAULT_SERVER, getProviderConfig } from "./opencode-console"
import { integrationID, keyMethod, oauth } from "./opencode-auth"
import { isHostedPublicModel, refreshHostedCatalog } from "./opencode-hosted"

export const OpencodePlugin = define<HttpClient.HttpClient | EventV2.Service | FSUtil.Service | Scope.Scope>({
  id: "opencode",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const http = yield* HttpClient.HttpClient
    const loading = Semaphore.makeUnsafe(1)
    let connected = false
    let catalogHasKey = false
    let needsHostedWitness = true
    let providers: typeof ConfigV1.Info.Type.provider | undefined

    const load = Effect.fn("OpencodePlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active("opencode")
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      connected = connection !== undefined
      providers = credential
        ? yield* fetchProviders(http, credential).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to load OpenCode provider config", { cause }).pipe(Effect.as(undefined)),
            ),
          )
        : undefined
      if (!connection && !process.env.OPENCODE_API_KEY && !catalogHasKey) {
        yield* refreshHostedCatalog(http, fs)
      }
    })

    yield* ctx.integration.transform((draft) => {
      draft.update("opencode", (integration) => {
        integration.name = "OpenCode Console"
      })
      draft.method.update(oauth(http))
      draft.method.update({ integrationID, method: keyMethod })
    })

    connected = (yield* ctx.integration.connection.active("opencode")) !== undefined
    yield* ctx.catalog.transform((catalog) => {
      for (const [providerID, item] of Object.entries(providers ?? {})) {
        catalog.provider.update(providerID, (provider) => {
          provider.integrationID = Integration.ID.make("opencode")
          if (item.name !== undefined) provider.name = item.name
          provider.api = item.npm
            ? { type: "aisdk", package: item.npm, url: item.api }
            : { type: "native", url: item.api, settings: {} }
          Object.assign(provider.request.headers, item.options?.headers)
          Object.assign(provider.request.body, withoutCredentials(item.options))
        })

        for (const [modelID, config] of Object.entries(item.models ?? {})) {
          catalog.model.update(providerID, modelID, (model) => {
            if (config.family !== undefined) model.family = config.family
            if (config.name !== undefined) model.name = config.name
            if (config.id !== undefined) model.api.id = config.id
            if (config.provider !== undefined) {
              model.api = config.provider.npm
                ? {
                    id: model.api.id,
                    type: "aisdk",
                    package: config.provider.npm,
                    url: config.provider.api,
                  }
                : { id: model.api.id, type: "native", url: config.provider.api, settings: {} }
            }
            if (config.tool_call !== undefined) model.capabilities.tools = config.tool_call
            if (config.modalities?.input !== undefined) model.capabilities.input = [...config.modalities.input]
            if (config.modalities?.output !== undefined) model.capabilities.output = [...config.modalities.output]
            const packageName = config.provider?.npm ?? item.npm
            const lowerer = ConfigProviderOptionsV1.get(packageName)
            Object.assign(model.request.headers, config.headers)
            Object.assign(model.request.body, lowerer.request(withoutCredentials(config.options)))
            if (config.variants !== undefined) {
              model.variants = Object.entries(config.variants).map(([id, options]) => ({
                id: ModelV2.VariantID.make(id),
                headers: { ...(options.headers ?? {}) },
                body: lowerer.request(withoutCredentials(options)),
              }))
            }
            if (config.release_date !== undefined) {
              const released = Date.parse(config.release_date)
              model.time.released = Number.isFinite(released) ? released : 0
            }
            if (config.cost !== undefined) {
              model.cost = remoteCost(config.cost)
            }
            model.status = config.status ?? "active"
            model.enabled = config.status !== "deprecated"
            if (config.limit !== undefined) model.limit = { ...config.limit }
          })
        }
      }

      const item = catalog.provider.get(ProviderV2.ID.opencode)
      if (!item) return
      catalogHasKey = typeof item.provider.request.body.apiKey === "string"
      const hasKey = Boolean(process.env.OPENCODE_API_KEY || connected || catalogHasKey)
      needsHostedWitness = !hasKey
      catalog.provider.update(item.provider.id, (provider) => {
        if (!hasKey) provider.request.body.apiKey = "public"
      })
      if (hasKey) return
      for (const model of item.models.values()) {
        if (
          isTrustedPublicCost(model) &&
          isHostedPublicModel({ id: model.id, apiID: model.api.id })
        ) {
          continue
        }
        catalog.model.update(item.provider.id, model.id, (draft) => {
          draft.enabled = false
        })
      }
    })

    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === Integration.ID.make("opencode")),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh().pipe(Effect.forkScoped)
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("5 minutes")
        if (!needsHostedWitness) continue
        yield* refreshHostedCatalog(http, fs)
        yield* ctx.catalog.reload()
      }
    }).pipe(Effect.forkScoped)
  }),
})

function fetchProviders(http: HttpClient.HttpClient, value: CredentialValue) {
  const metadata = value.metadata
  const server = typeof metadata?.server === "string" ? metadata.server : DEFAULT_SERVER
  const orgID = typeof metadata?.orgID === "string" ? metadata.orgID : undefined
  const token = value.type === "oauth" ? value.access : value.key
  return getProviderConfig(http, server, token, orgID).pipe(
    Effect.flatMap((config) =>
      config === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(ConfigV1.Info)(config).pipe(Effect.map((remote) => remote.provider)),
    ),
  )
}

function withoutCredentials(body: Readonly<Record<string, unknown>> | undefined) {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key !== "apiKey" && key !== "headers"))
}

/**
 * Anonymous/public eligibility must be proven by explicit pricing metadata.
 * Empty cost arrays are unknown, not free, and every published tier must have
 * zero input/output/cache charges. This keeps the V2 runner aligned with the
 * P0F public-lane safety contract instead of treating input-only-zero as free.
 */
export function isTrustedPublicCost(model: Pick<ModelV2.Info, "cost">) {
  return (
    model.cost.length > 0 &&
    model.cost.every(
      (entry) =>
        entry.input === 0 &&
        entry.output === 0 &&
        entry.cache.read === 0 &&
        entry.cache.write === 0,
    )
  )
}

function remoteCost(input: NonNullable<(typeof ConfigProviderV1.Model.Type)["cost"]>) {
  const base = {
    input: input.input,
    output: input.output,
    cache: { read: input.cache_read ?? 0, write: input.cache_write ?? 0 },
  }
  if (!input.context_over_200k) return [base]
  return [
    base,
    {
      tier: { type: "context" as const, size: 200_000 },
      input: input.context_over_200k.input,
      output: input.context_over_200k.output,
      cache: {
        read: input.context_over_200k.cache_read ?? 0,
        write: input.context_over_200k.cache_write ?? 0,
      },
    },
  ]
}
