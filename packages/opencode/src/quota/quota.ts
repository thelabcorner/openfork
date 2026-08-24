export * as Quota from "./quota"

import { Context, Effect, Exit, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { HttpClient } from "effect/unstable/http"
import { Auth } from "@/auth"
import { ForkCredentials } from "@/fork/credentials"
import type { ProviderResult, ProvidersResult } from "./schema"
import { createSingleFlight, resolveAdapter, type Adapter } from "./registry"
import { deepseek } from "./providers/deepseek"
import { kimi } from "./providers/kimi"
import { opencodeGo } from "./providers/opencode-go"
import { openrouter } from "./providers/openrouter"
import { claude } from "./providers/claude"
import { codex } from "./providers/codex"
import { xai } from "./providers/xai"
import { nvidia } from "./providers/nvidia"

export { UsageWindow, ProviderUsage, ProviderResult, ProviderSummary, ProvidersResult } from "./schema"

/**
 * Proactive provider-account quota reads, ported from OpenChamber's quota
 * tracker (MIT). Deliberately separate from Usage.Service (historical local
 * session analytics) and from SessionRetry (authoritative provider-failure
 * handling): quota results are advisory display state only — fetches fold
 * every failure into an ok=false result and never gate inference.
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

const layer: Layer.Layer<Service, never, Auth.Service | ForkCredentials.Service | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const credentials = yield* ForkCredentials.Service
    const http = yield* HttpClient.HttpClient
    const adapters: readonly Adapter[] = [
      opencodeGo(auth, credentials),
      openrouter(http, auth),
      kimi(http, auth),
      deepseek(http, auth),
      claude(http, auth),
      codex(http, auth),
      xai(http, auth),
      nvidia(http, auth),
    ]
    const singleFlight = createSingleFlight()

    const providers = Effect.fn("Quota.providers")(function* () {
      const summaries = yield* Effect.forEach(
        adapters,
        (adapter) =>
          Effect.map(Effect.exit(adapter.configured()), (exit) => ({
            providerId: adapter.id,
            providerName: adapter.name,
            configured: Exit.isSuccess(exit) ? exit.value : false,
          })),
        { concurrency: "unbounded" },
      )
      return { providers: summaries }
    })

    const get = Effect.fn("Quota.get")(function* (input: { readonly providerID: string }) {
      const adapter = resolveAdapter(adapters, input.providerID)
      if (!adapter) return yield* Effect.fail(new QuotaProviderNotFoundError({ providerID: input.providerID }))
      return yield* singleFlight(adapter.id, adapter.fetch())
    })

    return Service.of({ providers, get })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Auth.node, ForkCredentials.node, httpClient] })
