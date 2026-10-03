import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Credential } from "@opencode-ai/core/credential"
import * as CredentialResolver from "@opencode-ai/core/credential/resolver"
import { integrationID as opencodeIntegrationID } from "@opencode-ai/core/plugin/provider/opencode-auth"
import { projectCredential } from "@opencode-ai/core/plugin/provider/opencode-provider-account"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Hash } from "@opencode-ai/core/util/hash"
import { httpClient as httpClientNode } from "@opencode-ai/core/effect/app-node-platform"
import { Auth } from "@/auth"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { isT3CodeCompatibilityProfile } from "@/compat/t3code"
import { projectT3CodeAccountModels } from "@/compat/t3code-provider"
import { serviceRealmID } from "@/server/shared/instance-identity"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { makeConsoleAccountExecutionResolver } from "./console-account-execution"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { ServerEvent } from "@opencode-ai/schema/server-event"
import { Context, Effect, Layer, Scope, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as ProviderCatalogContributions from "./catalog-contributions"
import {
  consoleModel,
  consoleProviderInfo,
  defaultModelIDs,
  fromConfigProvider,
  fromModelsDevProvider,
  toPublicInfo,
  type AccountModelProjection,
  type Info,
} from "./provider"

export type Status = "pending" | "partial" | "ready"

export interface Result {
  readonly all: Info[]
  readonly default: Record<string, string>
  readonly connected: string[]
  readonly catalog: { readonly status: Status; readonly revision: number }
}

export interface Interface {
  readonly list: (input: { readonly directory?: string; readonly config: typeof ConfigV1.Info.Type }) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderCatalog") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const modelsDev = yield* ModelsDev.Service
    const auth = yield* Auth.Service
    const credentials = yield* Credential.Service
    const credentialResolver = yield* CredentialResolver.Service
    const runtimeFlags = yield* RuntimeFlags.Service
    const http = yield* HttpClient.HttpClient
    const contributions = yield* ProviderCatalogContributions.Service
    const events = yield* EventV2.Service
    const ownerScope = yield* Scope.Scope
    const accountResolver = makeConsoleAccountExecutionResolver({
      realm: serviceRealmID(),
      credentials,
      resolver: credentialResolver,
      http,
      configHttp: withTransientReadRetry(http),
    })
    const revisions = new Map<string, number>()
    const accountSnapshots = new Map<
      string,
      {
        readonly fingerprint: string
        readonly revision: number
        readonly expiresAt: number
        readonly rows: readonly AccountModelProjection[]
        readonly ready: boolean
      }
    >()
    const accountRefreshes = new Set<string>()
    const accountRetryAfter = new Map<string, number>()
    const knownDirectories = new Set<string>()
    const MAX_ACCOUNT_CATALOG_LOCATIONS = 32
    const MAX_CONCURRENT_ACCOUNT_CATALOGS = 2
    const ACCOUNT_CATALOG_TTL_MS = 5 * 60_000
    let refreshStarted = false
    let refreshComplete = false

    const publishRevision = (directory: string | undefined, status: Status) =>
      Effect.gen(function* () {
        const key = directory ?? ""
        const revision = Math.max(revisions.get(key) ?? 0, contributions.get(key)?.revision ?? 0) + 1
        revisions.set(key, revision)
        yield* events.publish(ServerEvent.ProviderCatalogUpdated, {
          ...(directory ? { directory } : {}),
          revision,
          status,
        })
      })

    const refreshAccountModels = Effect.fn("ProviderCatalog.refreshAccountModels")(function* (input: {
      readonly key: string
      readonly fingerprint: string
      readonly credentials: readonly Credential.Info[]
      readonly providers: Record<string, Info>
      readonly enabled?: ReadonlySet<string>
      readonly disabled: ReadonlySet<string>
    }) {
      const accounts = input.credentials.flatMap((credential) => {
        const account = projectCredential(credential)
        return account ? [{ credential, account }] : []
      })
      const counts = new Map<string, number>()
      for (const item of accounts) counts.set(item.account.accountID, (counts.get(item.account.accountID) ?? 0) + 1)
      const unique = accounts.filter((item) => counts.get(item.account.accountID) === 1)
      const labelCounts = new Map<string, number>()
      const labelOf = (item: (typeof unique)[number]) =>
        item.account.label.trim() || item.account.metadata?.email?.trim() || item.account.accountID
      for (const item of unique) {
        const key = labelOf(item).normalize("NFKC").toLowerCase()
        labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1)
      }

      const resolved = yield* Effect.forEach(
        unique,
        (item) =>
          accountResolver
            .resolve(item.credential.id)
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.map((execution) => {
                if (!execution) return { rows: [] as AccountModelProjection[], complete: false }
                const label = labelOf(item)
                const labelKey = label.normalize("NFKC").toLowerCase()
                const accountLabel = (labelCounts.get(labelKey) ?? 0) > 1
                  ? `${label} #${item.account.accountID.slice(-6)}`
                  : label
                const result: AccountModelProjection[] = []
                for (const [rawProviderID, capability] of Object.entries(execution.capabilities.providers)) {
                  if ((input.enabled && !input.enabled.has(rawProviderID)) || input.disabled.has(rawProviderID)) continue
                  const providerID = ProviderV2.ID.make(rawProviderID)
                  const baseProvider = input.providers[providerID]
                  for (const rawModelID of Object.keys(capability.models)) {
                    const modelID = ModelV2.ID.make(rawModelID)
                    const model = consoleModel(providerID, modelID, capability, baseProvider?.models[modelID])
                    if (!model || model.status === "deprecated") continue
                    if (model.status === "alpha" && !runtimeFlags.enableExperimentalModels) continue
                    result.push({
                      accountID: item.account.accountID,
                      accountLabel,
                      provider: consoleProviderInfo(providerID, capability, model, baseProvider),
                      model,
                    })
                  }
                }
                return { rows: result, complete: true }
              }),
              // Preserve the runtime producer's behavior: one unavailable or
              // stale account cannot hide other account-specific model rows.
              Effect.catchCause(() => Effect.succeed({ rows: [] as AccountModelProjection[], complete: false })),
            ),
        { concurrency: 4 },
      )
      const prior = accountSnapshots.get(input.key)
      const snapshot = {
        fingerprint: input.fingerprint,
        revision: (prior?.revision ?? 0) + 1,
        expiresAt: Date.now() + ACCOUNT_CATALOG_TTL_MS,
        rows: resolved.flatMap((item) => item.rows),
        ready: resolved.every((item) => item.complete),
      } as const
      accountSnapshots.set(input.key, snapshot)
      accountRefreshes.delete(input.key)
      for (const directory of knownDirectories) yield* publishRevision(directory || undefined, "partial")
      return snapshot
    })

    // Credential owns the durable mutation. Observe its secret-free change
    // stream once for this service lifetime, discard only the T3 projection,
    // and invalidate each known directory so clients can request a fresh
    // catalog. The observer is scoped to this layer and converges on teardown.
    yield* Stream.runForEach(credentials.changes, (change) =>
      change.integrationID !== opencodeIntegrationID
        ? Effect.void
        : Effect.gen(function* () {
            accountSnapshots.clear()
            for (const directory of knownDirectories) {
              yield* publishRevision(directory || undefined, "partial")
            }
          }),
    ).pipe(Effect.forkScoped({ startImmediately: true }))

    return Service.of({
      list: Effect.fn("ProviderCatalog.list")(function* (input) {
        const directoryKey = input.directory ?? ""
        knownDirectories.delete(directoryKey)
        knownDirectories.add(directoryKey)
        while (knownDirectories.size > MAX_ACCOUNT_CATALOG_LOCATIONS) {
          const evicted = knownDirectories.values().next().value
          if (evicted === undefined) break
          knownDirectories.delete(evicted)
          accountSnapshots.delete(evicted)
          accountRetryAfter.delete(evicted)
        }
        const modelCatalog = yield* modelsDev.getCached().pipe(Effect.catchCause(() => Effect.succeed({})))
        const credentialIDs = Object.keys(yield* auth.all().pipe(Effect.orDie))
        // Env.Service is instance-scoped even though its current value starts
        // from process.env. A bootstrap-free catalog must read only the
        // process-level environment here.
        const environment = process.env
        const providerConfig = input.config.provider ?? {}
        const enabled = input.config.enabled_providers ? new Set(input.config.enabled_providers) : undefined
        const disabled = new Set(input.config.disabled_providers ?? [])
        const providers: Record<string, Info> = {}
        for (const [id, item] of Object.entries(modelCatalog)) {
          if ((enabled && !enabled.has(id)) || disabled.has(id)) continue
          providers[id] = fromModelsDevProvider(item)
        }
        for (const [id, config] of Object.entries(providerConfig)) {
          if ((enabled && !enabled.has(id)) || disabled.has(id)) continue
          providers[id] = fromConfigProvider(id, config, providers[id], modelCatalog)
        }

        const cached = contributions.get(input.directory ?? "")
        if (cached) Object.assign(providers, cached.providers)

        let accountSnapshot = accountSnapshots.get(directoryKey)
        if (isT3CodeCompatibilityProfile()) {
          const storedCredentials = yield* credentials.list(opencodeIntegrationID)
          const fingerprint = Hash.fast(
            JSON.stringify({
              credentials: storedCredentials
                .map((item) => [item.id, item.label, item.revision])
                .sort(([a], [b]) => String(a).localeCompare(String(b))),
              config: providerConfig,
              enabled: input.config.enabled_providers ?? null,
              disabled: input.config.disabled_providers ?? [],
            }),
          )
          const previous = accountSnapshots.get(directoryKey)
          if (
            (previous?.fingerprint !== fingerprint || previous?.ready !== true || Date.now() >= (previous?.expiresAt ?? 0)) &&
            !accountRefreshes.has(directoryKey) &&
            accountRefreshes.size < MAX_CONCURRENT_ACCOUNT_CATALOGS &&
            Date.now() >= (accountRetryAfter.get(directoryKey) ?? 0)
          ) {
            accountRefreshes.add(directoryKey)
            const accountProviders = Object.fromEntries(
              Object.entries(providers).map(([id, provider]) => [id, { ...provider, models: { ...provider.models } }]),
            )
            yield* refreshAccountModels({
              key: directoryKey,
              fingerprint,
              credentials: storedCredentials,
              providers: accountProviders,
              enabled,
              disabled,
            }).pipe(
              Effect.tap((snapshot) =>
                Effect.sync(() => {
                  if (snapshot.ready) accountRetryAfter.delete(directoryKey)
                  else accountRetryAfter.set(directoryKey, Date.now() + 30_000)
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("provider account catalog refresh failed", { cause }).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      accountRefreshes.delete(directoryKey)
                      accountRetryAfter.set(directoryKey, Date.now() + 30_000)
                    }),
                  ),
                ),
              ),
              Effect.forkIn(ownerScope),
            )
          }
          accountSnapshot = accountSnapshots.get(directoryKey)
          if (accountSnapshot?.fingerprint !== fingerprint || accountSnapshot.ready !== true) accountSnapshot = undefined
        }

        let compatibilityConnected: ReadonlySet<string> | undefined
        if (isT3CodeCompatibilityProfile() && accountSnapshot?.rows.length) {
          const projection = projectT3CodeAccountModels(providers, accountSnapshot.rows)
          Object.assign(providers, projection.providers)
          compatibilityConnected = projection.connected
        }

        const connected = new Set<string>(credentialIDs)
        for (const [id, provider] of Object.entries(providers)) {
          if (providerConfig[id]) connected.add(id)
          if (provider.env.some((name) => !!environment[name])) connected.add(id)
        }
        for (const providerID of compatibilityConnected ?? []) connected.add(providerID)
        const baselineAvailable =
          Object.keys(providers).length > 0 || credentialIDs.some((id) => id in providers)
        const result: Result = {
          all: Object.values(providers).map((provider) => toPublicInfo(provider)),
          default: defaultModelIDs(providers),
          connected: [...connected].filter((id) => id in providers),
          catalog: {
            status:
              cached?.status === "ready" && (!isT3CodeCompatibilityProfile() || accountSnapshot?.ready)
                ? "ready"
                : baselineAvailable || refreshComplete || cached || accountSnapshot
                  ? "partial"
                  : "pending",
            revision: Math.max(
              cached?.revision ?? 0,
              revisions.get(directoryKey) ?? 0,
              accountSnapshot?.revision ?? 0,
            ),
          },
        }

        if (Object.keys(modelCatalog).length === 0 && !refreshStarted) {
          refreshStarted = true
          yield* modelsDev.get().pipe(
            Effect.ignore,
            Effect.tap(() => Effect.sync(() => (refreshComplete = true))),
            Effect.andThen(publishRevision(undefined, "partial")),
            Effect.forkDetach,
          )
        }
        return result
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    ModelsDev.node,
    Auth.node,
    Credential.node,
    CredentialResolver.node,
    RuntimeFlags.node,
    ProviderCatalogContributions.node,
    EventV2.node,
    httpClientNode,
  ],
})
