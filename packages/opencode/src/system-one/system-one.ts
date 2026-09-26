export * as SystemOne from "./system-one"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { requestExecutor as requestExecutorNode } from "@opencode-ai/core/effect/app-node-platform"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationUserAgent } from "@opencode-ai/core/installation/version"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { Hash } from "@opencode-ai/core/util/hash"
import { SystemOne as Contract } from "@opencode-ai/schema/system-one"
import { InvalidRequestReason, LLMError } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { SystemOneClient } from "@opencode-ai/llm/system-one"
import { Provider } from "@/provider/provider"
import { observeZenRequest, resolveZenRequest } from "@/plugin/zen"
import { MessageID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"

const ZEN_PROVIDERS = new Set(["opencode", "opencode-go"])

export type Error =
  | Provider.ModelNotFoundError
  | Provider.AccountResolutionError
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

function errorHttp(error: LLMError) {
  return "http" in error.reason ? error.reason.http : undefined
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
      const accountID = input.accountID
        ? yield* provider.resolveAccountID(input.providerID, input.accountID)
        : undefined
      const model = yield* provider.getModel(input.providerID, input.modelID, accountID)
      const primitive = Provider.modelPrimitive(model)
      if (primitive !== "system-one") {
        return yield* new Provider.UnsupportedModelPrimitiveError({
          providerID: model.providerID,
          modelID: model.id,
          primitive,
          required: "system-one",
        })
      }

      const info = yield* provider.getProvider(model.providerID)
      const options = { ...info.options, ...model.options }
      const baseURL =
        (typeof options.baseURL === "string" && options.baseURL.trim() ? options.baseURL : undefined) ?? model.api.url
      const headers = {
        ...stringHeaders(options.headers),
        ...model.headers,
      }

      let wireModelID = model.api.id
      let zenAccountID: string | undefined
      let apiKey =
        (typeof options.apiKey === "string" && options.apiKey ? options.apiKey : undefined) ??
        (typeof info.key === "string" && info.key ? info.key : undefined)

      if (ZEN_PROVIDERS.has(model.providerID)) {
        const route = yield* Effect.promise(() => resolveZenRequest(model.api.id, apiKey, model.providerID))
        if (route.missingAccountID) {
          return yield* new LLMError({
            module: "SystemOne",
            method: "infer",
            reason: new InvalidRequestReason({
              message: `Selected OpenCode account ${route.missingAccountID} is no longer available`,
              parameter: "accountID",
            }),
          })
        }
        wireModelID = route.modelID ?? wireModelID
        zenAccountID = route.accountID
        apiKey = route.apiKey ?? apiKey

        const client = Flag.OPENCODE_CLIENT
        const instance = yield* InstanceRef
        headers["User-Agent"] = InstallationUserAgent()
        headers["x-opencode-client"] = client
        headers["x-opencode-session"] = semanticSessionID(input.affinityID)
        headers["x-opencode-request"] = MessageID.ascending()
        if (instance?.project.id) headers["x-opencode-project"] = instance.project.id
      }

      if (apiKey) {
        if (ZEN_PROVIDERS.has(model.providerID) || headers.authorization === undefined) {
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
          if (!zenAccountID) return Effect.void
          const http = errorHttp(error)
          if (!http?.response) return Effect.void
          return Effect.sync(() => observeZenRequest(zenAccountID, http.response!.status, http.response!.headers))
        }),
      )

      if (zenAccountID) observeZenRequest(zenAccountID, 200)
      const result: Contract.InferResult = {
        ...output,
        cost: cost(model, output.usage),
      }
      yield* Effect.logDebug("system-one inference", {
        providerID: model.providerID,
        modelID: model.id,
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
