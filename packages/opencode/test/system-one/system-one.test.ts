import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { SystemOne } from "@/system-one/system-one"
import { ProviderTest } from "../fake/provider"
import { resetZenPoolForTest, setTestZenVaultCredentials } from "@/plugin/zen"
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
                model: "jev-1.13-free",
                answers: {
                  verdict: {
                    type: "choice",
                    choice: "inspect",
                    confidence: 0.81,
                    probabilities: { pass: 0.19, inspect: 0.81 },
                  },
                },
                usage: { input_tokens: 250, output_tokens: 4 },
                request_id: "system-one-host-test",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          )
        }),
    }),
  )
}

afterEach(() => {
  setTestZenVaultCredentials(undefined)
  resetZenPoolForTest()
})

describe("SystemOne host service", () => {
  let captured:
    | { url: string; authorization?: string; headers: Readonly<Record<string, string>>; body: unknown }
    | undefined
  const model = ProviderTest.model({
    id: ModelV2.ID.make("jev-1.13-free"),
    providerID: ProviderV2.ID.make("opencode"),
    primitive: "system-one",
    api: {
      id: "jev-1.13-free",
      url: "https://opencode.ai/zen/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  })
  const provider = ProviderTest.fake({ model })
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

  const publicSentinelProvider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ options: { apiKey: "public" } }, model),
  })
  const publicSentinelLayer = SystemOne.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        publicSentinelProvider.layer,
        requestLayer((value) => {
          captured = value
        }),
      ),
    ),
  )
  const publicSentinelIt = testEffect(publicSentinelLayer)

  it.effect("routes OpenCode Jev through System One with Zen auth and zero free-model cost", () =>
    Effect.gen(function* () {
      setTestZenVaultCredentials([{ apiKey: "jev-test-secret", label: "jev-test", isDefault: true }])

      const service = yield* SystemOne.Service
      const result = yield* service.infer({
        providerID: ProviderV2.ID.make("opencode"),
        modelID: ModelV2.ID.make("jev-1.13-free"),
        affinityID: "proofgate-run-42",
        state: { candidate: "proof-42" },
        questions,
      })

      expect(captured?.url).toBe("https://opencode.ai/zen/v1/systemone")
      expect(captured?.authorization).toBe("Bearer jev-test-secret")
      expect(captured?.headers["x-opencode-session"]).toMatch(/^ses_sem_[0-9a-f]{32}$/)
      expect(captured?.headers["x-opencode-request"]).toMatch(/^msg_/)
      expect(captured?.headers["x-opencode-client"]).toBeTruthy()
      expect(captured?.headers["user-agent"]).toMatch(/^opencode\//)
      expect(captured?.body).toEqual({
        model: "jev-1.13-free",
        state: { candidate: "proof-42" },
        questions,
      })
      expect(result.answers.verdict).toEqual({
        type: "choice",
        choice: "inspect",
        confidence: 0.81,
        probabilities: { pass: 0.19, inspect: 0.81 },
      })
      expect(result.cost).toEqual({ input: 0, output: 0, total: 0 })
      expect((result.raw as Record<string, unknown>).request_id).toBe("system-one-host-test")
    }),
  )

  publicSentinelIt.effect("does not let the public provider sentinel override a real Zen account", () =>
    Effect.gen(function* () {
      setTestZenVaultCredentials([{ apiKey: "jev-real-secret", label: "jev-real", isDefault: true }])

      const service = yield* SystemOne.Service
      yield* service.infer({
        providerID: ProviderV2.ID.make("opencode"),
        modelID: ModelV2.ID.make("jev-1.13-free"),
        state: "candidate",
        questions,
      })

      expect(captured?.authorization).toBe("Bearer jev-real-secret")
      expect(captured?.body).toMatchObject({ model: "jev-1.13-free" })
    }),
  )

  const migratedLegacyProvider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ key: "stale-legacy-auth-key" }, model),
  })
  const migratedLegacyLayer = SystemOne.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        migratedLegacyProvider.layer,
        requestLayer((value) => {
          captured = value
        }),
      ),
    ),
  )
  const migratedLegacyIt = testEffect(migratedLegacyLayer)

  migratedLegacyIt.effect("uses the active Zen pool account instead of stale legacy provider auth", () =>
    Effect.gen(function* () {
      setTestZenVaultCredentials([
        { apiKey: "different-pool-key", label: "Migrated key", isDefault: false },
        { apiKey: "jev-active-secret", label: "key3", isDefault: true },
      ])

      const service = yield* SystemOne.Service
      yield* service.infer({
        providerID: ProviderV2.ID.make("opencode"),
        modelID: ModelV2.ID.make("jev-1.13-free"),
        state: "candidate",
        questions,
      })

      expect(captured?.authorization).toBe("Bearer jev-active-secret")
      expect(captured?.body).toMatchObject({ model: "jev-1.13-free" })
    }),
  )

  const directZenProvider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ key: "zen-direct-only-secret" }, model),
  })
  const directZenLayer = SystemOne.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        directZenProvider.layer,
        requestLayer((value) => {
          captured = value
        }),
      ),
    ),
  )
  const directZenIt = testEffect(directZenLayer)

  directZenIt.effect("keeps direct Zen provider auth working when the unified pool is empty", () =>
    Effect.gen(function* () {
      setTestZenVaultCredentials([])

      const service = yield* SystemOne.Service
      yield* service.infer({
        providerID: ProviderV2.ID.make("opencode"),
        modelID: ModelV2.ID.make("jev-1.13-free"),
        state: "candidate",
        questions,
      })

      expect(captured?.authorization).toBe("Bearer zen-direct-only-secret")
    }),
  )

  it.effect("uses deterministic provider affinity without creating a durable Session", () =>
    Effect.gen(function* () {
      setTestZenVaultCredentials([{ apiKey: "jev-test-secret", label: "jev-test", isDefault: true }])
      const seen: string[] = []
      const service = yield* SystemOne.Service
      const input = {
        providerID: ProviderV2.ID.make("opencode"),
        modelID: ModelV2.ID.make("jev-1.13-free"),
        affinityID: "proofgate:campaign-17",
        state: "candidate",
        questions,
      }

      yield* service.infer(input)
      if (captured?.headers["x-opencode-session"]) seen.push(captured.headers["x-opencode-session"])
      yield* service.infer(input)
      if (captured?.headers["x-opencode-session"]) seen.push(captured.headers["x-opencode-session"])

      expect(seen).toHaveLength(2)
      expect(seen[0]).toBe(seen[1])
      expect(seen[0]).toMatch(/^ses_sem_[0-9a-f]{32}$/)
    }),
  )
})

