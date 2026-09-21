import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient } from "effect/unstable/http"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Parameters as WebParameters } from "@/tool/web"
import { executeFetch } from "@/tool/webfetch"
import {
  callProvider,
  flagMap,
  providersOutput,
  selectWebSearchProvider,
  webSearchProviderLabel,
} from "@/tool/websearch"
import { OxpAuthority } from "./authority"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpResult } from "./result"

export const Parameters = WebParameters
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpWeb") {}
export const use = serviceUse(Service)

function actionOf(input: Input): "fetch" | "search" | "providers" {
  if (input.action) return input.action
  if (input.url) return "fetch"
  if (input.query) return "search"
  return "fetch"
}

function dependency(detail: string) {
  return new OxpError.DependencyUnavailable({ detail: OxpError.boundDetail(detail) })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service

    const execute = Effect.fn("OxpWeb.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP web request was cancelled" })
      const action = actionOf(input)
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: `integration.web.${action}`,
        phase: action === "providers" ? "discover" : "network",
      })
      const flagsByProvider = flagMap(flags)

      if (action === "providers") {
        if (input.url || input.query) {
          return yield* new OxpError.InvalidArgument({ detail: "web.providers does not accept url or query" })
        }
        const output = providersOutput(flagsByProvider)
        return {
          title: "Web search providers",
          output,
          structured: {
            providers: Object.entries(flagsByProvider).map(([provider, enabled]) => ({ provider, enabled })),
          },
          metadata: { action },
        } satisfies OxpResult.CapabilityResult
      }

      if (action === "fetch") {
        if (!input.url) return yield* new OxpError.InvalidArgument({ detail: "web.fetch requires url" })
        const fetched = yield* executeFetch(http, {
          url: input.url,
          format: input.format ?? "markdown",
          ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
        }).pipe(
          Effect.mapError((error) =>
            error.message.includes("URL must") || error.message.includes("too large")
              ? new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.message) })
              : dependency(`Web fetch failed: ${error.message}`),
          ),
        )
        yield* authority.revalidate(admission, "egress")
        if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP web request was cancelled" })
        return {
          title: fetched.title,
          output: fetched.output,
          metadata: {
            action,
            url: input.url,
            ...(fetched.attachments?.length ? { attachmentCount: fetched.attachments.length } : {}),
          },
        } satisfies OxpResult.CapabilityResult
      }

      if (!input.query) return yield* new OxpError.InvalidArgument({ detail: "web.search requires query" })
      const state = yield* config.get()
      const provider = selectWebSearchProvider(String(state.connector.id), flagsByProvider, input.provider)
      const result = yield* callProvider(
        http,
        provider,
        {
          action: "search",
          query: input.query,
          ...(input.numResults === undefined ? {} : { numResults: input.numResults }),
          ...(input.livecrawl === undefined ? {} : { livecrawl: input.livecrawl }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.contextMaxCharacters === undefined ? {} : { contextMaxCharacters: input.contextMaxCharacters }),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
        },
        { sessionID: `oxp:${state.connector.id}` },
      ).pipe(Effect.mapError((error) => dependency(`Web search failed: ${String(error)}`)))
      yield* authority.revalidate(admission, "egress")
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP web request was cancelled" })
      return {
        title: `${webSearchProviderLabel(provider)} \"${input.query}\"`,
        output: result ?? "No search results found. Please try a different query.",
        metadata: { action, provider },
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpConfig.node, LayerNodePlatform.httpClient, RuntimeFlags.node],
})

export * as OxpWeb from "./web"
