import { expect } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Provider } from "../../src/provider/provider"
import { MODEL_METADATA, PROVIDER_ID, readGskCliApiKey, resolveApiKey } from "../../src/genspark/models"

import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const GENSPARK = ProviderV2.ID.make(PROVIDER_ID)
const MODEL_OPUS_1M = ModelV2.ID.make("claude-opus-4-6-1m")
const MODEL_HAIKU = ModelV2.ID.make("claude-haiku-4-5")
const it = testEffect(LayerNode.compile(Provider.node))

// The openai-compatible SDK resolves the endpoint lazily through config.url,
// which is called with the request path.
const languageBaseURL = (language: unknown) => {
  const url = (language as { config: { url: (input: { path: string }) => string } }).config.url
  return url({ path: "/chat/completions" }).replace(/\/chat\/completions$/, "")
}

const NO_GSK_FILE = path.join(os.tmpdir(), `opencode-gsk-missing-${process.pid}`, "config.json")

const withEnv = <A, E, R>(values: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]] as const))
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )

const withoutGskCredentials = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withEnv(
    {
      GSK_API_KEY: undefined,
      GENSPARK_API_KEY: undefined,
      GSK_CONFIG: NO_GSK_FILE,
    },
    effect,
  )

it.instance(
  "genspark is visible without credentials",
  () =>
    withoutGskCredentials(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        expect(providers[GENSPARK]).toBeDefined()
        expect(Object.keys(providers[GENSPARK].models).length).toBe(Object.keys(MODEL_METADATA).length)
      }),
    ),
  { config: {} },
)

it.instance(
  "genspark autoloads from GSK_API_KEY",
  () =>
    withEnv({ GSK_API_KEY: "gsk_test_key", GSK_CONFIG: NO_GSK_FILE },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        expect(providers[GENSPARK]).toBeDefined()
        expect(Object.keys(providers[GENSPARK].models).length).toBe(Object.keys(MODEL_METADATA).length)
        const model = providers[GENSPARK].models["claude-opus-4-6-1m"]
        expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
        expect(model.api.url).toBe("https://www.genspark.ai/api/llm_proxy/v1")
        expect(providers[GENSPARK].options.apiKey).toBe("gsk_test_key")
        expect(providers[GENSPARK].options.litellmProxy).toBe(true)
      }),
    ),
  { config: {} },
)

it.instance(
  "genspark prefers the stored auth key over env",
  () =>
    withEnv(
      {
        GSK_API_KEY: "gsk_env_key",
        GSK_CONFIG: NO_GSK_FILE,
        OPENCODE_AUTH_CONTENT: JSON.stringify({ genspark: { type: "api", key: "gsk_stored_key" } }),
      },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        expect(providers[GENSPARK]).toBeDefined()
        expect(providers[GENSPARK].source).toBe("api")
        expect(providers[GENSPARK].options.apiKey).toBe("gsk_stored_key")
      }),
    ),
  { config: {} },
)

it.instance(
  "genspark imports the gsk CLI login file",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-gsk-")))
      const file = path.join(dir, "config.json")
      yield* Effect.promise(() => writeFile(file, JSON.stringify({ api_key: " gsk_cli_file_key " })))
      const providers = yield* withEnv({ GSK_CONFIG: file },
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          return yield* provider.list()
        }),
      )
      expect(providers[GENSPARK]).toBeDefined()
      expect(providers[GENSPARK].source).toBe("custom")
      expect(providers[GENSPARK].options.apiKey).toBe("gsk_cli_file_key")
      yield* Effect.promise(() => rm(dir, { recursive: true, force: true }))
    }),
  { config: {} },
)

it.instance(
  "genspark resolves the language model against the proxy endpoint",
  () =>
    withEnv({ GSK_API_KEY: "gsk_test_key", GSK_CONFIG: NO_GSK_FILE },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const model = yield* provider.getModel(GENSPARK, MODEL_OPUS_1M)
        const language = yield* provider.getLanguage(model)
        expect(languageBaseURL(language)).toBe("https://www.genspark.ai/api/llm_proxy/v1")
      }),
    ),
  { config: {} },
)