describe("SystemOne OpenCode Go compatibility", () => {
  let captured:
    | { url: string; authorization?: string; headers: Readonly<Record<string, string>>; body: unknown }
    | undefined
  const model = ProviderTest.model({
    id: ModelV2.ID.make("jev-1.13"),
    providerID: ProviderV2.ID.make("opencode-go"),
    primitive: "system-one",
    api: {
      id: "jev-1.13",
      url: "https://opencode.ai/zen/go/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  })
  const provider = ProviderTest.fake({ model })
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

  it.effect("routes a future Go-hosted Jev catalog row through the Go System One endpoint", () =>
    Effect.gen(function* () {
      setTestZenVaultCredentials([{ apiKey: "go-jev-test-secret", label: "go-jev-test", isDefault: true }])

      const service = yield* SystemOne.Service
      yield* service.infer({
        providerID: ProviderV2.ID.make("opencode-go"),
        modelID: ModelV2.ID.make("jev-1.13"),
        affinityID: "proofgate-go-campaign-1",
        state: { candidate: "proof-go-1" },
        questions,
      })

      expect(captured?.url).toBe("https://opencode.ai/zen/go/v1/systemone")
      expect(captured?.authorization).toBe("Bearer go-jev-test-secret")
      expect(captured?.headers["x-opencode-session"]).toMatch(/^ses_sem_[0-9a-f]{32}$/)
      expect(captured?.headers["x-opencode-request"]).toMatch(/^msg_/)
      expect(captured?.body).toEqual({
        model: "jev-1.13",
        state: { candidate: "proof-go-1" },
        questions,
      })
    }),
  )

  const directProvider = ProviderTest.fake({
    model,
    info: ProviderTest.info({ key: "go-direct-connect-secret" }, model),
  })
  const directLayer = SystemOne.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        directProvider.layer,
        requestLayer((value) => {
          captured = value
        }),
      ),
    ),
  )
  const directIt = testEffect(directLayer)

  directIt.effect("keeps a directly connected opencode-go key ahead of the shared pool default", () =>
    Effect.gen(function* () {
      setTestZenVaultCredentials([{ apiKey: "different-pool-key", label: "pool-default", isDefault: true }])
      const service = yield* SystemOne.Service
      yield* service.infer({
        providerID: ProviderV2.ID.make("opencode-go"),
        modelID: ModelV2.ID.make("jev-1.13"),
        state: "candidate",
        questions,
      })

      expect(captured?.url).toBe("https://opencode.ai/zen/go/v1/systemone")
      expect(captured?.authorization).toBe("Bearer go-direct-connect-secret")
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
