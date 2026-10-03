import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { SystemOne } from "@/system-one/system-one"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const questions = {
  verdict: {
    type: "choice" as const,
    instructions: "Classify the candidate.",
    criteria: { pass: "Looks useful", inspect: "Needs review" },
  },
}

function requestLayer(
  capture: (input: {
    url: string
    authorization?: string
    headers: Readonly<Record<string, string>>
    body: unknown
  }) => void,
) {
  return Layer.succeed(
    RequestExecutor.Service,
    RequestExecutor.Service.of({
      execute: (request) =>
        Effect.gen(function* () {
          const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
          const body = JSON.parse(yield* Effect.promise(() => web.text()))
          capture({
            url: request.url,
            authorization: request.headers.authorization,
            headers: request.headers,
            body,
          })
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                model: "direct-model",
                answers: {
                  verdict: {
                    type: "choice",
                    choice: "inspect",
                    confidence: 0.81,
                    probabilities: { pass: 0.19, inspect: 0.81 },
                  },
                },
                usage: { input_tokens: 250, output_tokens: 4 },
                request_id: "system-one-direct-test",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          )
        }),
    }),
  )
}

describe("SystemOne direct provider path", () => {
  let captured:
    | { url: string; authorization?: string; headers: Readonly<Record<string, string>>; body: unknown }
    | undefined
  const model = ProviderTest.model({
    id: ModelV2.ID.make("direct-model"),
    providerID: ProviderV2.ID.make("direct-provider"),
    primitive: "system-one",
    api: {
      id: "direct-model",
      url: "https://direct.example/v1",
      npm: "@ai-sdk/openai-compatible",
    },
  })
  const provider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ options: { apiKey: "direct-provider-key" } }, model),
  })
  const layer = SystemOne.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        provider.layer,
        requestLayer((value) => {
          captured = value
        }),
      ),
    ),
  )
  const it = testEffect(layer)

  it.effect("keeps the mature direct transport for a provider the routing domain does not own", () =>
    Effect.gen(function* () {
      const service = yield* SystemOne.Service
      const result = yield* service.infer({
        providerID: model.providerID,
        modelID: model.id,
        state: "candidate",
        questions,
      })

      expect(captured?.url).toBe("https://direct.example/v1/systemone")
      expect(captured?.authorization).toBe("Bearer direct-provider-key")
      // A non-hosted provider never gains hosted wire identity.
      expect(captured?.headers["x-opencode-client"]).toBeUndefined()
      expect(captured?.headers["x-opencode-session"]).toBeUndefined()
      expect(result.cost).toEqual({ input: 0, output: 0, total: 0 })
    }),
  )
})

describe("SystemOne provider account resolution", () => {
  let selectorSeen: string | undefined
  let accountSeen: string | undefined
  const model = ProviderTest.model({
    id: ModelV2.ID.make("deepseek-v4.1-flash"),
    providerID: ProviderV2.ID.make("workbuddy"),
    primitive: "system-one",
    api: {
      id: "deepseek-v4.1-flash",
      url: "https://example.com/v1",
      npm: "@ai-sdk/openai-compatible",
    },
  })
  const provider = ProviderTest.fake({
    model,
    resolveAccountID: Effect.fn("TestProvider.resolveHumanAccount")((_providerID, selector) => {
      selectorSeen = selector
      return Effect.succeed("wb-internal-222")
    }),
    getModel: Effect.fn("TestProvider.getCanonicalModel")((_providerID, _modelID, accountID) => {
      accountSeen = accountID
      return Effect.succeed(model)
    }),
  })
  const layer = SystemOne.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        provider.layer,
        requestLayer(() => {}),
      ),
    ),
  )
  const it = testEffect(layer)

  it.effect("resolves a human account label before model lookup", () =>
    Effect.gen(function* () {
      selectorSeen = undefined
      accountSeen = undefined

      const service = yield* SystemOne.Service
      yield* service.infer({
        providerID: model.providerID,
        modelID: model.id,
        accountID: "  Team Key 2  ",
        state: "candidate",
        questions,
      })

      expect([selectorSeen, accountSeen] as Array<string | undefined>).toEqual([
        "  Team Key 2  ",
        "wb-internal-222",
      ])
    }),
  )
})

describe("SystemOne primitive guard", () => {
  const model = ProviderTest.model({ primitive: "language" })
  const provider = ProviderTest.fake({ model })
  const layer = SystemOne.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        provider.layer,
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: () => Effect.die("language models must be rejected before System One transport"),
          }),
        ),
      ),
    ),
  )
  const it = testEffect(layer)

  it.effect("rejects ordinary language models before transport", () =>
    Effect.gen(function* () {
      const service = yield* SystemOne.Service
      const error = yield* service
        .infer({
          providerID: model.providerID,
          modelID: model.id,
          state: "candidate",
          questions: {
            valid: {
              type: "noul",
              instructions: "The candidate is valid.",
            },
          },
        })
        .pipe(Effect.flip)

      expect(error._tag).toBe("ProviderUnsupportedModelPrimitiveError")
      expect(error.message).toContain("cannot be used as a system-one model")
    }),
  )
})
