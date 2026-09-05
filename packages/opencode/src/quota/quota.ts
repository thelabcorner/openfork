export * as Quota from "./quota"

import { Context, Effect, Exit, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { HttpClient } from "effect/unstable/http"
import { Auth } from "@/auth"
import { ForkCredentials } from "@/fork/credentials"
import * as VerdentFreeUsage from "@/usage/verdent-free"
import * as ZenFreeUsage from "@/usage/zen-free"
import type { ProviderResult, ProvidersResult } from "./schema"
import { createSingleFlight, resolveAdapter, type Adapter } from "./registry"
import { deepseek } from "./providers/deepseek"
import { genspark } from "./providers/genspark"
import { kimi } from "./providers/kimi"
import { opencodeGo } from "./providers/opencode-go"
import { opencodeZen } from "./providers/opencode-zen"
import { verdent } from "./providers/verdent"
import { openrouter } from "./providers/openrouter"
import { claude } from "./providers/claude"
import { codex } from "./providers/codex"
import { xai } from "./providers/xai"
import { nvidia } from "./providers/nvidia"
import { workbuddy } from "./providers/workbuddy"

export { UsageWindow, ProviderUsage, ProviderResult, ProviderSummary, ProvidersResult } from "./schema"

/**
 * Proactive provider-account quota reads, ported from OpenChamber's quota
 * tracker (MIT). Deliberately separate from the generic Usage.Service
 * historical analytics and from SessionRetry's authoritative provider-failure
 * handling: quota results are advisory display state only and never gate
 * inference. OpenCode Zen is the one local usage-backed quota source because
 * its anonymous free limit has no provider usage endpoint.
 */

export class QuotaProviderNotFoundError extends Schema.TaggedErrorClass<QuotaProviderNotFoundError>()(
  "QuotaProviderNotFoundError",
  { providerID: Schema.String },
) {}

export interface Interface {
  /** Lists every registered quota source with its cheap configured check. */
  readonly providers: () => Effect.Effect<ProvidersResult>
  /** Fetches one provider's account quota; same-ID calls single-flight. */
  readonly get: (input: { readonly providerID: string }) => Effect.Effect<ProviderResult, QuotaProviderNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Quota") {}

const layer: Layer.Layer<
  Service,
  never,
  Auth.Service | ForkCredentials.Service | HttpClient.HttpClient | ZenFreeUsage.Service | VerdentFreeUsage.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const credentials = yield* ForkCredentials.Service
    const http = yield* HttpClient.HttpClient
    const zenFreeUsage = yield* ZenFreeUsage.Service
    const verdentFreeUsage = yield* VerdentFreeUsage.Service
    const adapters: readonly Adapter[] = [
      opencodeGo(auth, credentials),
      opencodeZen(zenFreeUsage),
      verdent(verdentFreeUsage),
      openrouter(http, auth),
      kimi(http, auth),
      deepseek(http, auth),
      genspark(http, auth),
      claude(http, auth),
      codex(http, auth),
      xai(http, auth),
      nvidia(auth),
      workbuddy(),
    ]
    const singleFlight = createSingleFlight()
    // 30s cache for provider list - configured checks involve file I/O (claude token file, workbuddy vault scan)
    // and the list rarely changes (only on auth add/remove). This makes second Limits open instant.
    let providersCache: { at: number; value: ProvidersResult } | undefined
    const PROVIDERS_TTL_MS = 30_000

    const providers = Effect.fn("Quota.providers")(function* () {
      const now = Date.now()
      if (providersCache && now - providersCache.at < PROVIDERS_TTL_MS) return providersCache.value
      const summaries = yield* Effect.forEach(
        adapters,
        (adapter) =>
          Effect.map(Effect.exit(adapter.configured()), (exit) => ({
            providerId: adapter.id,
            providerName: adapter.name,
            configured: Exit.isSuccess(exit) ? exit.value : false,
          })),
        { concurrency: 4 },
      )
      const result = { providers: summaries }
      providersCache = { at: now, value: result }
      return result
    })

    const get = Effect.fn("Quota.get")(function* (input: { readonly providerID: string }) {
      const adapter = resolveAdapter(adapters, input.providerID)
      if (!adapter) return yield* Effect.fail(new QuotaProviderNotFoundError({ providerID: input.providerID }))
      return yield* singleFlight(adapter.id, adapter.fetch())
    })

    return Service.of({ providers, get })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Auth.node, ForkCredentials.node, httpClient, ZenFreeUsage.node, VerdentFreeUsage.node],
})
