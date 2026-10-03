export * as SystemOne from "./system-one"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { requestExecutor as requestExecutorNode } from "@opencode-ai/core/effect/app-node-platform"
import { Flag } from "@opencode-ai/core/flag/flag"
import { OpenCodeHostedUserAgent } from "@opencode-ai/core/installation/version"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { Hash } from "@opencode-ai/core/util/hash"
import { SystemOne as Contract } from "@opencode-ai/schema/system-one"
import { LLMError } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { SystemOneClient } from "@opencode-ai/llm/system-one"
import { Provider } from "@/provider/provider"
import { MessageID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"

export type Error =
  | Provider.ModelNotFoundError
  | Provider.AccountResolutionError
  | Provider.RouteResolutionError
  | Provider.UnsupportedModelPrimitiveError
  | LLMError

function stringHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function pricing(model: Provider.Model, inputTokens: number) {
  const tier =
    model.cost.tiers
      ?.filter((item) => item.tier.type === "context" && inputTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (model.cost.experimentalOver200K && inputTokens > 200_000 ? model.cost.experimentalOver200K : model.cost)
  return tier
}

function cost(model: Provider.Model, usage: Contract.Usage): Contract.Cost {
  const rate = pricing(model, usage.input_tokens)
  const input = (usage.input_tokens * rate.input) / 1_000_000
  const output = (usage.output_tokens * rate.output) / 1_000_000
  return { input, output, total: input + output }
}

/**
 * Console wants a Session-shaped stable routing token, but semantic inference
 * must not create or own a durable OpenFork Session. Hash the caller's opaque
 * semantic affinity key into that transport namespace; one-off calls get a
 * fresh non-persisted token.
 */
export function semanticSessionID(affinityID: string | undefined): SessionV2.ID {
  const value = affinityID?.trim()
  if (!value) return SessionV2.ID.create()
  return SessionV2.ID.make(`ses_sem_${Hash.sha256(value).slice(0, 32)}`)
}

export interface Interface {
  readonly infer: (input: Contract.InferInput) => Effect.Effect<Contract.InferResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemOne") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const requestExecutor = yield* RequestExecutor.Service

    const infer = Effect.fn("SystemOne.infer")(function* (input: Contract.InferInput) {
      // One authoritative transient route decision for a standalone semantic
      // inference. `affinityID` stays a caller-owned remote/cache affinity key
      // and never participates in route authority.
      const accountID = input.accountID
        ? yield* provider.resolveAccountID(input.providerID, input.accountID)
        : undefined
      const routed = yield* provider.resolveTransientRoutedModel({
        providerID: input.providerID,
        modelID: input.modelID,
        ...(accountID ? { accountID } : {}),
        ...(input.routeIntent ? { routeIntent: input.routeIntent } : {}),
      })

      // Hosted OpenCode providers are owned by the transient resolver, so an
      // unresolved hosted request fails closed. Falling back to ambient
      // provider config, env credentials, or the default Zen account here would
      // create exactly the second authorization surface this cutover removes.
      if (Provider.isHostedZenProvider(input.providerID) && !routed) {
        return yield* new Provider.RouteResolutionError({
          providerID: input.providerID,
          modelID: input.modelID,
          cause: new Error("No authoritative OpenCode route resolved for this hosted System One request"),
        })
      }

      // A resolved route is final authority for model, provider, and transport.
      // For providers the OpenCode routing domain does not own, the mature
      // direct-provider path still applies unchanged.
      const model = routed?.model ?? (yield* provider.getModel(input.providerID, input.modelID, accountID))
      const primitive = Provider.modelPrimitive(model)
      if (primitive !== "system-one") {
        return yield* new Provider.UnsupportedModelPrimitiveError({
          providerID: model.providerID,
          modelID: model.id,
          primitive,
          required: "system-one",
        })
      }

      let wireModelID: string
      let baseURL: string
      let headers: Record<string, string>
      let apiKey: string | undefined
      if (routed) {
        wireModelID = model.api.id
        baseURL = routed.transport.baseURL
        headers = { ...routed.transport.headers }
        apiKey = routed.transport.apiKey
      } else {
        const info = yield* provider.getProvider(model.providerID)
        const options = { ...info.options, ...model.options }
        wireModelID = model.api.id
        baseURL =
          (typeof options.baseURL === "string" && options.baseURL.trim() ? options.baseURL : undefined) ?? model.api.url
        headers = {
          ...stringHeaders(options.headers),
          ...model.headers,
        }
        apiKey =
          (typeof options.apiKey === "string" && options.apiKey ? options.apiKey : undefined) ??
          (typeof info.key === "string" && info.key ? info.key : undefined)
      }

      if (Provider.isHostedZenProvider(model.providerID)) {
        const client = Flag.OPENCODE_CLIENT
        const instance = yield* InstanceRef
        headers["User-Agent"] = OpenCodeHostedUserAgent()
        headers["x-opencode-client"] = client
        headers["x-opencode-session"] = semanticSessionID(input.affinityID)
        headers["x-opencode-request"] = MessageID.ascending()
        if (instance?.project.id) headers["x-opencode-project"] = instance.project.id
      }

      if (apiKey) {
        if (Provider.isHostedZenProvider(model.providerID) || headers.authorization === undefined) {
          headers.authorization = `Bearer ${apiKey}`
        }
      }

      const output = yield* SystemOneClient.infer({
        baseURL,
        model: wireModelID,
        state: input.state,
        questions: input.questions,
        headers,
        timeoutMs: input.timeoutMs,
      }).pipe(
        Effect.provideService(RequestExecutor.Service, requestExecutor),
        Effect.tapError((error) => {
          if (!routed) return Effect.void
          const http = "http" in error.reason ? error.reason.http : undefined
          return Effect.logDebug("system-one routed request failed", {
            providerID: model.providerID,
            modelID: model.id,
            routeKind: routed.route.route.kind,
            ...(routed.route.route.kind === "account" ? { accountID: routed.route.route.accountID } : {}),
            status: http?.response?.status,
          })
        }),
      )

      if (routed) {
        // Secret-free validation evidence only. Durable route health requires a
        // committed ProviderRouteLease, and a standalone semantic inference has
        // none: fabricating one would invent route/Session authority.
        yield* Effect.logDebug("system-one routed request completed", {
          providerID: model.providerID,
          modelID: model.id,
          routeKind: routed.route.route.kind,
          ...(routed.route.route.kind === "account" ? { accountID: routed.route.route.accountID } : {}),
          status: 200,
        })
      }
      const result: Contract.InferResult = {
        ...output,
        cost: cost(model, output.usage),
      }
      yield* Effect.logDebug("system-one inference", {
        providerID: model.providerID,
        modelID: model.id,
        ...(routed
          ? {
              routeKind: routed.route.route.kind,
              ...(routed.route.route.kind === "account" ? { accountID: routed.route.route.accountID } : {}),
            }
          : {}),
        questions: Object.keys(input.questions).length,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        cost: result.cost.total,
      })
      return result
    })

    return Service.of({ infer })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Provider.node, requestExecutorNode],
})