it.instance(
  "genspark honors GENSPARK_BASE_URL for the proxy endpoint",
  () =>
    withEnv(
      { GSK_API_KEY: "gsk_test_key", GSK_CONFIG: NO_GSK_FILE, GENSPARK_BASE_URL: "https://mirror.example.com/" },
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const providers = yield* provider.list()
          const model = providers[GENSPARK].models["claude-sonnet-4-6"]
          expect(model.api.url).toBe("https://mirror.example.com/api/llm_proxy/v1")
          const language = yield* provider.getLanguage(model)
          expect(languageBaseURL(language)).toBe("https://mirror.example.com/api/llm_proxy/v1")
        }),
    ),
  { config: {} },
)

it.instance(
  "genspark catalog matches the official init-opencode shape",
  () =>
    withEnv({ GSK_API_KEY: "gsk_test_key", GSK_CONFIG: NO_GSK_FILE },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        const models = providers[GENSPARK].models
        const opus1m = models["claude-opus-4-6-1m"]
        expect(opus1m.name).toBe("Claude Opus 4.6 (1M)")
        expect(opus1m.limit).toEqual({ context: 1_000_000, input: 872_000, output: 128_000 })
        expect(opus1m.variants?.["high"]).toEqual({ reasoningEffort: "high" })
        expect(opus1m.capabilities.temperature).toBe(true)

        const sol = models["gpt-5.6-sol"]
        expect(sol.name).toBe("GPT-5.6 Sol")
        expect(sol.capabilities.reasoning).toBe(true)
        expect(sol.capabilities.temperature).toBe(false)
        expect(Object.keys(sol.variants ?? {})).toEqual(["none", "low", "medium", "high", "xhigh", "max"])

        const sonnet = models["claude-sonnet-4-6"]
        expect(sonnet.capabilities.reasoning).toBe(true)
        expect(sonnet.capabilities.toolcall).toBe(true)
        expect(sonnet.capabilities.input.image).toBe(true)

        const gpt55 = models["gpt-5.5"]
        expect(gpt55.capabilities.reasoning).toBe(false)
        expect(gpt55.variants).toEqual({})

        expect(models["claude-fable-5"]).toBeDefined()
        expect(models["kimi-k3"]).toBeDefined()
        expect(models["solar-pro4"]).toBeDefined()
      }),
    ),
  { config: {} },
)

it.instance(
  "genspark key resolution is auth > env > gsk CLI file",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "opencode-gsk-")))
      const file = path.join(dir, "config.json")
      yield* Effect.promise(() => writeFile(file, JSON.stringify({ api_key: "gsk_file_key" })))

      expect(yield* Effect.promise(() => resolveApiKey({ env: {} }))).toBeUndefined()
      expect(yield* Effect.promise(() => resolveApiKey({ env: {}, authKey: "  gsk_auth_key  " }))).toBe(
        "gsk_auth_key",
      )
      expect(yield* Effect.promise(() => resolveApiKey({ env: { GSK_API_KEY: "gsk_env_key" } }))).toBe(
        "gsk_env_key",
      )
      expect(
        yield* Effect.promise(() => resolveApiKey({ env: { GSK_API_KEY: "gsk_env_key" }, authKey: "gsk_auth_key" })),
      ).toBe("gsk_auth_key")

      expect(yield* Effect.promise(() => readGskCliApiKey())).toBeUndefined()
      expect(
        yield* withEnv({ GSK_CONFIG: file }, Effect.promise(() => readGskCliApiKey())),
      ).toBe("gsk_file_key")

      yield* Effect.promise(() => rm(dir, { recursive: true, force: true }))
    }),
  { config: {} },
)

it.instance(
  "genspark exposes a small model for housekeeping calls",
  () =>
    withEnv({ GSK_API_KEY: "gsk_test_key", GSK_CONFIG: NO_GSK_FILE },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const small = yield* provider.getSmallModel(GENSPARK)
        expect(small?.id).toBe(MODEL_HAIKU)
      }),
    ),
  { config: {} },
)
