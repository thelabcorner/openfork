import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import os from "os"
import { readFile as readFileNode } from "node:fs/promises"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import fuzzysort from "fuzzysort"
import { Config } from "@/config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Npm } from "@opencode-ai/core/npm"
import { Hash } from "@opencode-ai/core/util/hash"
import { Plugin } from "../plugin"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Auth } from "../auth"
import { Env } from "../env"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { iife } from "@/util/iife"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema, Types, Semaphore } from "effect"
import { HttpClient } from "effect/unstable/http"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import * as ProviderCatalogContributions from "./catalog-contributions"
import { EffectPromise } from "@/effect/promise"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { isRecord } from "@/util/record"
import { optional } from "@opencode-ai/core/schema"
import { ProviderTransform } from "./transform"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PRODUCT_NAME, PRODUCT_REPOSITORY_URL, PRODUCT_SLUG } from "@opencode-ai/core/brand"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionSchema as CoreSessionSchema } from "@opencode-ai/core/session/schema"
import { ModelStatus } from "./model-status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { trackNvidiaRequest } from "@/quota/providers/nvidia-usage"
import { ProviderError } from "./error"
import { shouldEnableClaudeFirstParty } from "@/plugin/shared"
import {
  discoverZenSystemOneModel,
  zenHostedCatalog,
  zenAccountModelAliases,
  zenGoProviderFetch,
  zenProviderFetch,
  syncZenAccountPool,
  zenQuotaAccounts,
  zenLimitSnapshot,
  committedZenProviderFetch,
  committedPublicZenProviderFetch,
  ZEN_PUBLIC_API_KEY,
} from "@/plugin/zen"
import { stableZenIdentity } from "@/plugin/zen-accounts"
import {
  MODEL_IDS,
  MODEL_METADATA,
  claudeSubscriptionCatalogRevision,
  getClaudeSubscriptionModelMetadata,
  modelApi,
  PROXY_API_KEY,
  PROXY_BASE_URL,
  resolveAlias as resolveClaudeAlias,
} from "@/claude/models"
import {
  MODEL_IDS as GENSPARK_MODEL_IDS,
  MODEL_METADATA as GENSPARK_MODEL_METADATA,
  PROXY_OPTION as GENSPARK_PROXY_OPTION,
  PROVIDER_ID as GENSPARK_PROVIDER_ID,
  PROVIDER_NAME as GENSPARK_PROVIDER_NAME,
  apiURL as gensparkApiURL,
  resolveApiKey as resolveGensparkApiKey,
} from "@/genspark/models"
import { GensparkCatalog } from "@/genspark/catalog"
import { Credential } from "@opencode-ai/core/credential"
import * as CredentialResolver from "@opencode-ai/core/credential/resolver"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import { ProviderRouteHealth } from "@opencode-ai/core/provider-route-health"
import { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { ProviderRouteIntentRuntime } from "@opencode-ai/core/provider-route-intent"
import { ProviderAccountPolicy } from "@opencode-ai/core/provider-account-policy"
import { OpencodeProviderRoute } from "@opencode-ai/core/plugin/provider/opencode-provider-route"
import { OpencodeRouteCandidates } from "@opencode-ai/core/plugin/provider/opencode-route-candidates"
import { projectCredential as projectOpencodeCredential } from "@opencode-ai/core/plugin/provider/opencode-provider-account"
import { httpClient as httpClientNode } from "@opencode-ai/core/effect/app-node-platform"
import { integrationID as opencodeIntegrationID } from "@opencode-ai/core/plugin/provider/opencode-auth"
import type { AccountProviderCapability } from "@opencode-ai/core/plugin/provider/opencode-account-capability"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { ProviderAccount } from "@opencode-ai/schema/provider-account"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { serviceRealmID } from "@/server/shared/instance-identity"
import {
  consoleClientIdentity,
  isConsoleAccountProvider,
  makeConsoleAccountExecutionResolver,
  type ConsoleAccountExecution,
  type ConsoleClientIdentity,
} from "./console-account-execution"
import { providerModelID, splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"

import {
  resolveProviderAccountSelector,
  type ProviderAccountIdentity,
} from "./account-resolution"

const OPENAI_HEADER_TIMEOUT_DEFAULT = 300_000

async function readGensparkKeyFromFallbackConfig(): Promise<string | undefined> {
  if (process.env.BUN_TEST || process.env.NODE_ENV === "test" || !!process.env.OPENCODE_TEST_HOME || !!process.env.VITEST) return undefined
  const { join } = await import("node:path")
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    for (const file of ["openfork.json", ".opencode.json"]) {
      try {
        const raw = await readFileNode(join(dir, file), "utf8")
        const parsed = JSON.parse(raw) as { provider?: Record<string, { options?: { apiKey?: unknown } }> }
        const candidates = [
          parsed.provider?.["genspark"]?.options?.apiKey,
          parsed.provider?.["genspark-llm-proxy"]?.options?.apiKey,
          parsed.provider?.["genspark-gemini-proxy"]?.options?.apiKey,
        ]
        for (const c of candidates) if (typeof c === "string" && c.trim()) return c.trim()
      } catch {}
    }
    const parent = (await import("node:path")).join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new ProviderError.ResponseStreamError("SSE read timed out")
          ctl.abort(err)
          reader.cancel(err).catch(() => {})
          reject(err)
        }, ms)

        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}

function googleVertexAnthropicBaseURL(project: string | undefined, location: string | undefined) {
  if (!project) return
  if (location !== "eu" && location !== "us") return
  // Continental multi-regions require Regional Endpoint Platform domains.
  return `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`
}

function googleVertexEndpoint(location: string) {
  if (location === "global") return "aiplatform.googleapis.com"
  if (location === "eu" || location === "us") return `aiplatform.${location}.rep.googleapis.com`
  return `${location}-aiplatform.googleapis.com`
}

type BundledSDK = {
  languageModel(modelId: string): LanguageModelV3
  chat?: (modelId: string) => LanguageModelV3
  responses?: (modelId: string) => LanguageModelV3
}

const BUNDLED_PROVIDERS: Record<string, () => Promise<(opts: any) => BundledSDK>> = {
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock),
  "@ai-sdk/amazon-bedrock/mantle": () => import("@ai-sdk/amazon-bedrock/mantle").then((m) => m.createBedrockMantle),
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  "@ai-sdk/azure": () => import("@ai-sdk/azure").then((m) => m.createAzure),
  "@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex),
  "@ai-sdk/google-vertex/anthropic": () =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic),
  "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible),
  "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter),
  "@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai),
  "@ai-sdk/mistral": () => import("@ai-sdk/mistral").then((m) => m.createMistral),
  "@ai-sdk/groq": () => import("@ai-sdk/groq").then((m) => m.createGroq),
  "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra),
  "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras").then((m) => m.createCerebras),
  "@ai-sdk/cohere": () => import("@ai-sdk/cohere").then((m) => m.createCohere),
  "@ai-sdk/gateway": () => import("@ai-sdk/gateway").then((m) => m.createGateway),
  "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI),
  "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity").then((m) => m.createPerplexity),
  "@ai-sdk/vercel": () => import("@ai-sdk/vercel").then((m) => m.createVercel),
  "@ai-sdk/alibaba": () => import("@ai-sdk/alibaba").then((m) => m.createAlibaba),
  "gitlab-ai-provider": () => import("gitlab-ai-provider").then((m) => m.createGitLab),
  "@ai-sdk/github-copilot": () =>
    import("@opencode-ai/core/github-copilot/copilot-provider").then((m) => m.createOpenaiCompatible),
  "venice-ai-sdk-provider": () => import("venice-ai-sdk-provider").then((m) => m.createVenice),
}

type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>, model?: Model) => Promise<any>
type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
type CustomDiscoverModels = () => Promise<Record<string, Model>>
type DiscoveryLoader = {
  readonly load: CustomDiscoverModels
  readonly mode: "merge" | "replace"
}
type CustomLoader = (provider: Info) => Effect.Effect<{
  autoload: boolean
  getModel?: CustomModelLoader
  vars?: CustomVarsLoader
  options?: Record<string, any>
  discoverModels?: CustomDiscoverModels
}>

type CustomDep = {
  auth: (id: string) => Effect.Effect<Auth.Info | undefined>
  config: () => Effect.Effect<ConfigV1.Info>
  env: () => Effect.Effect<Record<string, string | undefined>>
  get: (key: string) => Effect.Effect<string | undefined>
  modelsDev: () => Record<string, ModelsDev.Provider>
  gensparkCatalog: (apiKey: string | undefined) => Effect.Effect<GensparkCatalog.Catalog, never, never>
}

function selectAzureLanguageModel(sdk: any, modelID: string, useChat: boolean) {
  if (useChat && sdk.chat) return sdk.chat(modelID)
  if (sdk.responses) return sdk.responses(modelID)
  if (sdk.messages) return sdk.messages(modelID)
  if (sdk.chat) return sdk.chat(modelID)
  return sdk.languageModel(modelID)
}

function selectBedrockMantleLanguageModel(sdk: BundledSDK, modelID: string) {
  if (modelID === "openai.gpt-oss-safeguard-20b" || modelID === "openai.gpt-oss-safeguard-120b")
    return sdk.chat?.(modelID) ?? sdk.languageModel(modelID)
  return sdk.responses?.(modelID) ?? sdk.languageModel(modelID)
}

function custom(dep: CustomDep): Record<string, CustomLoader> {
  return {
    anthropic: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }),
    "claude-api": () =>
      Effect.succeed({
        autoload: true,
        options: {
          headers: {
            "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }),
    opencode: Effect.fnUntraced(function* (input: Info) {
      const env = yield* dep.env()
      // Both zen providers draw from one unified key pool (env keys + fork
      // vault). Pool presence is therefore a credential source independent of
      // the legacy env/auth/config gates; sync once so vault keys are visible
      // before this loader decides whether the provider is available.
      yield* Effect.promise(() => syncZenAccountPool())
      const poolHasCredentials = zenQuotaAccounts().length > 0
      const hasKey = iife(() => {
        if (input.env.some((item) => env[item])) return true
        return false
      })
      const ok =
        hasKey ||
        poolHasCredentials ||
        Boolean(yield* dep.auth(input.id)) ||
        Boolean((yield* dep.config()).provider?.["opencode"]?.options?.apiKey)

      if (!ok) {
        const hosted = yield* Effect.promise(() => zenHostedCatalog())
        const advertised =
          hosted.state === "fresh" || hosted.state === "stale"
            ? hosted.ids
            : new Set<string>()
        const catalog = dep.modelsDev()[input.id]?.models
        for (const [key, value] of Object.entries(input.models)) {
          const hostedModelID = value.api.id
          if (advertised.has(hostedModelID) && isTrustedZeroCostCatalogModel(catalog?.[hostedModelID])) continue
          delete input.models[key]
        }
      }

      return {
        autoload: Object.keys(input.models).length > 0,
        options: { ...(ok ? {} : { apiKey: ZEN_PUBLIC_API_KEY }), fetch: zenProviderFetch },
        async discoverModels() {
          // Compatibility fallback only. Once the normal catalog contains the
          // row, keep provider assembly deterministic and avoid a redundant
          // hosted /models request.
          if (input.models["jev-1.13-free"]) return {}
          const discovered = await discoverZenSystemOneModel("jev-1.13-free")
          if (!discovered) return {}
          const id = ModelV2.ID.make(discovered.id)
          const base = {
            id,
            providerID: input.id,
            name: discovered.name,
            family: "jev",
            primitive: "system-one",
            api: {
              id,
              url: discovered.baseURL,
              npm: "@ai-sdk/openai-compatible",
            },
            status: "active",
            headers: {},
            options: {},
            cost: {
              input: discovered.cost.input,
              output: discovered.cost.output,
              cache: { read: 0, write: 0 },
            },
            // System One is a semantic inference primitive rather than a
            // language context window. These fields are structurally required
            // by the shared provider model shape but are not used by inference.
            limit: { context: 0, output: 0 },
            capabilities: {
              temperature: false,
              reasoning: false,
              attachment: false,
              toolcall: false,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: false, audio: false, image: false, video: false, pdf: false },
              interleaved: false,
            },
            release_date: "",
            variants: {},
          } satisfies Model
          const models: Record<string, Model> = { [id]: base }
          for (const alias of zenAccountModelAliases(base.id, base.name)) {
            const aliasID = ModelV2.ID.make(alias.id)
            models[aliasID] = {
              ...base,
              id: aliasID,
              name: alias.name,
              api: { ...base.api, id: aliasID },
            }
          }
          return models
        },
      }
    }),
    "opencode-go": Effect.fnUntraced(function* (input: Info) {
      const env = yield* dep.env()
      yield* Effect.promise(() => syncZenAccountPool())
      const hasKey = input.env.some((item) => env[item])
      const ok =
        hasKey ||
        zenQuotaAccounts().length > 0 ||
        Boolean(yield* dep.auth(input.id)) ||
        Boolean((yield* dep.config()).provider?.["opencode-go"]?.options?.apiKey)

      return {
        autoload: ok,
        options: { fetch: zenGoProviderFetch },
      }
    }),
    openai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: { headerTimeout: OPENAI_HEADER_TIMEOUT_DEFAULT },
      }),
    meta: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
      }),
    xai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      }),
    "github-copilot": () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>, model?: Model) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          if (model && "endpoint" in model.api) {
            if (model.api.endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
            if (model.api.endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
          }
          const match = /^gpt-(\d+)/.exec(modelID)
          if (match && Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")) return sdk.responses(modelID)
          return sdk.chat(modelID)
        },
        options: {},
      }),
    azure: Effect.fnUntraced(function* (provider: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(provider.id)
      const resource = iife(() => {
        return [
          provider.options?.resourceName,
          auth?.type === "api" ? auth.metadata?.resourceName : undefined,
          auth?.type === "oauth" ? auth.accountId : undefined,
          env["AZURE_RESOURCE_NAME"],
        ].find((name) => typeof name === "string" && name.trim() !== "")
      })

      if (!resource && !provider.options?.baseURL) {
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "AZURE_RESOURCE_NAME is missing, set it using env var or reconnecting the azure provider and setting it",
            )
          },
        }
      }

      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          resourceName: resource,
        },
        vars(_options): Record<string, string> {
          if (resource) {
            return {
              AZURE_RESOURCE_NAME: resource,
            }
          }
          return {}
        },
      }
    }),
    "azure-cognitive-services": Effect.fnUntraced(function* (provider: Info) {
      const resourceName = yield* dep.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          baseURL: resourceName
            ? `https://${resourceName}.cognitiveservices.azure.com/openai${provider.options?.useDeploymentBasedUrls ? "" : "/v1"}`
            : undefined,
        },
      }
    }),
    "amazon-bedrock": Effect.fnUntraced(function* () {
      const providerConfig = (yield* dep.config()).provider?.["amazon-bedrock"]
      const auth = yield* dep.auth("amazon-bedrock")
      const env = yield* dep.env()

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = env["AWS_REGION"]
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = env["AWS_PROFILE"]
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = env["AWS_ACCESS_KEY_ID"]
      const configApiKey = providerConfig?.options?.apiKey

      // TODO: Using process.env directly because Env.set only updates a process.env shallow copy,
      // until the scope of the Env API is clarified (test only or runtime?)
      const awsBearerToken = iife(() => {
        const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
        if (envToken) return envToken
        if (auth?.type === "api") {
          process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = env["AWS_WEB_IDENTITY_TOKEN_FILE"]

      const containerCreds = Boolean(
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      )

      if (
        !profile &&
        !awsAccessKeyId &&
        !awsBearerToken &&
        !configApiKey &&
        !awsWebIdentityTokenFile &&
        !containerCreds
      )
        return { autoload: false }

      const { fromNodeProviderChain } = yield* Effect.promise(() => import("@aws-sdk/credential-providers"))

      const providerOptions: Record<string, any> = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken && !configApiKey) {
        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        vars(options: Record<string, any>) {
          return { AWS_REGION: options.region ?? defaultRegion }
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>, model?: Model) {
          if (model?.api.npm === "@ai-sdk/amazon-bedrock/mantle") return selectBedrockMantleLanguageModel(sdk, modelID)

          // Skip region prefixing if model already has a cross-region inference profile prefix
          // Models from models.dev may already include prefixes like us., eu., global., etc.
          if (modelID.startsWith("arn:")) {
            return sdk.languageModel(modelID)
          }

          const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
          if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from openfork.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek.r1",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    }),
    llmgateway: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": PRODUCT_REPOSITORY_URL,
            "X-Title": PRODUCT_NAME,
            "X-Source": PRODUCT_SLUG,
          },
        },
      }),
    openrouter: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": PRODUCT_REPOSITORY_URL,
            "X-Title": PRODUCT_NAME,
          },
        },
      }),
    nvidia: (provider) =>
      Effect.succeed({
        autoload: provider.source === "config",
        options: {
          headers: {
            "HTTP-Referer": PRODUCT_REPOSITORY_URL,
            "X-Title": PRODUCT_NAME,
            "X-BILLING-INVOKE-ORIGIN": PRODUCT_NAME,
          },
        },
      }),
    vercel: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "http-referer": PRODUCT_REPOSITORY_URL,
            "x-title": PRODUCT_NAME,
          },
        },
      }),
    "google-vertex": Effect.fnUntraced(function* (provider: Info) {
      const env = yield* dep.env()
      // models.dev advertises GOOGLE_VERTEX_PROJECT for Vertex; keep the wider
      // Google Cloud project env names as fallbacks for existing ADC setups.
      const project =
        provider.options?.project ??
        env["GOOGLE_VERTEX_PROJECT"] ??
        env["GOOGLE_CLOUD_PROJECT"] ??
        env["GCP_PROJECT"] ??
        env["GCLOUD_PROJECT"]

      const location = String(
        provider.options?.location ??
          env["GOOGLE_VERTEX_LOCATION"] ??
          env["GOOGLE_CLOUD_LOCATION"] ??
          env["VERTEX_LOCATION"] ??
          "us-central1",
      )

      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        vars(_options: Record<string, any>) {
          return {
            ...(project && { GOOGLE_VERTEX_PROJECT: project }),
            GOOGLE_VERTEX_LOCATION: location,
            GOOGLE_VERTEX_ENDPOINT: googleVertexEndpoint(location),
          }
        },
        options: {
          project,
          location,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const { GoogleAuth } = await import("google-auth-library")
            const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
            const client = await auth.getClient()
            const token = await client.getAccessToken()

            const headers = new Headers(init?.headers)
            headers.set("Authorization", `Bearer ${token.token}`)

            return fetch(input, { ...init, headers })
          },
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "google-vertex-anthropic": Effect.fnUntraced(function* () {
      const env = yield* dep.env()
      const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCP_PROJECT"] ?? env["GCLOUD_PROJECT"]
      const location = env["GOOGLE_CLOUD_LOCATION"] ?? env["VERTEX_LOCATION"] ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      const baseURL = googleVertexAnthropicBaseURL(project, location)
      return {
        autoload: true,
        options: {
          project,
          location,
          ...(baseURL && { baseURL }),
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "sap-ai-core": Effect.fnUntraced(function* () {
      const auth = yield* dep.auth("sap-ai-core")
      // TODO: Using process.env directly because Env.set only updates a shallow copy (not process.env),
      // until the scope of the Env API is clarified (test only or runtime?)
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = process.env.AICORE_SERVICE_KEY
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          process.env.AICORE_SERVICE_KEY = auth.key
          return auth.key
        }
        return undefined
      })
      const deploymentId = process.env.AICORE_DEPLOYMENT_ID
      const resourceGroup = process.env.AICORE_RESOURCE_GROUP

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    }),
    zenmux: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": PRODUCT_REPOSITORY_URL,
            "X-Title": PRODUCT_NAME,
          },
        },
      }),
    gitlab: Effect.fnUntraced(function* (input: Info) {
      const {
        VERSION: GITLAB_PROVIDER_VERSION,
        isWorkflowModel,
        discoverWorkflowModels,
      } = yield* Effect.promise(() => import("gitlab-ai-provider"))

      const instanceUrl = (yield* dep.get("GITLAB_INSTANCE_URL")) || "https://gitlab.com"

      const auth = yield* dep.auth(input.id)
      const apiKey = auth?.type === "oauth" ? auth.access : auth?.type === "api" ? auth.key : undefined
      const token = apiKey ?? (yield* dep.get("GITLAB_TOKEN"))

      const providerConfig = (yield* dep.config()).provider?.["gitlab"]
      const directory = yield* InstanceState.directory

      const aiGatewayHeaders = {
        "User-Agent": `opencode/${InstallationVersion} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        "anthropic-beta": "context-1m-2025-08-07",
        ...providerConfig?.options?.aiGatewayHeaders,
      }

      const featureFlags = {
        duo_agent_platform_agentic_chat: true,
        duo_agent_platform: true,
        ...providerConfig?.options?.featureFlags,
      }

      return {
        autoload: !!token,
        options: {
          instanceUrl,
          apiKey: token,
          aiGatewayHeaders,
          featureFlags,
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (modelID.startsWith("duo-workflow-")) {
            const workflowRef = typeof options?.workflowRef === "string" ? options.workflowRef : undefined
            // Use the static mapping if it exists, otherwise use duo-workflow with selectedModelRef
            const sdkModelID = isWorkflowModel(modelID) ? modelID : "duo-workflow"
            const workflowDefinition =
              typeof options?.workflowDefinition === "string" ? options.workflowDefinition : undefined
            const model = sdk.workflowChat(sdkModelID, {
              featureFlags,
              workflowDefinition,
            })
            if (workflowRef) {
              model.selectedModelRef = workflowRef
            }
            return model
          }
          return sdk.agenticChat(modelID, {
            aiGatewayHeaders,
            featureFlags,
          })
        },
        async discoverModels(): Promise<Record<string, Model>> {
          if (!apiKey) {
            return {}
          }

          try {
            const token = apiKey
            const getHeaders = (): Record<string, string> =>
              auth?.type === "api" ? { "PRIVATE-TOKEN": token } : { Authorization: `Bearer ${token}` }

            const result = await discoverWorkflowModels({ instanceUrl, getHeaders }, { workingDirectory: directory })

            if (!result.models.length) {
              return {}
            }

            const models: Record<string, Model> = {}
            for (const m of result.models) {
              if (!input.models[m.id]) {
                models[m.id] = {
                  id: ModelV2.ID.make(m.id),
                  providerID: ProviderV2.ID.make("gitlab"),
                  name: `Agent Platform (${m.name})`,
                  family: "",
                  api: {
                    id: m.id,
                    url: instanceUrl,
                    npm: "gitlab-ai-provider",
                  },
                  status: "active",
                  headers: {},
                  options: { workflowRef: m.ref },
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                  limit: { context: m.context, output: m.output },
                  capabilities: {
                    temperature: false,
                    reasoning: true,
                    attachment: true,
                    toolcall: true,
                    input: {
                      text: true,
                      audio: false,
                      image: true,
                      video: false,
                      pdf: true,
                    },
                    output: {
                      text: true,
                      audio: false,
                      image: false,
                      video: false,
                      pdf: false,
                    },
                    interleaved: false,
                  },
                  release_date: "",
                  variants: {},
                }
              }
            }

            return models
          } catch (e) {
            return {}
          }
        },
      }
    }),
    "cloudflare-workers-ai": Effect.fnUntraced(function* (input: Info) {
      // When baseURL is already configured (e.g. corporate config routing through a proxy/gateway),
      // skip the account ID check because the URL is already fully specified.
      if (input.options?.baseURL) return { autoload: false }

      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      if (!accountId)
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "CLOUDFLARE_ACCOUNT_ID is missing. Set it with: export CLOUDFLARE_ACCOUNT_ID=<your-account-id>",
            )
          },
        }

      const apiKey = env["CLOUDFLARE_API_KEY"] || (auth?.type === "api" ? auth.key : undefined)

      return {
        autoload: !!apiKey,
        options: {
          apiKey,
          headers: {
            "User-Agent": `opencode/${InstallationVersion} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
          },
        },
        async getModel(sdk: any, modelID: string) {
          return sdk.languageModel(modelID)
        },
        vars(_options) {
          return {
            CLOUDFLARE_ACCOUNT_ID: accountId,
          }
        },
      }
    }),
    "cloudflare-ai-gateway": Effect.fnUntraced(function* (input: Info) {
      // When baseURL is already configured (e.g. corporate config), skip the ID checks.
      if (input.options?.baseURL) return { autoload: false }

      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      // The Cloudflare auth prompt stores this value as gatewayId metadata.
      const gateway = env["CLOUDFLARE_GATEWAY_ID"] || (auth?.type === "api" ? auth.metadata?.gatewayId : undefined)

      if (!accountId || !gateway) {
        const missing = [
          !accountId ? "CLOUDFLARE_ACCOUNT_ID" : undefined,
          !gateway ? "CLOUDFLARE_GATEWAY_ID" : undefined,
        ].filter((x): x is string => Boolean(x))
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              `${missing.join(" and ")} missing. Set with: ${missing.map((x) => `export ${x}=<value>`).join(" && ")}`,
            )
          },
        }
      }

      // Get API token from env or auth - required for authenticated gateways
      const apiToken =
        env["CLOUDFLARE_API_TOKEN"] || env["CF_AIG_TOKEN"] || (auth?.type === "api" ? auth.key : undefined)

      if (!apiToken) {
        throw new Error(
          "CLOUDFLARE_API_TOKEN (or CF_AIG_TOKEN) is required for Cloudflare AI Gateway. " +
            "Set it via environment variable or run `opencode auth cloudflare-ai-gateway`.",
        )
      }

      const { createAiGateway } = yield* Effect.promise(() => import("ai-gateway-provider"))
      const { createUnified } = yield* Effect.promise(() => import("ai-gateway-provider/providers/unified"))
      const { createOpenAI } = yield* Effect.promise(() => import("ai-gateway-provider/providers/openai"))
      const { createAnthropic } = yield* Effect.promise(() => import("ai-gateway-provider/providers/anthropic"))
      const { createOpenAICompatible } = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))

      const metadata = iife(() => {
        if (input.options?.metadata) return input.options.metadata
        try {
          return JSON.parse(input.options?.headers?.["cf-aig-metadata"])
        } catch {
          return undefined
        }
      })
      const opts = {
        metadata,
        cacheTtl: input.options?.cacheTtl,
        cacheKey: input.options?.cacheKey,
        skipCache: input.options?.skipCache,
        collectLog: input.options?.collectLog,
        headers: {
          "User-Agent": `opencode/${InstallationVersion} cloudflare-ai-gateway (${os.platform()} ${os.release()}; ${os.arch()})`,
        },
      }

      const aigateway = createAiGateway({
        accountId,
        gateway,
        apiKey: apiToken,
        ...(Object.values(opts).some((v) => v !== undefined) ? { options: opts } : {}),
      })
      return {
        autoload: true,
        async getModel(_sdk: any, modelID: string, _options?: Record<string, any>) {
          // Model IDs use Unified API format: provider/model (e.g., "anthropic/claude-sonnet-4-5").
          // OpenAI and Anthropic ride their native passthrough routes so agents get the Responses
          // and Messages APIs; new OpenAI models reject tools+reasoning_effort on chat completions.
          // The passthrough wrappers inject a CF_TEMP_TOKEN sentinel that the gateway strips before
          // dispatch, so upstream billing stays on the gateway (Unified Billing / stored BYOK).
          if (modelID.startsWith("openai/")) return aigateway(createOpenAI()(modelID.slice("openai/".length)))
          // models.dev lists Anthropic ids with dotted versions (claude-haiku-4.5); Anthropic's
          // Messages API expects dashed native slugs (claude-haiku-4-5), so translate before passing.
          // No native Anthropic slug contains a dot, so the blanket replacement is lossless here -
          // unlike OpenAI above, whose native ids (e.g. gpt-4.1) keep their dots and must not be touched.
          if (modelID.startsWith("anthropic/"))
            return aigateway(createAnthropic()(modelID.slice("anthropic/".length).replaceAll(".", "-")))
          // Workers AI is the only first-party provider whose upstream is Cloudflare itself, so it is
          // the only one that should receive the Cloudflare token as its upstream Authorization header.
          // The Unified API addresses Workers AI both with the explicit "workers-ai/" prefix and as
          // bare "@cf/..." ids. Third-party providers must not receive the token; they rely on the
          // gateway's stored/BYOK keys instead.
          // Workers AI is Cloudflare's own upstream, so it rides the unified compat route with the
          // Cloudflare token as its upstream Authorization header.
          const isWorkersAi = modelID.startsWith("workers-ai/") || modelID.startsWith("@cf/")
          if (isWorkersAi) return aigateway(createUnified({ apiKey: apiToken })(modelID))

          // Every other third-party provider (google, xai, alibaba, deepseek, moonshotai, …) is only
          // served by Cloudflare's catalog-aware REST API. The universal/compat gateway route rejects
          // them with "Invalid provider" (the gateway's compat endpoint doesn't front those upstreams),
          // so point an OpenAI-compatible client at the REST endpoint and bind it to the gateway with
          // cf-aig-gateway-id — that keeps requests gateway-routed (analytics/caching/BYOK), not a
          // bypass. models.dev ids (provider/model, dotted) pass through unchanged.
          return createOpenAICompatible({
            name: "cloudflare-ai-gateway",
            baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
            apiKey: apiToken,
            headers: { "cf-aig-gateway-id": gateway },
          })(modelID)
        },
        options: {},
      }
    }),
    cerebras: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": PRODUCT_SLUG,
          },
        },
      }),
    kilo: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": PRODUCT_REPOSITORY_URL,
            "X-Title": PRODUCT_NAME,
          },
        },
      }),
    claude: () =>
      Effect.gen(function* () {
        // Match @openchamber/opencode-claude: bundled openai-compatible SDK +
        // dummy proxy key so getLanguage never tries to import Agent SDK as a
        // create* factory. Agent SDK stays lazy in the session runtime adapter.
        const { discoverPure, migrateLegacyReference } = yield* Effect.promise(() =>
          import("../claude/provider").then((m) => ({
            discoverPure: m.ClaudeProvider.discoverPure,
            migrateLegacyReference: m.ClaudeProvider.migrateLegacyReference,
          })),
        )
        const { getClaudeSubscriptionModelMetadata, PROVIDER_ID, modelApi } = yield* Effect.promise(() =>
          import("../claude/models").then((m) => ({
            getClaudeSubscriptionModelMetadata: m.getClaudeSubscriptionModelMetadata,
            PROVIDER_ID: m.PROVIDER_ID,
            modelApi: m.modelApi,
          })),
        )

        const discovery = discoverPure()
        const enabled = yield* Effect.sync(() => {
          return shouldEnableClaudeFirstParty()
        }).pipe(Effect.catch(() => Effect.succeed(true)))

        return {
          autoload: Boolean(enabled),
          options: {
            apiKey: PROXY_API_KEY,
            includeUsage: true,
            baseURL: PROXY_BASE_URL,
            providerID: String(PROVIDER_ID),
            status: discovery.status,
            errorCategory: discovery.errorCategory,
          },
          async getModel(sdk: any, modelID: string) {
            const canonical = migrateLegacyReference(modelID) ?? modelID
            if (sdk.chat) return sdk.chat(canonical)
            return sdk.languageModel(canonical)
          },
          async discoverModels(): Promise<Record<string, Model>> {
            const result: Record<string, Model> = {}
            const metadata = getClaudeSubscriptionModelMetadata(dep.modelsDev()["anthropic"])
            for (const [id, meta] of Object.entries(metadata)) {
              result[id] = {
                id: ModelV2.ID.make(id),
                providerID: PROVIDER_ID,
                name: meta.name,
                family: meta.family,
                api: modelApi(id),
                status: meta.status === "unavailable" ? "unavailable" : meta.status,
                headers: {},
                options: { includeUsage: true },
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: {
                  context: meta.contextLimit,
                  input: meta.contextLimit >= 1_000_000 ? Math.round(meta.contextLimit * 0.9) : undefined,
                  output: meta.outputLimit,
                },
                capabilities: meta.capabilities,
                release_date: meta.releaseDate,
                variants: meta.variants,
              } as Model
            }
            return result
          },
        }
      }),
    "snowflake-cortex": Effect.fnUntraced(function* (input: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(input.id)

      const account =
        env["SNOWFLAKE_ACCOUNT"] ??
        (auth?.type === "api" ? auth.metadata?.account : undefined) ??
        (auth?.type === "oauth" ? auth.accountId : undefined) ??
        input.options?.account

      const envToken = env["SNOWFLAKE_CORTEX_TOKEN"] ?? env["SNOWFLAKE_CORTEX_PAT"]
      const apiKeyToken = auth?.type === "api" ? auth.key : undefined
      const oauthToken = auth?.type === "oauth" ? auth.access : undefined
      const configToken = input.options?.token ?? input.options?.apiKey

      const token = envToken ?? apiKeyToken ?? oauthToken ?? configToken

      if (!account || !token) {
        const missing = [!account && "SNOWFLAKE_ACCOUNT", !token && "SNOWFLAKE_CORTEX_TOKEN"].filter(Boolean).join(", ")
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              `Snowflake Cortex: missing credentials (${missing}). Provide a bearer token (OAuth, JWT, or PAT) via env var, opencode auth, or provider options.`,
            )
          },
        }
      }

      const baseURL = `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`

      const options: Record<string, any> = { baseURL, apiKey: token }

      // Only skip provider-level fetch when the token is from OAuth with no override.
      // For OAuth tokens, the plugin auth loader's combined fetch handles
      // OAuth refresh + snowflake transformations in one place.
      // For env/config/API-key tokens, the provider fetch applies snowflake
      // transformations directly.
      const useOAuthHandler =
        oauthToken !== undefined && envToken === undefined && apiKeyToken === undefined && configToken === undefined
      if (!useOAuthHandler) {
        options.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.body && typeof init.body === "string") {
            try {
              const body = JSON.parse(init.body)
              if ("max_tokens" in body) {
                body.max_completion_tokens = body.max_tokens
                delete body.max_tokens
                init = { ...init, body: JSON.stringify(body) }
              }
            } catch {}
          }

          const response = await fetch(url, init)

          if (!response.ok && response.status === 400) {
            try {
              const errorData = await response.clone().json()
              const errorMessage = String(errorData.message || errorData.error || "")
              if (errorMessage.toLowerCase().includes("conversation complete")) {
                return new Response(
                  JSON.stringify({
                    choices: [{ finish_reason: "stop", message: { content: "", role: "assistant" } }],
                  }),
                  { status: 200, headers: new Headers({ "content-type": "application/json" }) },
                )
              }
            } catch {}
          }

          if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
            const reader = response.body.getReader()
            const encoder = new TextEncoder()
            const decoder = new TextDecoder()
            const stream = new ReadableStream({
              async pull(ctrl) {
                const { done, value } = await reader.read()
                if (done) {
                  ctrl.close()
                  return
                }
                const text = decoder.decode(value, { stream: true })
                ctrl.enqueue(encoder.encode(text.replace(/"role"\s*:\s*""/g, '"role":"assistant"')))
              },
              cancel() {
                reader.cancel()
              },
            })
            return new Response(stream, { headers: response.headers, status: response.status })
          }

          return response
        }
      }

      return {
        autoload: input.source === "config",
        options,
      }
    }),
    genspark: Effect.fnUntraced(function* (input: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(input.id)
      let apiKey = yield* Effect.promise(() =>
        resolveGensparkApiKey({
          authKey: auth?.type === "api" ? auth.key : undefined,
          env,
        }),
      )
      if (!apiKey) {
        const fallbackConfig = yield* Effect.promise(() => readGensparkKeyFromFallbackConfig()).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (fallbackConfig) apiKey = fallbackConfig
      }
      if (!apiKey) {
        const fallback = GENSPARK_MODEL_METADATA
        input.models = Object.fromEntries(
          Object.entries(fallback).map(([id, meta]) => [
            id,
            {
              id: ModelV2.ID.make(id),
              providerID: input.id,
              name: meta.name,
              family: meta.family,
              api: { id, url: gensparkApiURL(), npm: "@ai-sdk/openai-compatible" },
              status: "active",
              headers: {},
              options: {},
              cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
              limit: { context: meta.limit.context, input: meta.limit.input, output: meta.limit.output },
              capabilities: meta.capabilities,
              release_date: "",
              variants: meta.variants,
            } as Model,
          ]),
        )
        return { autoload: true, options: { ...GENSPARK_PROXY_OPTION } }
      }
      // The legacy fallback for the no-key case is handled by the quota
      // adapter (which reads openfork.json first and legacy .opencode.json as a fallback) and by the user
      // migrating the key to Auth/env.
      const catalog = yield* dep.gensparkCatalog(apiKey)
      // Replacement, not merge: the live endpoint is authoritative. The static
      // snapshot in catalog.ts is only the offline/no-credential fallback, so
      // merging it in would let stale entries shadow current ones. The add-only
      // discovery hook below cannot express this, hence doing it here.
      input.models = Object.fromEntries(
        Object.entries(catalog.models).map(([id, meta]) => [
          id,
          {
            id: ModelV2.ID.make(id),
            providerID: input.id,
            name: meta.name,
            family: meta.family,
            api: { id, url: gensparkApiURL(), npm: "@ai-sdk/openai-compatible" },
            status: "active",
            headers: {},
            options: {},
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: meta.limit.context, input: meta.limit.input, output: meta.limit.output },
            capabilities: meta.capabilities,
            release_date: "",
            variants: meta.variants,
          } as Model,
        ]),
      )
      return {
        autoload: true,
        options: apiKey ? { ...GENSPARK_PROXY_OPTION, apiKey } : { ...GENSPARK_PROXY_OPTION },
      }
    }),
  }
}

const ProviderApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
})

const ProviderModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const ProviderInterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

const ProviderInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: ProviderInterleavedField,
  }),
])

const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: ProviderModalities,
  output: ProviderModalities,
  interleaved: ProviderInterleaved,
})

const ProviderCacheCost = Schema.Struct({
  read: Schema.Finite,
  write: Schema.Finite,
})

const ProviderCostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const ProviderCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tiers: optional(Schema.Array(ProviderCostTier)),
  experimentalOver200K: optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache: ProviderCacheCost,
    }),
  ),
})

const ProviderLimit = Schema.Struct({
  context: Schema.Finite,
  input: optional(Schema.Finite),
  output: Schema.Finite,
})

export const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  api: ProviderApiInfo,
  name: Schema.String,
  family: optional(Schema.String),
  primitive: optional(ModelV2.Primitive),
  capabilities: ProviderCapabilities,
  cost: ProviderCost,
  limit: ProviderLimit,
  status: ModelStatus,
  options: Schema.Record(Schema.String, Schema.Any),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  variants: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
}).annotate({ identifier: "Model" })
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export function modelPrimitive(model: Pick<Model, "primitive">): ModelV2.Primitive {
  return model.primitive ?? "language"
}

export function isLanguageModel(
  model: Pick<Model, "id" | "providerID" | "name" | "family" | "primitive">,
) {
  return ModelV2.isLanguageModel(model.providerID, model)
}

export const Info = Schema.Struct({
  id: ProviderV2.ID,
  name: Schema.String,
  source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String),
  key: optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any),
  models: Schema.Record(Schema.String, Model),
}).annotate({ identifier: "Provider" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

const DefaultModelIDs = Schema.Record(Schema.String, Schema.String)

export const ListResult = Schema.Struct({
  all: Schema.Array(Info),
  default: DefaultModelIDs,
  connected: Schema.Array(Schema.String),
  catalog: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["pending", "partial", "ready"]),
      revision: Schema.Int,
    }),
  ),
})
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

export const ConfigProvidersResult = Schema.Struct({
  providers: Schema.Array(Info),
  default: DefaultModelIDs,
})
export type ConfigProvidersResult = Types.DeepMutable<Schema.Schema.Type<typeof ConfigProvidersResult>>

export function toPublicInfo(provider: Info): Info {
  return JSON.parse(
    JSON.stringify(
      {
        ...provider,
        models: Object.fromEntries(Object.entries(provider.models).filter(([, model]) => Schema.is(Model)(model))),
      },
      (_, value) => {
        if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined
        if (typeof value === "bigint") return value.toString()
        return value
      },
    ),
  )
}

export function defaultModelIDs<
  T extends {
    models: Record<
      string,
      { id: string; primitive?: ModelV2.Primitive; name?: string; family?: string }
    >
  },
>(providers: Record<string, T>) {
  return Object.fromEntries(
    Object.entries(providers).flatMap(([providerID, provider]) => {
      const model = sort(
        Object.values(provider.models).filter((item) => ModelV2.isLanguageModel(providerID, item)),
      )[0]
      if (!model) return []
      return [[providerID, model.id] as const]
    }),
  )
}

export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()("ProviderModelNotFoundError", {
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  suggestions: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const suggestions = this.suggestions?.length ? ` Did you mean: ${this.suggestions.join(", ")}?` : ""
    return `Model not found: ${this.providerID}/${this.modelID}.${suggestions}`
  }

  static isInstance(input: unknown): input is ModelNotFoundError {
    return input instanceof ModelNotFoundError
  }
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("ProviderInitError", {
  providerID: ProviderV2.ID,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Failed to initialize provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is InitError {
    return input instanceof InitError
  }
}

export class NoProvidersError extends Schema.TaggedErrorClass<NoProvidersError>()("ProviderNoProvidersError", {}) {
  override get message() {
    return "No providers are available"
  }

  static isInstance(input: unknown): input is NoProvidersError {
    return input instanceof NoProvidersError
  }
}

export class NoModelsError extends Schema.TaggedErrorClass<NoModelsError>()("ProviderNoModelsError", {
  providerID: ProviderV2.ID,
}) {
  override get message() {
    return `No models are available for provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is NoModelsError {
    return input instanceof NoModelsError
  }
}

export class UnsupportedModelPrimitiveError extends Schema.TaggedErrorClass<UnsupportedModelPrimitiveError>()(
  "ProviderUnsupportedModelPrimitiveError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    primitive: ModelV2.Primitive,
    required: ModelV2.Primitive,
  },
) {
  override get message() {
    return `Model ${this.providerID}/${this.modelID} uses the ${this.primitive} primitive and cannot be used as a ${this.required} model`
  }
}

export class AccountResolutionError extends Schema.TaggedErrorClass<AccountResolutionError>()(
  "ProviderAccountResolutionError",
  {
    providerID: ProviderV2.ID,
    selector: Schema.String,
    reason: Schema.Literals(["unsupported", "not-found", "ambiguous", "unavailable"]),
    matches: Schema.optional(Schema.Array(Schema.String)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    if (this.reason === "unsupported") {
      return `Provider ${this.providerID} does not expose first-class account selection`
    }
    if (this.reason === "ambiguous") {
      return `Provider account selector "${this.selector}" is ambiguous for ${this.providerID}; use the stable account id`
    }
    if (this.reason === "unavailable") {
      return `Provider account roster is unavailable for ${this.providerID}`
    }
    return `Provider account selector "${this.selector}" is unavailable for ${this.providerID}`
  }
}

export class RouteResolutionError extends Schema.TaggedErrorClass<RouteResolutionError>()(
  "ProviderRouteResolutionError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Provider route unavailable: ${this.providerID}/${this.modelID}`
  }
}

export type DefaultModelError = ModelNotFoundError | NoProvidersError | NoModelsError
export type Error =
  | ModelNotFoundError
  | InitError
  | NoProvidersError
  | NoModelsError
  | UnsupportedModelPrimitiveError
  | AccountResolutionError
  | RouteResolutionError

export interface RoutedModel {
  readonly model: Model
  readonly route: OpencodeProviderRoute.Resolution
}

export interface TransientRoutedModel {
  readonly model: Model
  readonly route: OpencodeProviderRoute.TransientResolution
  /**
   * Exact physical transport of this same resolution, produced where the
   * selected credential is already in hand.
   *
   * `apiKey` is the live credential of the selected route: the account secret
   * for an account route, or the hosted public sentinel for a Public route. It
   * exists only in process, alongside the route that selected it, and must
   * never be persisted, logged, settled, or copied into route or usage
   * attribution. Consuming it is transport materialization of an already-made
   * decision, never a second authorization surface.
   */
  readonly transport: RouteTransport
}

/**
 * Exact physical transport of one already-resolved route.
 *
 * `apiKey` is the live credential of the selected route: the account secret for
 * an account route, or the hosted public sentinel for a Public route. It is
 * returned only to the in-process caller that already holds the committed
 * route and must never be persisted, logged, settled, or copied into route or
 * usage attribution. This materializes a decision that has already been made;
 * it is never a second authorization surface.
 */
export interface RouteTransport {
  readonly baseURL: string
  readonly apiKey: string
  readonly headers: Readonly<Record<string, string>>
}

/**
 * OpenCode-operated hosted providers.
 *
 * Their credentials and routing belong to the account/Public route authority,
 * so "this provider/model has no authoritative route" must fail closed instead
 * of degrading to ambient provider options, provider env values, a legacy
 * default pool account, or a direct catalog key. Third-party providers keep
 * their mature direct path.
 */
const HOSTED_ZEN_PROVIDERS: ReadonlySet<string> = new Set(["opencode", "opencode-go"])

export function isHostedZenProvider(providerID: string): boolean {
  return HOSTED_ZEN_PROVIDERS.has(providerID)
}

const noHostedRouteError = (providerID: ProviderV2.ID, modelID: ModelV2.ID) =>
  Effect.fail(
    new RouteResolutionError({
      providerID,
      modelID,
      cause: new Error(
        "No authoritative OpenCode route resolved for this hosted provider; refusing ambient credential fallback",
      ),
    }),
  )

/**
 * Transitional Zen/Go API-key compatibility inside the same route authority.
 *
 * Plan 7.5/12.1 keep existing Zen/Go API-key accounts working, and plan 7.5
 * already derives their secret-free identity from the key
 * (`zen-accounts.stableZenIdentity`). Those keys never become a durable
 * ProviderAccount row here: they are projected as opaque, secret-free
 * compatibility candidates so the existing ProviderAccountPolicy and
 * ProviderRoute own selection, Public/account semantics, and attribution.
 *
 * The handle carries no secret and no key material. A key change produces a
 * different `zen-*` identity, and therefore a different handle, so a stable
 * revision of 1 is exact: revision 1 means "this compatibility identity".
 */
const ZEN_COMPAT_HANDLE_PREFIX = "zen-compat:"
const ZEN_COMPAT_REVISION = 1

const isZenCompatHandle = (handle: string) => handle.startsWith(ZEN_COMPAT_HANDLE_PREFIX)
const zenCompatHandle = (accountID: string) => `${ZEN_COMPAT_HANDLE_PREFIX}${accountID}`

export interface ZenCompatExecution {
  readonly accountID: string
  readonly apiKey: string
}

/**
 * Secret-free account-scoped discovery row used by compatibility/inspection
 * surfaces. This is deliberately not the canonical provider catalog: normal
 * OpenFork discovery remains account-neutral and deduplicated.
 */
export interface AccountModelProjection {
  readonly accountID: string
  readonly accountLabel: string
  readonly provider: Info
  readonly model: Model
}

const zenCompatSourceName = (source: string): ProviderAccount.Source =>
  source === "env" ? "env" : source === "vault" ? "fork-vault" : "legacy"



export interface Interface {
  readonly list: () => Effect.Effect<Record<ProviderV2.ID, Info>>
  readonly listAccountModelProjections: () => Effect.Effect<readonly AccountModelProjection[]>
  readonly getProvider: (providerID: ProviderV2.ID, model?: Model) => Effect.Effect<Info>
  /**
   * Resolve a stable provider account id from either that exact id or one
   * unique human-facing label/alias published by the live provider.
   */
  readonly resolveAccountID: (
    providerID: ProviderV2.ID,
    selector: string,
  ) => Effect.Effect<string, AccountResolutionError>
  /**
   * Resolve an account-neutral model selection. accountID remains first-class
   * above this provider boundary; legacy account-qualified catalog ids are
   * materialized only here.
   */
  readonly getModel: (
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    accountID?: string,
  ) => Effect.Effect<Model, ModelNotFoundError>
  /**
   * Resolve one committed OpenCode ProviderRoute and materialize the exact model
   * transport for that lease. Returns undefined only for intentionally legacy
   * provider/account surfaces that have not entered P5A routing yet.
   */
  readonly resolveRoutedModel: (input: {
    readonly sessionID: CoreSessionSchema.ID
    readonly providerID: ProviderV2.ID
    readonly modelID: ModelV2.ID
    readonly accountID?: string
    readonly routeIntent?: ProviderRouteIntent.Info
    readonly allowPublic?: boolean
  }) => Effect.Effect<RoutedModel | undefined, ModelNotFoundError | RouteResolutionError>
  /**
   * Materialize a maintenance/special-agent model from the exact parent route
   * generation. This path never selects, binds, rebinds, or fails over.
   */
  readonly resolveInheritedRoutedModel: (input: {
    readonly sessionID: CoreSessionSchema.ID
    readonly providerID: ProviderV2.ID
    readonly modelID: ModelV2.ID
    readonly route: ProviderRouteResolution.RouteAttribution
    readonly allowPublic?: boolean
  }) => Effect.Effect<RoutedModel, ModelNotFoundError | RouteResolutionError>
  /**
   * Resolve one non-persistent provider route for a standalone primitive.
   * No Session/ProviderRoute row is created and no affinity is promised across calls.
   */
  readonly resolveTransientRoutedModel: (input: {
    readonly providerID: ProviderV2.ID
    readonly modelID: ModelV2.ID
    readonly accountID?: string
    readonly routeIntent?: ProviderRouteIntent.Info
    readonly allowPublic?: boolean
  }) => Effect.Effect<TransientRoutedModel | undefined, ModelNotFoundError | RouteResolutionError>
  readonly getLanguage: (
    model: Model,
  ) => Effect.Effect<LanguageModelV3, ModelNotFoundError | UnsupportedModelPrimitiveError>
  readonly closest: (
    providerID: ProviderV2.ID,
    query: string[],
  ) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: string } | undefined>
  readonly getSmallModel: (providerID: ProviderV2.ID) => Effect.Effect<Model | undefined>
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }, DefaultModelError>
}

interface ConsoleBinding {
  readonly account: ConsoleAccountExecution
  readonly provider: AccountProviderCapability
  readonly providerInfo: Info
  readonly client: ConsoleClientIdentity
}

function stringHeaderRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

/**
 * Physical transport of one already-selected route.
 *
 * `info` must be the bound provider info of that exact route, never an ambient
 * provider record: a Public route passes the stripped catalog clone and an
 * account route passes the account capability projection. `apiKey` is supplied
 * by the route owner and is never derived from configuration here.
 */
function routeTransport(info: Info, model: Model, apiKey: string): RouteTransport {
  const options = { ...info.options, ...model.options }
  const baseURL =
    (typeof options.baseURL === "string" && options.baseURL.trim() ? options.baseURL : undefined) ?? model.api.url
  return {
    baseURL,
    apiKey,
    headers: { ...stringHeaderRecord(options.headers), ...model.headers },
  }
}

interface PublicBinding {
  readonly providerInfo: Info
}

/**
 * A committed transitional Zen/Go account route.
 *
 * `providerInfo` is secret-free and carries only the route-locked hosted fetch,
 * so any consumer that reads the provider view still cannot obtain the key.
 * `secret` exists only in process, for the exact transport constructor.
 */
interface ZenCompatBinding {
  readonly providerInfo: Info
  readonly accountID: string
  readonly secret: string
}

interface ConsoleGenerationSlot {
  generation: string
  credentialRevision: number
  configVersion: number
  lastUsed: number
  sdkKeys: Set<string>
  modelKeys: Set<string>
}

interface State {
  models: Map<string, LanguageModelV3>
  providers: Record<ProviderV2.ID, Info>
  catalog: Record<ProviderV2.ID, Info>
  readonly modelsDev: Record<string, ModelsDev.Provider>
  claudeCatalogRevision: number
  sdk: Map<string, BundledSDK>
  modelLoaders: Record<string, CustomModelLoader>
  varsLoaders: Record<string, CustomVarsLoader>
  discoveryLoaders: Record<string, DiscoveryLoader>
  discoveryPromises: Map<string, Promise<void>>
  initializeProvider: (providerID: ProviderV2.ID) => Effect.Effect<void>
  ensureSelectedCatalogProvider: (providerID: ProviderV2.ID) => Effect.Effect<void>
  initializerIDs: readonly ProviderV2.ID[]
  materializationRevision: () => number
  config: ConfigV1.Info
  accountLoaders: Record<string, () => Promise<readonly ProviderAccountIdentity[]>>
  consoleBindings: WeakMap<Model, ConsoleBinding>
  publicBindings: WeakMap<Model, PublicBinding>
  zenCompatBindings: WeakMap<Model, ZenCompatBinding>
  consoleGenerations: Map<string, ConsoleGenerationSlot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Provider") {}

export const use = serviceUse(Service)

function cost(c: ModelsDev.Model["cost"]): Model["cost"] {
  const result: Model["cost"] = {
    input: c?.input ?? 0,
    output: c?.output ?? 0,
    cache: {
      read: c?.cache_read ?? 0,
      write: c?.cache_write ?? 0,
    },
  }
  if (c?.tiers) {
    result.tiers = c.tiers.map((item) => ({
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read ?? 0,
        write: item.cache_write ?? 0,
      },
      tier: item.tier,
    }))
  }
  if (c?.context_over_200k) {
    result.experimentalOver200K = {
      cache: {
        read: c.context_over_200k.cache_read ?? 0,
        write: c.context_over_200k.cache_write ?? 0,
      },
      input: c.context_over_200k.input,
      output: c.context_over_200k.output,
    }
  }
  return result
}

function zeroCostEntry(input: {
  input: number
  output: number
  cache: { read: number; write: number }
}) {
  return input.input === 0 && input.output === 0 && input.cache.read === 0 && input.cache.write === 0
}

/**
 * Trusted anonymous/public eligibility from the raw Models.dev pricing record.
 *
 * Missing pricing is unknown, not free. When pricing exists, a zero input rate
 * alone is still insufficient: output, cache, and every published context tier
 * must also be zero. Explicit source-backed promotional overrides, when needed,
 * belong in a separate exact-model compatibility layer rather than weakening
 * this predicate.
 */
export function isTrustedZeroCostCatalogModel(model: Pick<ModelsDev.Model, "cost"> | undefined) {
  if (!model?.cost) return false
  const normalized = cost(model.cost)
  if (!zeroCostEntry(normalized)) return false
  if (normalized.tiers?.some((tier) => !zeroCostEntry(tier))) return false
  if (normalized.experimentalOver200K && !zeroCostEntry(normalized.experimentalOver200K)) return false
  return true
}

// Cloudflare AI Gateway routes OpenAI and Anthropic models through their native
// passthrough SDKs (Responses / Messages APIs). Resolving the native npm before
// variants are computed makes reasoning variants produce payloads the native
// SDKs understand (e.g. anthropic `effort` instead of compat `reasoningEffort`).
function cloudflareGatewayNpm(providerID: string, modelID: string) {
  if (providerID !== "cloudflare-ai-gateway") return undefined
  if (modelID.startsWith("openai/")) return "@ai-sdk/openai"
  if (modelID.startsWith("anthropic/")) return "@ai-sdk/anthropic"
  return undefined
}

function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
  const base: Model = {
    id: ModelV2.ID.make(model.id),
    providerID: ProviderV2.ID.make(provider.id),
    name: model.name,
    family: model.family,
    primitive: ModelsDev.modelPrimitive(provider.id, model),
    api: {
      id: model.id,
      url: model.provider?.api ?? provider.api ?? "",
      npm:
        cloudflareGatewayNpm(provider.id, model.id) ??
        model.provider?.npm ??
        provider.npm ??
        "@ai-sdk/openai-compatible",
    },
    status: model.status ?? "active",
    headers: {},
    options: {},
    cost: cost(model.cost),
    limit: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    capabilities: {
      temperature: model.temperature ?? false,
      reasoning: model.reasoning ?? false,
      attachment: model.attachment ?? false,
      toolcall: model.tool_call ?? true,
      input: {
        text: model.modalities?.input?.includes("text") ?? false,
        audio: model.modalities?.input?.includes("audio") ?? false,
        image: model.modalities?.input?.includes("image") ?? false,
        video: model.modalities?.input?.includes("video") ?? false,
        pdf: model.modalities?.input?.includes("pdf") ?? false,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? false,
        audio: model.modalities?.output?.includes("audio") ?? false,
        image: model.modalities?.output?.includes("image") ?? false,
        video: model.modalities?.output?.includes("video") ?? false,
        pdf: model.modalities?.output?.includes("pdf") ?? false,
      },
      interleaved: typeof model.interleaved === "string" ? { field: model.interleaved } : (model.interleaved ?? false),
    },
    release_date: model.release_date ?? "",
    variants: {},
  }

  const variants = ProviderTransform.reasoningVariants(model, base) ?? ProviderTransform.variants(base)

  return {
    ...base,
    variants: mapValues(variants, (v) => v),
  }
}

export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
  const models: Record<string, Model> = {}
  for (const [key, model] of Object.entries(provider.models)) {
    models[key] = fromModelsDevModel(provider, model)
    for (const [mode, opts] of Object.entries(model.experimental?.modes ?? {})) {
      const id = `${model.id}-${mode}`
      const base = fromModelsDevModel(provider, model)
      models[id] = {
        ...base,
        id: ModelV2.ID.make(id),
        name: `${model.name} ${mode[0].toUpperCase()}${mode.slice(1)}`,
        cost: opts.cost ? mergeDeep(base.cost, cost(opts.cost)) : base.cost,
        options: modeOptions(base, opts.provider?.body),
        headers: opts.provider?.headers ?? base.headers,
      }
    }
  }
  return {
    id: ProviderV2.ID.make(provider.id),
    source: "custom",
    name: provider.name,
    env: [...(provider.env ?? [])],
    options: {},
    models,
  }
}

/**
 * Apply one explicit V1 provider config to the materialized catalog provider.
 * Both the execution state and the bootstrap-free provider catalog use this
 * projection so custom models, aliases, model defaults, and variants have one
 * authoritative transform.
 */
export function fromConfigProvider(
  providerID: string,
  provider: NonNullable<ConfigV1.Info["provider"]>[string],
  existing: Info | undefined,
  modelsDev: Record<string, ModelsDev.Provider>,
): Info {
  const parsed: Info = {
    id: ProviderV2.ID.make(providerID),
    name: provider.name ?? existing?.name ?? providerID,
    env: provider.env ?? existing?.env ?? [],
    options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
    source: "config",
    models: existing?.models ?? {},
  }

  for (const [modelID, model] of Object.entries(provider.models ?? {})) {
    const existingModel = parsed.models[model.id ?? modelID]
    const apiID = model.id ?? existingModel?.api.id ?? modelID
    const apiNpm =
      model.provider?.npm ??
      provider.npm ??
      existingModel?.api.npm ??
      cloudflareGatewayNpm(providerID, apiID) ??
      modelsDev[providerID]?.npm ??
      "@ai-sdk/openai-compatible"
    const name = iife(() => {
      if (model.name) return model.name
      if (model.id && model.id !== modelID) return modelID
      return existingModel?.name ?? modelID
    })
    const parsedModel: Model = {
      id: ModelV2.ID.make(modelID),
      api: {
        id: apiID,
        npm: apiNpm,
        url:
          model.provider?.api ??
          provider.api ??
          existingModel?.api.url ??
          (typeof provider.options?.baseURL === "string" && provider.options.baseURL.trim() !== ""
            ? provider.options.baseURL
            : undefined) ??
          modelsDev[providerID]?.api ??
          "",
      },
      status: model.status ?? existingModel?.status ?? "active",
      name,
      providerID: ProviderV2.ID.make(providerID),
      primitive: model.primitive ?? existingModel?.primitive ?? ModelsDev.modelPrimitive(providerID, { id: apiID }),
      capabilities: {
        temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
        reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
        attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
        toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
        input: {
          text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
          audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
          image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
          video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
          audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
          image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
          video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
        },
        interleaved:
          (typeof model.interleaved === "string" ? { field: model.interleaved } : model.interleaved) ??
          existingModel?.capabilities.interleaved ??
          (!existingModel && apiNpm === "@ai-sdk/openai-compatible" && apiID.includes("deepseek")
            ? { field: "reasoning_content" }
            : false),
      },
      cost: {
        input: model.cost?.input ?? existingModel?.cost.input ?? 0,
        output: model.cost?.output ?? existingModel?.cost.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? existingModel?.cost.cache.read ?? 0,
          write: model.cost?.cache_write ?? existingModel?.cost.cache.write ?? 0,
        },
      },
      options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
      limit: {
        context: model.limit?.context ?? existingModel?.limit.context ?? 0,
        input: model.limit?.input ?? existingModel?.limit.input,
        output: model.limit?.output ?? existingModel?.limit.output ?? 0,
      },
      headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
      family: model.family ?? existingModel?.family ?? "",
      release_date: model.release_date ?? existingModel?.release_date ?? "",
      variants: {},
    }
    const variants =
      existingModel?.api.npm === parsedModel.api.npm
        ? (existingModel.variants ?? ProviderTransform.variants(parsedModel))
        : ProviderTransform.variants(parsedModel)
    const merged = mergeDeep(variants, model.variants ?? {})
    parsedModel.variants = mapValues(
      pickBy(merged, (v) => !v.disabled),
      (v) => omit(v, ["disabled"]),
    )
    parsed.models[modelID] = parsedModel
  }
  return parsed
}

function modeOptions(model: Model, body: Record<string, unknown> | undefined) {
  if (!body) return model.options
  const options = Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value]),
  )
  const reasoning = body.reasoning
  if (model.api.npm !== "@ai-sdk/openai" || !isRecord(reasoning) || typeof reasoning.mode !== "string") return options
  const { reasoning: _, ...rest } = options
  return { ...rest, reasoningMode: reasoning.mode }
}

function modelSuggestions(provider: Info | undefined, modelID: ModelV2.ID, enableExperimentalModels: boolean) {
  const available = provider
    ? Object.keys(provider.models).filter((id) => {
        const model = provider.models[id]
        if (model.status === "deprecated") return false
        if (model.status === "alpha" && !enableExperimentalModels) return false
        return true
      })
    : []
  const fuzzy = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 }).map((m) => m.target)
  if (fuzzy.length) return fuzzy
  const query = modelID
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1)
  return sortBy(
    available
      .map((id) => ({
        id,
        score: query.filter((part) => id.toLowerCase().includes(part)).length,
      }))
      .filter((item) => item.score > 0),
    [(item) => item.score, "desc"],
    [(item) => item.id, "asc"],
  )
    .slice(0, 3)
    .map((item) => item.id)
}

const consoleRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})
const consoleString = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)
const consoleFinite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const consoleBoolean = (value: unknown) => (typeof value === "boolean" ? value : undefined)

export function consoleModel(
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  capability: AccountProviderCapability,
  base?: Model,
): Model | undefined {
  const accountModel = capability.models[modelID]
  if (!accountModel) return undefined
  const raw = accountModel.config
  const rawProvider = consoleRecord(raw.provider)
  const rawCost = consoleRecord(raw.cost)
  const rawLimit = consoleRecord(raw.limit)
  const rawModalities = consoleRecord(raw.modalities)
  const rawInput = Array.isArray(rawModalities.input) ? rawModalities.input : undefined
  const rawOutput = Array.isArray(rawModalities.output) ? rawModalities.output : undefined
  const rawOver200K = consoleRecord(rawCost.context_over_200k)
  const providerBaseURL = consoleString(capability.options.baseURL)

  const apiNpm =
    consoleString(rawProvider.npm) ??
    capability.npm ??
    base?.api.npm ??
    "@ai-sdk/openai-compatible"
  const apiURL =
    consoleString(rawProvider.api) ??
    capability.api ??
    providerBaseURL ??
    base?.api.url ??
    ""

  const accountCost = Object.keys(rawCost).length
    ? {
        input: consoleFinite(rawCost.input) ?? base?.cost.input ?? 0,
        output: consoleFinite(rawCost.output) ?? base?.cost.output ?? 0,
        cache: {
          read: consoleFinite(rawCost.cache_read) ?? base?.cost.cache.read ?? 0,
          write: consoleFinite(rawCost.cache_write) ?? base?.cost.cache.write ?? 0,
        },
        ...(Object.keys(rawOver200K).length
          ? {
              experimentalOver200K: {
                input: consoleFinite(rawOver200K.input) ?? 0,
                output: consoleFinite(rawOver200K.output) ?? 0,
                cache: {
                  read: consoleFinite(rawOver200K.cache_read) ?? 0,
                  write: consoleFinite(rawOver200K.cache_write) ?? 0,
                },
              },
            }
          : {}),
      }
    : base?.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } }

  const accountLimit = Object.keys(rawLimit).length
    ? {
        context: consoleFinite(rawLimit.context) ?? base?.limit.context ?? 0,
        input: consoleFinite(rawLimit.input) ?? base?.limit.input,
        output: consoleFinite(rawLimit.output) ?? base?.limit.output ?? 0,
      }
    : base?.limit ?? { context: 0, input: undefined, output: 0 }

  const interleaved = raw.interleaved
  const status = consoleString(raw.status)
  const primitive = consoleString(raw.primitive)
  const parsed: Model = {
    id: modelID,
    providerID,
    api: { id: accountModel.apiID, npm: apiNpm, url: apiURL },
    name: consoleString(raw.name) ?? base?.name ?? modelID,
    family: consoleString(raw.family) ?? base?.family ?? "",
    primitive: (primitive as ModelV2.Primitive | undefined) ?? base?.primitive ?? "language",
    status:
      status === "alpha" || status === "beta" || status === "deprecated" || status === "active"
        ? status
        : (base?.status ?? "active"),
    capabilities: {
      temperature: consoleBoolean(raw.temperature) ?? base?.capabilities.temperature ?? false,
      reasoning: consoleBoolean(raw.reasoning) ?? base?.capabilities.reasoning ?? false,
      attachment: consoleBoolean(raw.attachment) ?? base?.capabilities.attachment ?? false,
      toolcall: consoleBoolean(raw.tool_call) ?? base?.capabilities.toolcall ?? true,
      input: {
        text: rawInput?.includes("text") ?? base?.capabilities.input.text ?? true,
        audio: rawInput?.includes("audio") ?? base?.capabilities.input.audio ?? false,
        image: rawInput?.includes("image") ?? base?.capabilities.input.image ?? false,
        video: rawInput?.includes("video") ?? base?.capabilities.input.video ?? false,
        pdf: rawInput?.includes("pdf") ?? base?.capabilities.input.pdf ?? false,
      },
      output: {
        text: rawOutput?.includes("text") ?? base?.capabilities.output.text ?? true,
        audio: rawOutput?.includes("audio") ?? base?.capabilities.output.audio ?? false,
        image: rawOutput?.includes("image") ?? base?.capabilities.output.image ?? false,
        video: rawOutput?.includes("video") ?? base?.capabilities.output.video ?? false,
        pdf: rawOutput?.includes("pdf") ?? base?.capabilities.output.pdf ?? false,
      },
      interleaved:
        typeof interleaved === "string"
          ? { field: interleaved as any }
          : typeof interleaved === "boolean" || isRecord(interleaved)
            ? (interleaved as Model["capabilities"]["interleaved"])
            : (base?.capabilities.interleaved ?? false),
    },
    cost: accountCost,
    limit: accountLimit,
    // Account-bound execution never inherits local/config auth-bearing
    // options or headers. Console config is authoritative for transport state.
    options: consoleRecord(raw.options),
    headers: mergeDeep(capability.headers ?? {}, consoleRecord(raw.headers) as Record<string, string>),
    release_date: consoleString(raw.release_date) ?? base?.release_date ?? "",
    variants: base?.variants ?? {},
  }

  const configuredVariants = consoleRecord(raw.variants)
  if (Object.keys(configuredVariants).length > 0) {
    const merged = mergeDeep(parsed.variants ?? ProviderTransform.variants(parsed), configuredVariants)
    parsed.variants = mapValues(
      pickBy(merged, (value) => !isRecord(value) || value.disabled !== true),
      (value) => (isRecord(value) ? omit(value, ["disabled"]) : value) as Record<string, any>,
    )
  }
  return parsed
}

export function consoleProviderInfo(
  providerID: ProviderV2.ID,
  capability: AccountProviderCapability,
  model: Model,
  base?: Info,
): Info {
  return {
    id: providerID,
    name: capability.name ?? base?.name ?? providerID,
    source: "config",
    env: [],
    options: { ...capability.options },
    models: { [model.id]: model },
  }
}

const MAX_CONSOLE_CLIENT_SLOTS = 64

function activateConsoleGeneration(state: State, binding: ConsoleBinding) {
  const current = state.consoleGenerations.get(binding.client.slot)
  const incomingRevision = binding.account.credentialRevision
  const incomingConfigVersion = binding.account.configVersion
  if (
    current &&
    (current.credentialRevision > incomingRevision ||
      (current.credentialRevision === incomingRevision && current.configVersion > incomingConfigVersion))
  ) {
    return { cacheable: false as const, slot: undefined }
  }

  if (!current || current.generation !== binding.client.generation) {
    if (current) {
      for (const key of current.sdkKeys) state.sdk.delete(key)
      for (const key of current.modelKeys) state.models.delete(key)
    }
    state.consoleGenerations.set(binding.client.slot, {
      generation: binding.client.generation,
      credentialRevision: incomingRevision,
      configVersion: incomingConfigVersion,
      lastUsed: Date.now(),
      sdkKeys: new Set(),
      modelKeys: new Set(),
    })
  }

  const slot = state.consoleGenerations.get(binding.client.slot)!
  slot.lastUsed = Date.now()
  if (state.consoleGenerations.size > MAX_CONSOLE_CLIENT_SLOTS) {
    const evicted = [...state.consoleGenerations.entries()]
      .filter(([key]) => key !== binding.client.slot)
      .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0]
    if (evicted) {
      for (const key of evicted[1].sdkKeys) state.sdk.delete(key)
      for (const key of evicted[1].modelKeys) state.models.delete(key)
      state.consoleGenerations.delete(evicted[0])
    }
  }
  return { cacheable: true as const, slot }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const auth = yield* Auth.Service

    /**
     * Current Zen/Go key inventory: the unified env + fork-vault pool plus the
     * supported legacy `auth.json` and configured hosted `options.apiKey`
     * surfaces. This is an inventory read, never a selection: no
     * `defaultAccount()`, no `resolveZenRequest`, no ambient provider fallback.
     * The returned key is consumed in-process by the exact materializer only,
     * and identity always comes from the canonical `zen-*` derivation, so a
     * key is never a route, handle, or durable identity on its own.
     */
    const zenCompatInventory = Effect.fn("Provider.zenCompatInventory")(function* (providerID: string) {
      yield* Effect.promise(() => syncZenAccountPool())
      const states = new Map(zenLimitSnapshot().map((entry) => [entry.accountId, entry]))
      const inventory = new Map<
        string,
        {
          readonly accountID: string
          readonly label: string
          readonly apiKey: string
          readonly source: "env" | "vault" | "legacy"
          readonly state: "READY" | "COOLING_DOWN" | "QUOTA_EXHAUSTED"
          readonly resetAt?: number
        }
      >()

      for (const entry of zenQuotaAccounts()) {
        const state = states.get(entry.accountId)
        inventory.set(entry.accountId, {
          accountID: entry.accountId,
          label: entry.label,
          apiKey: entry.apiKey,
          source: state?.source ?? "vault",
          state: state?.state ?? "READY",
          ...(state?.resetAt ? { resetAt: state.resetAt } : {}),
        })
      }

      // Supported legacy surfaces for the same provider. Pool/Core entries keep
      // precedence, so one physical key can never become two candidates.
      const legacy: string[] = []
      const stored = yield* auth.get(providerID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (stored?.type === "api" && stored.key) legacy.push(stored.key)
      const configured = yield* config.get()
      const configuredKey = configured.provider?.[providerID]?.options?.apiKey
      if (typeof configuredKey === "string" && configuredKey.trim()) legacy.push(configuredKey.trim())

      for (const apiKey of legacy) {
        const accountID = stableZenIdentity(apiKey)
        if (inventory.has(accountID)) continue
        inventory.set(accountID, { accountID, label: `key-${accountID.slice(4, 12)}`, apiKey, source: "legacy", state: "READY" })
      }

      return [...inventory.values()]
    })
    const env = yield* Env.Service
    const plugin = yield* Plugin.Service
    const modelsDevSvc = yield* ModelsDev.Service
    const runtimeFlags = yield* RuntimeFlags.Service
    const gensparkCatalog = yield* GensparkCatalog.Service
    const credentials = yield* Credential.Service
    const credentialResolver = yield* CredentialResolver.Service
    const routes = yield* ProviderRoute.Service
    const routeHealth = yield* ProviderRouteHealth.Service
    const catalogContributions = yield* ProviderCatalogContributions.Service
    const rawConsoleHttp = yield* HttpClient.HttpClient
    const realm = serviceRealmID()
    const configHttp = withTransientReadRetry(rawConsoleHttp)
    const consoleAccounts = makeConsoleAccountExecutionResolver({
      realm,
      credentials,
      resolver: credentialResolver,
      http: rawConsoleHttp,
      configHttp,
    })
    const coreRouteSource = OpencodeRouteCandidates.make({
      realm,
      credentials,
      resolver: credentialResolver,
      http: rawConsoleHttp,
      configHttp,
      assessHealth: (input) =>
        routeHealth
          .assessAccount({
            providerID: input.providerID,
            accountID: input.account.accountID,
            modelID: input.modelID,
            credentialRevision: input.credentialRevision,
          })
          .pipe(
            Effect.map((health) => ({
              admissible: health.admissible,
              healthRank: health.healthRank,
              ...(health.ineligibleReason ? { ineligibleReason: health.ineligibleReason } : {}),
              ...(health.resetAt === undefined ? {} : { resetAt: health.resetAt }),
            })),
          ),
    })

    /**
     * Merge canonical Core credential candidates with the transitional
     * Zen/Go API-key inventory. Selection stays entirely inside
     * ProviderAccountPolicy/ProviderRoute; this source only projects.
     */
    const compatSource: OpencodeProviderRoute.CandidateSource = {
      list: (input) =>
        Effect.gen(function* () {
          const core = yield* coreRouteSource.list(input)
          if (!isHostedZenProvider(input.providerID)) return core

          const seen = new Set(core.candidates.map((entry) => entry.candidate.accountID))
          const compat = (yield* zenCompatInventory(input.providerID))
            .filter((entry) => !seen.has(entry.accountID))
            .map((entry) => {
              const accountID = ProviderAccount.ID.make(entry.accountID)
              const handle = Credential.ID.make(zenCompatHandle(entry.accountID))
              const ready = entry.state === "READY"
              const cooling = entry.state === "COOLING_DOWN"
              return {
                account: {
                  providerID: ProviderV2.ID.make(input.providerID),
                  credentialID: handle,
                  accountID,
                  label: entry.label,
                  active: true,
                  authType: "key",
                  source: zenCompatSourceName(entry.source),
                } satisfies ProviderAccount.Info,
                credentialRevision: ZEN_COMPAT_REVISION,
                configVersion: ZEN_COMPAT_REVISION,
                candidate: {
                  providerID: ProviderV2.ID.make(input.providerID),
                  accountID,
                  credentialHandle: handle,
                  admissible: ready,
                  healthRank: ready ? 0 : cooling ? 1 : 2,
                  ...(cooling ? { ineligibleReason: "cooldown" as const } : {}),
                  ...(!ready && !cooling ? { ineligibleReason: "quota-exhausted" as const } : {}),
                  ...(entry.resetAt === undefined ? {} : { resetAt: entry.resetAt }),
                } satisfies ProviderAccountPolicy.Candidate,
              } satisfies OpencodeRouteCandidates.CandidateSnapshot
            })

          const candidates = [...core.candidates, ...compat].sort((left, right) =>
            left.candidate.accountID === right.candidate.accountID
              ? left.candidate.credentialHandle.localeCompare(right.candidate.credentialHandle)
              : left.candidate.accountID.localeCompare(right.candidate.accountID),
          )
          return { candidates, issues: core.issues }
        }),
      resolveCredentialRevision: (input) =>
        isZenCompatHandle(input.credentialHandle)
          ? Effect.gen(function* () {
              if (!isHostedZenProvider(input.providerID)) return undefined
              if (input.credentialHandle !== zenCompatHandle(input.accountID)) return undefined
              const inventory = yield* zenCompatInventory(input.providerID)
              return inventory.some(
                (entry) => entry.accountID === input.accountID && input.credentialHandle === zenCompatHandle(entry.accountID),
              )
                ? ZEN_COMPAT_REVISION
                : undefined
            })
          : coreRouteSource.resolveCredentialRevision(input),
      invalidate: (credentialID) => coreRouteSource.invalidate?.(credentialID),
      cacheSize: () => coreRouteSource.cacheSize?.(),
    }

    const providerRoutes = {
      ...OpencodeProviderRoute.compose({ routes, source: compatSource }),
      /** Final transport-only exact-handle materialization for Console OAuth. */
      resolveExecution: coreRouteSource.resolveExecution,
    }

    /**
     * Exact in-process materialization of a selected Zen/Go compatibility
     * account. Re-reads the current inventory and requires the committed
     * account identity, opaque handle, and revision to still match; anything
     * else fails closed instead of substituting another key.
     */
    const resolveZenCompatExecution = (
      input: {
        readonly providerID: string
        readonly accountID: string
        readonly credentialHandle: string
        readonly expectedCredentialRevision: number
      },
    ) =>
      Effect.gen(function* () {
        if (!isHostedZenProvider(input.providerID)) return undefined
        if (!isZenCompatHandle(input.credentialHandle)) return undefined
        if (input.expectedCredentialRevision !== ZEN_COMPAT_REVISION) return undefined
        const match = (yield* zenCompatInventory(input.providerID)).find(
          (entry) =>
            entry.accountID === input.accountID && zenCompatHandle(entry.accountID) === input.credentialHandle,
        )
        if (!match) return undefined
        return { accountID: match.accountID, apiKey: match.apiKey } satisfies ZenCompatExecution
      })

    const state = yield* InstanceState.make<State>(() =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const cfg = yield* config.get()
        // Keep the owner snapshot untouched when a selected cold-cache miss
        // adds metadata to this location. Model projection/copying belongs to
        // the provider being materialized, not every provider in the snapshot.
        const modelsDev = { ...(yield* modelsDevSvc.getCached()) }
        function lazyProviders(create: (providerID: string) => Info): Record<string, Info> {
          const result: Record<string, Info> = {}
          for (const id of Object.keys(modelsDev)) {
            Object.defineProperty(result, id, {
              enumerable: true,
              configurable: true,
              get() {
                const value = create(id)
                Object.defineProperty(result, id, { value, writable: true, enumerable: true, configurable: true })
                return value
              },
              set(value: Info) {
                Object.defineProperty(result, id, { value, writable: true, enumerable: true, configurable: true })
              },
            })
          }
          return result
        }
        const catalog = lazyProviders((id) => fromModelsDevProvider(modelsDev[id]))
        const database = lazyProviders((id) => toPublicInfo(catalog[ProviderV2.ID.make(id)]))
        const typeSafeProviderID = ProviderV2.ID.make("typesafe")
        const typeSafePrefix = "typesafe/"
        // Keep the API-key Anthropic transport under its own provider ID so it
        // cannot collide with either the first-party CLI runtime (`claude`) or
        // the external plugin (`claude-code`).
        const anthropic = database[ProviderV2.ID.make("anthropic")]
        if (anthropic) {
          const claudeAPI = ProviderV2.ID.make("claude-api")
          database[claudeAPI] = {
            ...anthropic,
            id: claudeAPI,
            name: "Claude API Key",
            models: Object.fromEntries(
              Object.entries(anthropic.models).map(([id, model]) => [id, { ...model, providerID: claudeAPI }]),
            ),
          }
        }
        const claudeAPI = ProviderV2.ID.make("claude-api")
        database[claudeAPI] ??= {
          id: claudeAPI,
          source: "custom",
          name: "Claude API Key",
          env: ["ANTHROPIC_API_KEY"],
          options: {},
          models: Object.fromEntries(
            MODEL_IDS.map((id) => {
              const meta = MODEL_METADATA[id]
              return [
                id,
                {
                  id: ModelV2.ID.make(id),
                  providerID: claudeAPI,
                  name: meta.name,
                  family: meta.family,
                  api: { id, url: "", npm: "@ai-sdk/anthropic" },
                  status: meta.status === "unavailable" ? "unavailable" : meta.status,
                  headers: {},
                  options: {},
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                  limit: { context: meta.contextLimit, input: undefined, output: meta.outputLimit },
                  capabilities: meta.capabilities,
                  release_date: meta.releaseDate,
                  variants: meta.variants,
                } as Model,
              ]
            }),
          ),
        }
        const claudeID = ProviderV2.ID.make("claude")
        const claudeSubscriptionModels = getClaudeSubscriptionModelMetadata(modelsDev["anthropic"])
        database[claudeID] ??= {
          id: claudeID,
          source: "custom",
          name: "Claude Subscription",
          env: [],
          options: { apiKey: PROXY_API_KEY, includeUsage: true, baseURL: PROXY_BASE_URL },
          models: Object.fromEntries(
            Object.entries(claudeSubscriptionModels).map(([id, meta]) => {
              return [
                id,
                {
                  id: ModelV2.ID.make(id),
                  providerID: claudeID,
                  name: meta.name,
                  family: meta.family,
                  api: modelApi(id),
                  status: meta.status === "unavailable" ? "unavailable" : meta.status,
                  headers: {},
                  options: { includeUsage: true },
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                  limit: {
                    context: meta.contextLimit,
                    input: meta.contextLimit >= 1_000_000 ? Math.round(meta.contextLimit * 0.9) : undefined,
                    output: meta.outputLimit,
                  },
                  capabilities: meta.capabilities,
                  release_date: meta.releaseDate,
                  variants: meta.variants,
                } as Model,
              ]
            }),
          ),
        }
        const gensparkID = ProviderV2.ID.make(GENSPARK_PROVIDER_ID)
        database[gensparkID] ??= {
          id: gensparkID,
          source: "custom",
          name: GENSPARK_PROVIDER_NAME,
          env: ["GSK_API_KEY", "GENSPARK_API_KEY"],
          options: { ...GENSPARK_PROXY_OPTION },
          models: Object.fromEntries(
            GENSPARK_MODEL_IDS.map((id) => {
              const meta = GENSPARK_MODEL_METADATA[id]
              return [
                id,
                {
                  id: ModelV2.ID.make(id),
                  providerID: gensparkID,
                  name: meta.name,
                  family: meta.family,
                  api: { id, url: gensparkApiURL(), npm: "@ai-sdk/openai-compatible" },
                  status: "active",
                  headers: {},
                  options: {},
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                  limit: { context: meta.limit.context, input: meta.limit.input, output: meta.limit.output },
                  capabilities: meta.capabilities,
                  release_date: "",
                  variants: meta.variants,
                } as Model,
              ]
            }),
          ),
        }

        const providers: Record<ProviderV2.ID, Info> = {} as Record<ProviderV2.ID, Info>
        const languages = new Map<string, LanguageModelV3>()
        const modelLoaders: {
          [providerID: string]: CustomModelLoader
        } = {}
        const varsLoaders: {
          [providerID: string]: CustomVarsLoader
        } = {}
        const accountLoaders: Record<string, () => Promise<readonly ProviderAccountIdentity[]>> = {}
        const sdk = new Map<string, BundledSDK>()
        const discoveryLoaders: Record<string, DiscoveryLoader> = {}
        const dep = {
          auth: (id: string) => auth.get(id).pipe(Effect.orDie),
          config: () => config.get(),
          env: () => env.all(),
          get: (key: string) => env.get(key),
          modelsDev: () => modelsDev,
          gensparkCatalog: (apiKey: string | undefined) => gensparkCatalog.get(apiKey),
        }

        function mergeProvider(providerID: ProviderV2.ID, provider: Partial<Info>) {
          const existing = providers[providerID]
          if (existing) {
            // @ts-expect-error
            providers[providerID] = mergeDeep(existing, provider)
            return
          }
          const match = database[providerID]
          if (!match) return
          // @ts-expect-error
          providers[providerID] = mergeDeep(match, provider)
        }

        const providerTasks = new Map<ProviderV2.ID, Effect.Effect<void>[]>()
        function registerProviderTask(providerID: ProviderV2.ID, task: Effect.Effect<void>) {
          const tasks = providerTasks.get(providerID) ?? []
          tasks.push(task)
          providerTasks.set(providerID, tasks)
        }

        function normalizePluginModels(providerID: ProviderV2.ID, models: Record<string, any>): Record<string, Model> {
          return Object.fromEntries(
            Object.entries(models).map(([id, model]) => [
              id,
              {
                ...model,
                id: ModelV2.ID.make(id),
                providerID,
              } satisfies Model,
            ]),
          )
        }

        // load plugins first so config() hook runs before reading cfg.provider
        const plugins = yield* plugin.list()

        // now read config providers - includes any modifications from plugin config() hook
        const configProviders = Object.entries(cfg.provider ?? {})
        const disabled = new Set(cfg.disabled_providers ?? [])
        const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : null

        function isProviderAllowed(providerID: ProviderV2.ID): boolean {
          if (enabled && !enabled.has(providerID)) return false
          if (disabled.has(providerID)) return false
          return true
        }

        for (const hook of plugins) {
          const p = hook.provider
          if (!p) continue

          const providerID = ProviderV2.ID.make(p.id)
          if (disabled.has(providerID)) continue
          const pluginAuth = yield* auth.get(providerID).pipe(Effect.orDie)

          if (p.accounts) {
            // Keep the loader live rather than snapshotting labels at provider
            // initialization. Account rename/enrollment changes must resolve
            // immediately without waiting for a provider-catalog invalidation.
            accountLoaders[providerID] = () => p.accounts!({ auth: pluginAuth })
          }

          const models = p.models
          const discoverModels = p.discoverModels
          if (!models && !discoverModels) continue

          const provider =
            database[providerID] ??
            ({
              id: providerID,
              name: p.id,
              source: "custom",
              env: [],
              options: {},
              models: {},
            } satisfies Info)
          database[providerID] ??= provider

          if (discoverModels) {
            discoveryLoaders[providerID] = {
              mode: p.discoveryMode ?? "merge",
              load: async () => {
                const current = providers[providerID] ?? database[providerID] ?? provider
                return normalizePluginModels(
                  providerID,
                  await discoverModels(toPublicInfo(current), { auth: pluginAuth }),
                )
              },
            }
          }

          registerProviderTask(providerID, Effect.gen(function* () {
          const discovered = models
            ? yield* Effect.promise(async () =>
                normalizePluginModels(providerID, await models(toPublicInfo(provider), { auth: pluginAuth })),
              )
            : {}
          // A provider hook can create a provider from scratch (`source:
          // "custom"`) without requiring an API-key entry or config stanza.
          // Register the freshly discovered model set now; otherwise the data
          // lands in `database` but never enters the public `providers` map.
          // Apply the same configured model projection after the hook supplies
          // its metadata; configured overrides remain authoritative.
          const resolved = { ...provider, models: discovered }
          database[providerID] = cfg.provider?.[providerID]
            ? fromConfigProvider(providerID, cfg.provider[providerID], resolved, modelsDev)
            : resolved
          mergeProvider(providerID, { source: "custom", models: database[providerID].models })
          }))
        }

        // Reuse the V1 config projection used by the bootstrap-free catalog.
        for (const [providerID, provider] of configProviders) {
          database[providerID] = fromConfigProvider(providerID, provider, database[providerID], modelsDev)
        }

        // load env
        const envs = yield* env.all()
        for (const id of Object.keys(database)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          const providerEnv = cfg.provider?.[id]?.env ?? modelsDev[id]?.env ?? database[providerID].env
          const apiKey = providerEnv.map((item) => envs[item]).find(Boolean)
          if (!apiKey) continue
          mergeProvider(providerID, {
            source: "env",
            key: providerEnv.length === 1 ? apiKey : undefined,
          })
        }

        // load apikeys
        const auths = yield* auth.all().pipe(Effect.orDie)
        for (const [id, provider] of Object.entries(auths)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          if (provider.type === "api") {
            mergeProvider(providerID, {
              source: "api",
              key: provider.key,
            })
          }
        }

        // plugin auth loader - database now has entries for config providers
        registerProviderTask(typeSafeProviderID, Effect.gen(function* () {
          if (database[typeSafeProviderID]) return
          if (!envs.TYPESAFE_API_KEY && !auths.typesafe) return
          const metadata = Object.values(yield* modelsDevSvc.getDecisionModels()).filter(
            (model) => model.type === "decision" && model.id.startsWith(typeSafePrefix),
          )
          if (metadata.length === 0) return
          const directProvider = {
            id: "typesafe", name: "TypeSafe", env: ["TYPESAFE_API_KEY"],
            api: envs.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai/v1",
            npm: "@ai-sdk/openai-compatible", models: {},
          } satisfies ModelsDev.Provider
          database[typeSafeProviderID] = {
            id: typeSafeProviderID, source: "custom", name: directProvider.name,
            env: directProvider.env, options: {},
            models: Object.fromEntries(metadata.map((model) => {
              const id = model.id.slice(typeSafePrefix.length)
              const projected = fromModelsDevModel(directProvider, { ...model, id })
              return [projected.id, projected]
            })),
          }
          const key = envs.TYPESAFE_API_KEY || (auths.typesafe?.type === "api" ? auths.typesafe.key : undefined)
          if (key) mergeProvider(typeSafeProviderID, { source: envs.TYPESAFE_API_KEY ? "env" : "api", key })
        }))
        for (const plugin of plugins) {
          if (!plugin.auth) continue
          const providerID = ProviderV2.ID.make(plugin.auth.provider)
          if (disabled.has(providerID)) continue

          const stored = yield* auth.get(providerID).pipe(Effect.orDie)
          if (!stored) continue
          if (!plugin.auth.loader) continue

          registerProviderTask(providerID, Effect.gen(function* () {
          if (!database[providerID]) return
          const options = yield* Effect.promise(() =>
            plugin.auth!.loader!(
              () => bridge.promise(auth.get(providerID).pipe(Effect.orDie)) as any,
              toPublicInfo(database[plugin.auth!.provider]),
            ),
          )
          const opts = options ?? {}
          const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
          mergeProvider(providerID, patch)
          }))
        }

        for (const [id, fn] of Object.entries(custom(dep))) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          registerProviderTask(providerID, Effect.gen(function* () {
          // Custom loaders may narrow the available models in place (for
          // example, anonymous Zen must withdraw paid rows). Operate on the
          // connected projection rather than a detached catalog copy.
          const input = providers[providerID] ?? database[providerID]
          if (!input) return
          const result = yield* fn(input)
          if (result && (result.autoload || providers[providerID])) {
            if (result.getModel) modelLoaders[providerID] = result.getModel
            if (result.vars) varsLoaders[providerID] = result.vars
            if (result.discoverModels) discoveryLoaders[providerID] = { load: result.discoverModels, mode: "merge" }
            const opts = result.options ?? {}
            const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
            mergeProvider(providerID, patch)
          }
          }))
        }

        // load config - re-apply with updated data
        for (const [id, provider] of configProviders) {
          const providerID = ProviderV2.ID.make(id)
          const partial: Partial<Info> = { source: "config" }
          if (provider.env) partial.env = provider.env
          if (provider.name) partial.name = provider.name
          if (provider.options) partial.options = provider.options
          mergeProvider(providerID, partial)
        }

        function finalizeProvider(providerID: ProviderV2.ID) {
          const provider = providers[providerID]
          if (!provider) return
          if (!isProviderAllowed(providerID)) {
            delete providers[providerID]
            return
          }

          const configProvider = cfg.provider?.[providerID]

          for (const [modelID, model] of Object.entries(provider.models)) {
            model.api.id = model.api.id ?? model.id ?? modelID

            if (
              // These chat aliases are invalid for the special handling in the
              // built-in providers below, but custom providers may support them.
              (modelID === "gpt-5-chat-latest" &&
                (providerID === ProviderV2.ID.openai ||
                  providerID === ProviderV2.ID.githubCopilot ||
                  providerID === ProviderV2.ID.openrouter)) ||
              (providerID === ProviderV2.ID.openrouter && modelID === "openai/gpt-5-chat")
            )
              delete provider.models[modelID]
            if (model.status === "alpha" && !runtimeFlags.enableExperimentalModels) delete provider.models[modelID]
            if (model.status === "deprecated") delete provider.models[modelID]
            if (
              (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
              (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
            )
              delete provider.models[modelID]

            if (model.variants === undefined) {
              model.variants = mapValues(ProviderTransform.variants(model), (v) => v)
            }

            const configVariants = configProvider?.models?.[modelID]?.variants
            if (configVariants && model.variants) {
              const merged = mergeDeep(model.variants, configVariants)
              model.variants = mapValues(
                pickBy(merged, (v) => !v.disabled),
                (v) => omit(v, ["disabled"]),
              )
            }
          }

          // Providers whose model set is supplied by a discoverModels hook
          // remain selectable by identity; that hook is awaited only if this
          // provider is actually selected for execution.
          if (Object.keys(provider.models).length === 0 && !discoveryLoaders[providerID]) {
            delete providers[providerID]
            return
          }
        }
        for (const id of Object.keys(providers)) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID) || !providerTasks.has(providerID)) finalizeProvider(providerID)
        }

        let materializationRevision = 0
        const initializers = new Map<ProviderV2.ID, Effect.Effect<void>>()
        for (const [providerID, tasks] of providerTasks) {
          if (!isProviderAllowed(providerID)) continue
          const admission = yield* Semaphore.make(1)
          let initialized = false
          initializers.set(providerID, admission.withPermits(1)(Effect.gen(function* () {
            if (initialized) return
            for (const task of tasks) yield* task
            const configured = cfg.provider?.[providerID]
            if (configured) {
              mergeProvider(providerID, {
                source: "config",
                ...(configured.env ? { env: configured.env } : {}),
                ...(configured.name ? { name: configured.name } : {}),
                ...(configured.options ? { options: configured.options } : {}),
              })
            }
            finalizeProvider(providerID)
            if (providerID === "claude" && providers[providerID]) providers[providerID].name = "Claude Subscription"
            if (providerID === "claude-api" && providers[providerID]) providers[providerID].name = "Claude API Key"
            materializationRevision++
            initialized = true
          })))
        }

        const selectedCatalogAdmission = yield* Semaphore.make(1)
        const ensureSelectedCatalogProvider = Effect.fn("Provider.ensureSelectedCatalogProvider")(
          function* (providerID: ProviderV2.ID) {
            yield* selectedCatalogAdmission.withPermits(1)(
              Effect.gen(function* () {
                if (!isProviderAllowed(providerID)) return
                // TypeSafe owns a separate decision-model source. Its selected
                // initializer must not first populate the unrelated language catalog.
                if (providerID === typeSafeProviderID) return
                // Config/plugin-created providers already own their metadata.
                // Only a truly cold models.dev miss may demand the shared
                // catalog; a miss in a nonempty catalog remains a normal
                // not-found result and never fetches for a typo.
                if (database[providerID] || providers[providerID]) return
                let source = modelsDev[providerID]
                if (!source && Object.keys(modelsDev).length === 0 && Object.keys(catalog).length === 0) {
                  const fetched = yield* modelsDevSvc.getForSelectedProvider(providerID)
                  Object.assign(modelsDev, fetched)
                  source = modelsDev[providerID]
                }
                if (!source || !isProviderAllowed(providerID)) return

                const catalogProvider = fromModelsDevProvider(source)
                catalog[providerID] = catalogProvider
                const entry = toPublicInfo(catalogProvider)
                for (const [modelID, model] of Object.entries(entry.models)) {
                  if (
                    (modelID === "gpt-5-chat-latest" &&
                      (providerID === ProviderV2.ID.openai ||
                        providerID === ProviderV2.ID.githubCopilot ||
                        providerID === ProviderV2.ID.openrouter)) ||
                    (providerID === ProviderV2.ID.openrouter && modelID === "openai/gpt-5-chat") ||
                    model.status === "deprecated" ||
                    (model.status === "alpha" && !runtimeFlags.enableExperimentalModels)
                  ) {
                    delete entry.models[modelID]
                  }
                }
                database[providerID] = entry

                const key = entry.env.map((name) => envs[name]).find(Boolean)
                if (key) {
                  providers[providerID] = {
                    ...toPublicInfo(entry),
                    source: "env",
                    key: entry.env.length === 1 ? key : undefined,
                  }
                } else if (auths[providerID]?.type === "api") {
                  providers[providerID] = {
                    ...toPublicInfo(entry),
                    source: "api",
                    key: auths[providerID].key,
                  }
                }
                if (providers[providerID]) materializationRevision++
              }),
            )
          },
        )

        // Final identity normalization: these providers must never inherit a
        // name from the Anthropic catalog or an old plugin/config entry.
        if (providers[ProviderV2.ID.make("claude")]) {
          providers[ProviderV2.ID.make("claude")].name = "Claude Subscription"
        }
        if (providers[ProviderV2.ID.make("claude-api")]) {
          providers[ProviderV2.ID.make("claude-api")].name = "Claude API Key"
        }

        return {
          models: languages,
          providers,
          catalog,
          modelsDev,
          claudeCatalogRevision: claudeSubscriptionCatalogRevision(),
          sdk,
          modelLoaders,
          varsLoaders,
          discoveryLoaders,
          discoveryPromises: new Map(),
          initializeProvider: (providerID) => initializers.get(providerID) ?? Effect.void,
          ensureSelectedCatalogProvider,
          initializerIDs: [...initializers.keys()],
          materializationRevision: () => materializationRevision,
          config: cfg,
          accountLoaders,
          consoleBindings: new WeakMap(),
          publicBindings: new WeakMap(),
          zenCompatBindings: new WeakMap(),
          consoleGenerations: new Map(),
        }
      }),
    )

    /**
     * The Claude subscription catalog is refreshed by the explicit login/live
     * Agent SDK boundaries, never by passive provider listing. If that
     * account-authoritative cache changed after this per-instance Provider
     * snapshot was materialized, rebuild the snapshot on the next provider
     * read. This is the fork-owned equivalent of opencode-claude's
     * ctx.provider.reload(), while preserving all normal config/filter assembly.
     */
    const publishedCatalogStates = new WeakMap<State, number>()
    const currentState = Effect.fnUntraced(function* (providerID?: ProviderV2.ID) {
      let current = yield* InstanceState.get(state)
      // Provider snapshots embed the exact effective Config object they were
      // materialized from. Config.get() is a scoped-cache lookup on the hot
      // path, so identity gives us an O(1) invalidation fence without file
      // stats/parsing on every model lookup.
      const currentConfig = yield* config.get()
      if (
        current.config !== currentConfig ||
        current.claudeCatalogRevision !== claudeSubscriptionCatalogRevision()
      ) {
        yield* InstanceState.invalidate(state)
        current = yield* InstanceState.get(state)
      }
      if (providerID) {
        yield* current.ensureSelectedCatalogProvider(providerID)
        yield* current.initializeProvider(providerID)
      }
      else yield* Effect.forEach(current.initializerIDs, current.initializeProvider, { concurrency: 4, discard: true })
      const revision = current.materializationRevision()
      const directory = yield* InstanceState.directory
      if (publishedCatalogStates.get(current) !== revision || !catalogContributions.get(directory)) {
        publishedCatalogStates.set(current, revision)
        yield* catalogContributions.publish({
          directory,
          providers: current.providers,
        })
      }
      return current
    })

    const ensureProviderDiscovery = Effect.fn("Provider.ensureProviderDiscovery")(function* (
      current: State,
      providerID: ProviderV2.ID,
    ) {
      const loader = current.discoveryLoaders[providerID]
      const provider = current.providers[providerID]
      if (!loader || !provider) return

      let pending = current.discoveryPromises.get(providerID)
      if (!pending) {
        pending = Promise.resolve()
          .then(() => loader.load())
          .then((discovered) => {
            const configured = current.config.provider?.[providerID]
            const next: Record<string, Model> = {}
            for (const [modelID, model] of Object.entries(discovered)) {
              if (loader.mode === "merge" && provider.models[modelID]) continue
              if (model.status === "deprecated") continue
              if (model.status === "alpha" && !runtimeFlags.enableExperimentalModels) continue
              if (configured?.blacklist?.includes(modelID)) continue
              if (configured?.whitelist && !configured.whitelist.includes(modelID)) continue
              if (model.variants === undefined) model.variants = mapValues(ProviderTransform.variants(model), (v) => v)
              const variants = configured?.models?.[modelID]?.variants
              if (variants && model.variants) {
                const merged = mergeDeep(model.variants, variants)
                model.variants = mapValues(pickBy(merged, (v) => !v.disabled), (v) => omit(v, ["disabled"]))
              }
              next[modelID] = model
            }
            if (loader.mode === "replace") {
              const replacement = { ...provider, models: next }
              provider.models = configured
                ? fromConfigProvider(providerID, configured, replacement, current.modelsDev).models
                : replacement.models
            } else {
              Object.assign(provider.models, next)
            }
          })
          .catch(() => {})
        current.discoveryPromises.set(providerID, pending)
      }

      yield* Effect.promise(() => pending!)
      yield* catalogContributions.publish({
        directory: yield* InstanceState.directory,
        providers: current.providers,
      })
    })

    const list = Effect.fn("Provider.list")(function* () {
      return (yield* currentState()).providers
    })

    const listAccountModelProjections = Effect.fn("Provider.listAccountModelProjections")(function* () {
      const s = yield* currentState()
      const stored = yield* credentials.list(opencodeIntegrationID)
      const projected = stored.flatMap((credential) => {
        const account = projectOpencodeCredential(credential)
        return account ? [{ credential, account }] : []
      })
      const accountCounts = new Map<string, number>()
      for (const entry of projected) {
        accountCounts.set(entry.account.accountID, (accountCounts.get(entry.account.accountID) ?? 0) + 1)
      }
      // A duplicated stable account identity would be ambiguous to the route
      // resolver. Do not advertise an explicit picker row that cannot be
      // executed deterministically.
      const unique = projected.filter((entry) => accountCounts.get(entry.account.accountID) === 1)
      const labelCounts = new Map<string, number>()
      const baseLabel = (entry: (typeof unique)[number]) =>
        entry.account.label.trim() ||
        entry.account.metadata?.email?.trim() ||
        entry.account.accountID
      for (const entry of unique) {
        const key = baseLabel(entry).normalize("NFKC").toLowerCase()
        labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1)
      }

      const rows = yield* Effect.forEach(
        unique,
        (entry) =>
          consoleAccounts.resolve(entry.credential.id).pipe(
            Effect.timeout("5 seconds"),
            Effect.map((execution) => {
              if (!execution) return [] as AccountModelProjection[]
              const label = baseLabel(entry)
              const labelKey = label.normalize("NFKC").toLowerCase()
              const accountLabel =
                (labelCounts.get(labelKey) ?? 0) > 1
                  ? `${label} #${entry.account.accountID.slice(-6)}`
                  : label
              const result: AccountModelProjection[] = []
              for (const [rawProviderID, capability] of Object.entries(execution.capabilities.providers)) {
                const providerID = ProviderV2.ID.make(rawProviderID)
                const baseProvider = s.catalog[providerID] ?? s.providers[providerID]
                for (const rawModelID of Object.keys(capability.models)) {
                  const modelID = ModelV2.ID.make(rawModelID)
                  const materialized = consoleModel(providerID, modelID, capability, baseProvider?.models[modelID])
                  if (!materialized) continue
                  if (materialized.status === "deprecated") continue
                  if (materialized.status === "alpha" && !runtimeFlags.enableExperimentalModels) continue
                  result.push({
                    accountID: entry.account.accountID,
                    accountLabel,
                    provider: consoleProviderInfo(providerID, capability, materialized, baseProvider),
                    model: materialized,
                  })
                }
              }
              return result
            }),
            // One stale/broken account must not erase healthy peers or turn a
            // T3 model-picker refresh into a provider-list failure.
            Effect.catchCause(() => Effect.succeed([] as AccountModelProjection[])),
          ),
        { concurrency: 4 },
      )
      return rows.flat()
    })

    async function resolveSDK(model: Model, s: State, envs: Record<string, string | undefined>) {
      try {
        const binding = s.consoleBindings.get(model)
        const publicBinding = s.publicBindings.get(model)
        const compatBinding = s.zenCompatBindings.get(model)
        const provider =
          binding?.providerInfo ?? publicBinding?.providerInfo ?? compatBinding?.providerInfo ?? s.providers[model.providerID]
        if (!provider) throw new Error(`Provider unavailable: ${model.providerID}`)
        const options = { ...provider.options }

        if (
          model.providerID === "google-vertex" &&
          model.api.npm === "@ai-sdk/google-vertex/anthropic" &&
          !options.baseURL
        ) {
          const baseURL = googleVertexAnthropicBaseURL(
            typeof options.project === "string" ? options.project : undefined,
            typeof options.location === "string" ? options.location : undefined,
          )
          if (baseURL) options.baseURL = baseURL
        }

        if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
          delete options.fetch
        }

        if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
          options["includeUsage"] = true
        }

        const baseURL = iife(() => {
          let url =
            typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
          if (!url) return

          if (!binding && !publicBinding && !compatBinding) {
            const loader = s.varsLoaders[model.providerID]
            if (loader) {
              const vars = loader(options)
              for (const [key, value] of Object.entries(vars)) {
                const field = "${" + key + "}"
                url = url.replaceAll(field, value)
              }
            }

            url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
              const val = envs[String(key)]
              return val ?? item
            })
          }
          return url
        })

        if (baseURL !== undefined) options["baseURL"] = baseURL
        if (model.headers)
          options["headers"] = {
            ...options["headers"],
            ...model.headers,
          }

        const activation = binding ? activateConsoleGeneration(s, binding) : undefined
        if (!binding && !publicBinding && !compatBinding && options["apiKey"] === undefined && provider.key)
          options["apiKey"] = provider.key
        const key = binding
          ? Hash.fast(
              JSON.stringify({
                generation: binding.client.generation,
                providerID: model.providerID,
                npm: model.api.npm,
                options,
              }),
            )
          : publicBinding
            ? Hash.fast(
                JSON.stringify({
                  route: "public",
                  providerID: model.providerID,
                  npm: model.api.npm,
                  options,
                }),
              )
            : compatBinding
              ? Hash.fast(
                  JSON.stringify({
                    route: "zen-compat",
                    accountID: compatBinding.accountID,
                    providerID: model.providerID,
                    npm: model.api.npm,
                    options,
                  }),
                )
            : Hash.fast(
                JSON.stringify({
                  providerID: model.providerID,
                  npm: model.api.npm,
                  options,
                }),
              )

        if (binding) options["apiKey"] = binding.account.secret
        if (publicBinding) options["apiKey"] = ZEN_PUBLIC_API_KEY
        // Injected only after the secret-free cache identity exists, and only
        // for the exact committed compatibility account.
        if (compatBinding) options["apiKey"] = compatBinding.secret

        const existing = !activation || activation.cacheable ? s.sdk.get(key) : undefined
        if (existing) return existing

        const customFetch = options["fetch"]
        const chunkTimeout = options["chunkTimeout"] ?? 300_000
        const headerTimeout = options["headerTimeout"] ?? 300_000
        delete options["chunkTimeout"]
        delete options["headerTimeout"]

        options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
          const fetchFn = customFetch ?? fetch
          const opts = init ?? {}
          const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
          const headerTimeoutMs = headerTimeout === false ? undefined : headerTimeout
          const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
          const signals: AbortSignal[] = []

          if (opts.signal) signals.push(opts.signal)
          if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
          if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
          if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
            signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
          if (combined) opts.signal = combined

          if (model.providerID === "nvidia") trackNvidiaRequest()

          const res = await fetchFn(input, {
            ...opts,
            // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
            timeout: false,
          }).finally(() => headerTimeoutCtl?.clear())

          if (!chunkAbortCtl) return res
          return wrapSSE(res, chunkTimeout, chunkAbortCtl)
        }

        const bundledLoader = BUNDLED_PROVIDERS[model.api.npm]
        if (bundledLoader) {
          const factory = await bundledLoader()
          const loaded = factory({
            name: model.providerID,
            ...options,
          })
          if (!activation || activation.cacheable) {
            s.sdk.set(key, loaded)
            activation?.slot?.sdkKeys.add(key)
          }
          return loaded as SDK
        }

        const installedPath = await (async () => {
          if (model.api.npm.startsWith("file://")) {
            return model.api.npm
          }
          const item = await Npm.add(model.api.npm)
          if (!item.entrypoint) throw new Error(`Package ${model.api.npm} has no import entrypoint`)
          return item.entrypoint
        })()

        // `installedPath` is a local entry path or an existing `file://` URL. Normalize
        // only path inputs so Node on Windows accepts the dynamic import.
        const importSpec = installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
        const mod = await import(importSpec)

        const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
        const loaded = fn({
          name: model.providerID,
          ...options,
        })
        if (!activation || activation.cacheable) {
          s.sdk.set(key, loaded)
          activation?.slot?.sdkKeys.add(key)
        }
        return loaded as SDK
      } catch (e) {
        throw new InitError({ providerID: model.providerID, cause: e })
      }
    }

    const getProvider = Effect.fn("Provider.getProvider")(function* (providerID: ProviderV2.ID, model?: Model) {
      const s = yield* currentState(providerID)
      return (
        (model ? s.consoleBindings.get(model)?.providerInfo ?? s.publicBindings.get(model)?.providerInfo : undefined) ??
        (model ? s.zenCompatBindings.get(model)?.providerInfo : undefined) ??
        s.providers[providerID]
      )
    })

    const resolveAccountID = Effect.fn("Provider.resolveAccountID")(function* (
      providerID: ProviderV2.ID,
      selector: string,
    ) {
      const requested = selector.trim()
      const s = yield* currentState(providerID)
      const load = s.accountLoaders[providerID]
      const accounts: readonly ProviderAccountIdentity[] = load
        ? yield* Effect.tryPromise({
            try: () => load(),
            catch: (cause) =>
              new AccountResolutionError({
                providerID,
                selector: requested,
                reason: "unavailable",
                cause,
              }),
          })
        : isConsoleAccountProvider(providerID)
          ? (yield* credentials.list(opencodeIntegrationID)).flatMap((credential) => {
              const projected = projectOpencodeCredential(credential)
              if (!projected) return []
              const metadata = credential.value.metadata
              const aliases = [
                credential.id,
                typeof metadata?.email === "string" ? metadata.email : undefined,
                typeof metadata?.accountID === "string" ? metadata.accountID : undefined,
              ].filter((value): value is string => Boolean(value))
              return [{
                id: projected.accountID,
                label: credential.label,
                ...(aliases.length > 0 ? { aliases } : {}),
              }]
            })
          : yield* new AccountResolutionError({
              providerID,
              selector: requested,
              reason: "unsupported",
            })

      const resolved = resolveProviderAccountSelector(requested, accounts)
      if (resolved.kind === "resolved") return resolved.accountID
      if (resolved.kind === "ambiguous") {
        return yield* new AccountResolutionError({
          providerID,
          selector: requested,
          reason: "ambiguous",
          matches: resolved.matches.map((account) => account.id),
        })
      }
      return yield* new AccountResolutionError({
        providerID,
        selector: requested,
        reason: "not-found",
      })
    })

    const getModel = Effect.fn("Provider.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      accountID?: string,
    ) {
      const s = yield* currentState(providerID)
      const consoleSelection =
        accountID !== undefined && accountID.startsWith("cred_") && isConsoleAccountProvider(providerID)

      if (consoleSelection) {
        const account = yield* consoleAccounts.resolve(accountID).pipe(Effect.orDie)
        if (!account) {
          return yield* new ModelNotFoundError({
            providerID,
            modelID,
            cause: new Error("Selected OpenCode Console credential is unavailable"),
          })
        }

        const capability = account.capabilities.providers[providerID]
        const accountModelID = ModelV2.ID.make(splitModelIDForProvider(modelID, providerID).baseModelID)
        // Trusted catalog metadata is the only fallback. Local provider
        // state may contain unrelated env/config credentials and must not bleed
        // into an explicitly selected Console account transport.
        const baseProvider = s.catalog[providerID]
        const materialized = capability
          ? consoleModel(providerID, accountModelID, capability, baseProvider?.models[accountModelID])
          : undefined

        if (
          materialized &&
          materialized.status !== "deprecated" &&
          (materialized.status !== "alpha" || runtimeFlags.enableExperimentalModels)
        ) {
          const providerInfo = consoleProviderInfo(providerID, capability!, materialized, baseProvider)
          const client = consoleClientIdentity(account, providerID, capability!)
          const binding = { account, provider: capability!, providerInfo, client } satisfies ConsoleBinding
          s.consoleBindings.set(materialized, binding)
          activateConsoleGeneration(s, binding)
          return materialized
        }

        const suggestions = capability
          ? fuzzysort.go(accountModelID, Object.keys(capability.models), { limit: 3, threshold: -10000 }).map((m) => m.target)
          : []
        return yield* new ModelNotFoundError({ providerID, modelID: accountModelID, suggestions })
      }

      yield* ensureProviderDiscovery(s, providerID)

      const provider = s.providers[providerID]
      const requestedModelID = ModelV2.ID.make(providerModelID(modelID, providerID, accountID))
      const runtimeModelID =
        providerID === ProviderV2.ID.make("claude")
          ? ModelV2.ID.make(resolveClaudeAlias(requestedModelID) ?? requestedModelID)
          : requestedModelID
      if (!provider) {
        const catalogProvider = s.catalog[providerID]
        const suggestions = catalogProvider
          ? modelSuggestions(catalogProvider, runtimeModelID, runtimeFlags.enableExperimentalModels)
          : fuzzysort
              .go(providerID, Object.keys({ ...s.catalog, ...s.providers }), { limit: 3, threshold: -10000 })
              .map((m) => m.target)
        return yield* new ModelNotFoundError({ providerID, modelID: runtimeModelID, suggestions })
      }

      const info = provider.models[runtimeModelID]
      if (!info) {
        const current = modelSuggestions(provider, runtimeModelID, runtimeFlags.enableExperimentalModels)
        const suggestions = current.length
          ? current
          : modelSuggestions(s.catalog[providerID], runtimeModelID, runtimeFlags.enableExperimentalModels)
        return yield* new ModelNotFoundError({ providerID, modelID: runtimeModelID, suggestions })
      }
      return info
    })

    const routedAvailability = Effect.fn("Provider.routedAvailability")(function* (input: {
      readonly state: State
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
      readonly allowPublic?: boolean
    }) {
      const allowPublic = input.allowPublic !== false && input.providerID === ProviderV2.ID.make("opencode")
      let publicEligible = false
      if (allowPublic) {
        const base = input.state.catalog[input.providerID]?.models[input.modelID]
        if (base) {
          const hosted = yield* Effect.promise(() => zenHostedCatalog())
          const advertised =
            hosted.state === "fresh" || hosted.state === "stale"
              ? hosted.ids.has(base.api.id) || hosted.ids.has(base.id)
              : false
           if (advertised) {
            const raw = (yield* modelsDevSvc.get())[input.providerID]?.models
            publicEligible = isTrustedZeroCostCatalogModel(raw?.[base.api.id] ?? raw?.[base.id])
            if (publicEligible) {
              publicEligible = yield* routeHealth
                .assessPublic({
                  providerID: input.providerID,
                  modelID: input.modelID,
                })
                .pipe(
                  Effect.map((health) => health.available),
                  Effect.orDie,
                )
            }
          }
        }
      }
      return { allowPublic, publicEligible }
    })

    const materializeRoutedResolution = Effect.fn("Provider.materializeRoutedResolution")(function* (input: {
      readonly state: State
      readonly sessionID: CoreSessionSchema.ID
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
      readonly affinityDomain: string
      readonly allowPublic: boolean
      readonly publicEligible: boolean
      readonly resolution: OpencodeProviderRoute.Resolution
    }) {
      let resolution = input.resolution
      if (resolution.lease.route.kind === "public") {
        const baseProvider = input.state.catalog[input.providerID]
        const base = baseProvider?.models[input.modelID]
        if (!base || !input.publicEligible) {
          return yield* new RouteResolutionError({
            providerID: input.providerID,
            modelID: input.modelID,
            cause: new Error("Committed Public route is not eligible for this hosted model"),
          })
        }

        // Clone from the trusted account-neutral catalog so local/env/provider
        // auth state can never bleed into a committed Public transport.
        const providerInfo = toPublicInfo(baseProvider)
        providerInfo.env = []
        delete providerInfo.key
        delete providerInfo.options.apiKey
        // toPublicInfo deliberately strips functions. Reinstall only the
        // provider-owned hosted transport wrapper for the committed Public
        // lease so the explicit "public" sentinel reaches the wire without
        // consulting env/auth/default-account state.
        providerInfo.options.fetch = committedPublicZenProviderFetch
        const materialized = providerInfo.models[input.modelID]
        if (!materialized) {
          return yield* new ModelNotFoundError({
            providerID: input.providerID,
            modelID: input.modelID,
          })
        }
        input.state.publicBindings.set(materialized, { providerInfo })
        return { model: materialized, route: resolution } satisfies RoutedModel
      }

      const lease = resolution.lease.route

      // A committed transitional Zen/Go API-key route materializes only the
      // exact selected key. It never reaches the Console capability path, and a
      // missing/changed compatibility execution fails closed instead of
      // reselecting, recompiling, or falling back to ambient auth.
      if (isZenCompatHandle(lease.credentialHandle)) {
        const compat = yield* resolveZenCompatExecution({
          providerID: lease.providerID,
          accountID: lease.accountID,
          credentialHandle: lease.credentialHandle,
          expectedCredentialRevision: lease.credentialRevision,
        })
        if (!compat) {
          return yield* new RouteResolutionError({
            providerID: input.providerID,
            modelID: input.modelID,
            cause: new Error("Committed OpenCode compatibility account is no longer available"),
          })
        }
        const materialized = yield* materializeZenCompatModel({
          state: input.state,
          providerID: input.providerID,
          modelID: input.modelID,
          execution: compat,
        })
        if (!materialized) {
          return yield* new RouteResolutionError({
            providerID: input.providerID,
            modelID: input.modelID,
            cause: new Error("Committed OpenCode compatibility account has no hosted catalog model"),
          })
        }
        input.state.zenCompatBindings.set(materialized.model, {
          providerInfo: materialized.providerInfo,
          accountID: compat.accountID,
          secret: compat.apiKey,
        })
        return { model: materialized.model, route: resolution } satisfies RoutedModel
      }

      let execution = yield* providerRoutes
        .resolveExecution({
          providerID: lease.providerID,
          accountID: lease.accountID,
          credentialHandle: lease.credentialHandle,
          modelID: input.modelID,
          expectedCredentialRevision: lease.credentialRevision,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteResolutionError({
                providerID: input.providerID,
                modelID: input.modelID,
                cause,
              }),
          ),
        )
      // P2 may advance credentialRevision without changing durable route
      // identity. Recompile that exact binding once; never re-enter selection,
      // failover, or explicit rebind logic downstream of the committed route.
      if (!execution) {
        const refreshed = yield* providerRoutes
          .compileExisting({
            sessionID: input.sessionID,
            providerID: input.providerID,
            modelID: input.modelID,
            affinityDomain: input.affinityDomain,
            routeIntent: { kind: "auto" },
            mode: "concentrate",
            freeRoutePreference: "public-first-for-free",
            allowPublic: input.allowPublic,
            publicEligible: input.publicEligible,
            expected: resolution.attribution,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteResolutionError({
                  providerID: input.providerID,
                  modelID: input.modelID,
                  cause,
                }),
            ),
          )
        if (refreshed.lease.route.kind !== "account") {
          return yield* new RouteResolutionError({
            providerID: input.providerID,
            modelID: input.modelID,
            cause: new Error("Committed account route changed kind during exact transport materialization"),
          })
        }
        resolution = refreshed
        execution = yield* providerRoutes
          .resolveExecution({
            providerID: refreshed.lease.route.providerID,
            accountID: refreshed.lease.route.accountID,
            credentialHandle: refreshed.lease.route.credentialHandle,
            modelID: input.modelID,
            expectedCredentialRevision: refreshed.lease.route.credentialRevision,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteResolutionError({
                  providerID: input.providerID,
                  modelID: input.modelID,
                  cause,
                }),
            ),
          )
      }
      if (!execution) {
        return yield* new RouteResolutionError({
          providerID: input.providerID,
          modelID: input.modelID,
          cause: new Error("Committed account lease changed before exact transport materialization"),
        })
      }

      const capability = execution.capabilities.providers[input.providerID]
      const baseProvider = input.state.catalog[input.providerID]
      const materialized = capability
        ? consoleModel(input.providerID, input.modelID, capability, baseProvider?.models[input.modelID])
        : undefined
      if (
        !capability ||
        !materialized ||
        materialized.status === "deprecated" ||
        (materialized.status === "alpha" && !runtimeFlags.enableExperimentalModels)
      ) {
        return yield* new ModelNotFoundError({
          providerID: input.providerID,
          modelID: input.modelID,
        })
      }

      const secret = execution.credential.type === "oauth" ? execution.credential.access : execution.credential.key
      const account = {
        realm,
        credentialID: execution.account.credentialID,
        credentialRevision: execution.credentialRevision,
        server: execution.snapshot.server,
        ...(execution.snapshot.orgID ? { orgID: execution.snapshot.orgID } : {}),
        configVersion: execution.snapshot.version,
        secret,
        snapshot: execution.snapshot,
        capabilities: execution.capabilities,
      } satisfies ConsoleAccountExecution
      const providerInfo = consoleProviderInfo(input.providerID, capability, materialized, baseProvider)
      const client = consoleClientIdentity(account, input.providerID, capability)
      const binding = { account, provider: capability, providerInfo, client } satisfies ConsoleBinding
      input.state.consoleBindings.set(materialized, binding)
      activateConsoleGeneration(input.state, binding)
      return { model: materialized, route: resolution } satisfies RoutedModel
    })

    /**
     * Materialize one already-selected Zen/Go compatibility account from the
     * trusted account-neutral catalog.
     *
     * The clone carries no key, no env values, and no configured api key; the
     * only transport authority is the route-locked fetch for the exact selected
     * account, so no second account choice is possible at the wire.
     */
    const materializeZenCompatModel = Effect.fn("Provider.materializeZenCompatModel")(function* (input: {
      readonly state: State
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
      readonly execution: ZenCompatExecution
    }) {
      const baseProvider = input.state.catalog[input.providerID]
      const base = baseProvider?.models[input.modelID]
      if (!base) return undefined
      if (base.status === "deprecated") return undefined
      if (base.status === "alpha" && !runtimeFlags.enableExperimentalModels) return undefined

      const providerInfo = toPublicInfo(baseProvider)
      providerInfo.env = []
      delete providerInfo.key
      delete providerInfo.options.apiKey
      providerInfo.options.fetch = committedZenProviderFetch(input.execution.accountID)
      const model = providerInfo.models[input.modelID]
      if (!model) return undefined
      return { model, providerInfo }
    })


    const materializeTransientResolution = Effect.fn("Provider.materializeTransientResolution")(function* (input: {
      readonly state: State
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
      readonly publicEligible: boolean
      readonly resolution: OpencodeProviderRoute.TransientResolution
    }) {
      const route = input.resolution.route
      if (route.kind === "public") {
        const baseProvider = input.state.catalog[input.providerID]
        const base = baseProvider?.models[input.modelID]
        if (!base || !input.publicEligible) {
          return yield* new RouteResolutionError({
            providerID: input.providerID,
            modelID: input.modelID,
            cause: new Error("Transient Public route is not eligible for this hosted model"),
          })
        }

        const providerInfo = toPublicInfo(baseProvider)
        providerInfo.env = []
        delete providerInfo.key
        delete providerInfo.options.apiKey
        providerInfo.options.fetch = committedPublicZenProviderFetch
        const materialized = providerInfo.models[input.modelID]
        if (!materialized) {
          return yield* new ModelNotFoundError({
            providerID: input.providerID,
            modelID: input.modelID,
          })
        }
        input.state.publicBindings.set(materialized, { providerInfo })
        // A Public route is credential-free by construction: the provider info
        // above has no key, no env values, and no configured api key, so the
        // only bearer it can carry is the hosted public sentinel.
        return {
          model: materialized,
          route: input.resolution,
          transport: routeTransport(providerInfo, materialized, ZEN_PUBLIC_API_KEY),
        } satisfies TransientRoutedModel
      }

      // Same exact-key rule as the durable path: a committed compatibility
      // route materializes only its own selected key, with no Core capability
      // path, no reselection, and no ambient fallback.
      if (isZenCompatHandle(route.credentialHandle)) {
        const compat = yield* resolveZenCompatExecution({
          providerID: route.providerID,
          accountID: route.accountID,
          credentialHandle: route.credentialHandle,
          expectedCredentialRevision: route.credentialRevision,
        })
        if (!compat) {
          return yield* new RouteResolutionError({
            providerID: input.providerID,
            modelID: input.modelID,
            cause: new Error("Transient OpenCode compatibility account is no longer available"),
          })
        }
        const materialized = yield* materializeZenCompatModel({
          state: input.state,
          providerID: input.providerID,
          modelID: input.modelID,
          execution: compat,
        })
        if (!materialized) {
          return yield* new RouteResolutionError({
            providerID: input.providerID,
            modelID: input.modelID,
            cause: new Error("Transient OpenCode compatibility account has no hosted catalog model"),
          })
        }
        return {
          model: materialized.model,
          route: input.resolution,
          transport: routeTransport(materialized.providerInfo, materialized.model, compat.apiKey),
        } satisfies TransientRoutedModel
      }

      const execution = yield* providerRoutes
        .resolveExecution({
          providerID: route.providerID,
          accountID: route.accountID,
          credentialHandle: route.credentialHandle,
          modelID: input.modelID,
          expectedCredentialRevision: route.credentialRevision,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteResolutionError({
                providerID: input.providerID,
                modelID: input.modelID,
                cause,
              }),
          ),
        )
      if (!execution) {
        return yield* new RouteResolutionError({
          providerID: input.providerID,
          modelID: input.modelID,
          cause: new Error("Transient account route changed before exact transport materialization"),
        })
      }

      const capability = execution.capabilities.providers[input.providerID]
      const baseProvider = input.state.catalog[input.providerID]
      const materialized = capability
        ? consoleModel(input.providerID, input.modelID, capability, baseProvider?.models[input.modelID])
        : undefined
      if (
        !capability ||
        !materialized ||
        materialized.status === "deprecated" ||
        (materialized.status === "alpha" && !runtimeFlags.enableExperimentalModels)
      ) {
        return yield* new ModelNotFoundError({
          providerID: input.providerID,
          modelID: input.modelID,
        })
      }

      const secret = execution.credential.type === "oauth" ? execution.credential.access : execution.credential.key
      const account = {
        realm,
        credentialID: execution.account.credentialID,
        credentialRevision: execution.credentialRevision,
        server: execution.snapshot.server,
        ...(execution.snapshot.orgID ? { orgID: execution.snapshot.orgID } : {}),
        configVersion: execution.snapshot.version,
        secret,
        snapshot: execution.snapshot,
        capabilities: execution.capabilities,
      } satisfies ConsoleAccountExecution
      const providerInfo = consoleProviderInfo(input.providerID, capability, materialized, baseProvider)
      const client = consoleClientIdentity(account, input.providerID, capability)
      const binding = { account, provider: capability, providerInfo, client } satisfies ConsoleBinding
      input.state.consoleBindings.set(materialized, binding)
      activateConsoleGeneration(input.state, binding)
      // Only the selected binding secret may reach the wire. Configured
      // provider keys, provider env values, and default-account credentials are
      // never consulted for an account route.
      return {
        model: materialized,
        route: input.resolution,
        transport: routeTransport(providerInfo, materialized, secret),
      } satisfies TransientRoutedModel
    })

    const resolveInheritedRoutedModel = Effect.fn("Provider.resolveInheritedRoutedModel")(function* (
      input: {
        readonly sessionID: CoreSessionSchema.ID
        readonly providerID: ProviderV2.ID
        readonly modelID: ModelV2.ID
        readonly route: ProviderRouteResolution.RouteAttribution
        readonly allowPublic?: boolean
      },
    ) {
      const s = yield* currentState(input.providerID)
      const accountModelID = ModelV2.ID.make(
        splitModelIDForProvider(input.modelID, input.providerID).baseModelID,
      )
      const affinityDomain = OpencodeProviderRoute.affinityDomain(input.providerID)
      const { allowPublic, publicEligible } = yield* routedAvailability({
        state: s,
        providerID: input.providerID,
        modelID: accountModelID,
        allowPublic: input.allowPublic,
      })

      // The parent attribution is the authority here. compileExisting validates
      // that the durable row is still that exact route generation, prepares only
      // the already-bound account when needed, and can refresh P2 credential
      // revision without selecting/rebinding/failing over.
      const resolution = yield* providerRoutes
        .compileExisting({
          sessionID: input.sessionID,
          providerID: input.providerID,
          modelID: accountModelID,
          affinityDomain,
          routeIntent: { kind: "auto" },
          mode: "concentrate",
          freeRoutePreference: "public-first-for-free",
          allowPublic,
          publicEligible,
          expected: input.route,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteResolutionError({
                providerID: input.providerID,
                modelID: accountModelID,
                cause,
              }),
          ),
        )

      return yield* materializeRoutedResolution({
        state: s,
        sessionID: input.sessionID,
        providerID: input.providerID,
        modelID: accountModelID,
        affinityDomain,
        allowPublic,
        publicEligible,
        resolution,
      })
    })

    const resolveRoutedModel = Effect.fn("Provider.resolveRoutedModel")(function* (
      input: {
        readonly sessionID: CoreSessionSchema.ID
        readonly providerID: ProviderV2.ID
        readonly modelID: ModelV2.ID
        readonly accountID?: string
        readonly routeIntent?: ProviderRouteIntent.Info
        readonly allowPublic?: boolean
      },
    ) {
      const s = yield* currentState(input.providerID)
      const accountModelID = ModelV2.ID.make(
        splitModelIDForProvider(input.modelID, input.providerID).baseModelID,
      )
      const affinityDomain = OpencodeProviderRoute.affinityDomain(input.providerID)

      // Migration-window V1 selections used Credential.ID as model.accountID for
      // Console accounts. Translate that local handle into the stable remote
      // ProviderAccount identity before route intent normalization. Never let the
      // opaque credential handle become the durable account identity.
      let legacyAccountID = input.accountID
      if (legacyAccountID?.startsWith("cred_")) {
        const stored = yield* credentials.get(Credential.ID.make(legacyAccountID))
        const projected = stored ? projectOpencodeCredential(stored) : undefined
        if (!projected) {
          return yield* new RouteResolutionError({
            providerID: input.providerID,
            modelID: accountModelID,
            cause: new Error("Selected OpenCode credential cannot be projected to a stable ProviderAccount identity"),
          })
        }
        legacyAccountID = projected.accountID
      }

      const routeIntent = yield* ProviderRouteIntentRuntime.normalize({
        routeIntent: input.routeIntent,
        ...(legacyAccountID ? { legacyAccountID } : {}),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new RouteResolutionError({
              providerID: input.providerID,
              modelID: accountModelID,
              cause,
            }),
        ),
      )

      // Public is only an OpenCode-hosted route. Its eligibility requires both
      // the live hosted-model witness and trusted all-zero pricing metadata.
      const { allowPublic, publicEligible } = yield* routedAvailability({
        state: s,
        providerID: input.providerID,
        modelID: accountModelID,
        allowPublic: input.allowPublic,
      })

      let resolution = yield* providerRoutes
        .resolveIfApplicable({
          sessionID: input.sessionID,
          providerID: input.providerID,
          modelID: accountModelID,
          affinityDomain,
          routeIntent,
          mode: "concentrate",
          freeRoutePreference: "public-first-for-free",
          allowPublic,
          publicEligible,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteResolutionError({
                providerID: input.providerID,
                modelID: accountModelID,
                cause,
              }),
          ),
        )

      // No durable route, no explicit OpenCode intent, and no account/public
      // ownership evidence: preserve the mature direct-provider path for
      // third-party providers only. A hosted OpenCode provider may never
      // return undefined, because callers would then spend an ambient
      // credential outside the route authority and without route attribution.
      if (!resolution) {
        if (!isHostedZenProvider(input.providerID)) return undefined
        return yield* noHostedRouteError(input.providerID, accountModelID)
      }

      return yield* materializeRoutedResolution({
        state: s,
        sessionID: input.sessionID,
        providerID: input.providerID,
        modelID: accountModelID,
        affinityDomain,
        allowPublic,
        publicEligible,
        resolution,
      })
    })

    const resolveTransientRoutedModel = Effect.fn("Provider.resolveTransientRoutedModel")(function* (
      input: {
        readonly providerID: ProviderV2.ID
        readonly modelID: ModelV2.ID
        readonly accountID?: string
        readonly routeIntent?: ProviderRouteIntent.Info
        readonly allowPublic?: boolean
      },
    ) {
      const s = yield* currentState(input.providerID)
      const accountModelID = ModelV2.ID.make(
        splitModelIDForProvider(input.modelID, input.providerID).baseModelID,
      )

      let legacyAccountID = input.accountID
      if (legacyAccountID?.startsWith("cred_")) {
        const stored = yield* credentials.get(Credential.ID.make(legacyAccountID))
        const projected = stored ? projectOpencodeCredential(stored) : undefined
        if (!projected) {
          return yield* new RouteResolutionError({
            providerID: input.providerID,
            modelID: accountModelID,
            cause: new Error("Selected OpenCode credential cannot be projected to a stable ProviderAccount identity"),
          })
        }
        legacyAccountID = projected.accountID
      }

      const routeIntent = yield* ProviderRouteIntentRuntime.normalize({
        routeIntent: input.routeIntent,
        ...(legacyAccountID ? { legacyAccountID } : {}),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new RouteResolutionError({
              providerID: input.providerID,
              modelID: accountModelID,
              cause,
            }),
        ),
      )

      const { allowPublic, publicEligible } = yield* routedAvailability({
        state: s,
        providerID: input.providerID,
        modelID: accountModelID,
        allowPublic: input.allowPublic,
      })

      const resolution = yield* providerRoutes
        .resolveTransient({
          providerID: input.providerID,
          modelID: accountModelID,
          routeIntent,
          mode: "concentrate",
          freeRoutePreference: "public-first-for-free",
          allowPublic,
          publicEligible,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteResolutionError({
                providerID: input.providerID,
                modelID: accountModelID,
                cause,
              }),
          ),
        )

      if (!resolution) {
        if (!isHostedZenProvider(input.providerID)) return undefined
        return yield* noHostedRouteError(input.providerID, accountModelID)
      }

      return yield* materializeTransientResolution({
        state: s,
        providerID: input.providerID,
        modelID: accountModelID,
        publicEligible,
        resolution,
      })
    })

    const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
      const primitive = modelPrimitive(model)
      if (primitive !== "language") {
        return yield* new UnsupportedModelPrimitiveError({
          providerID: model.providerID,
          modelID: model.id,
          primitive,
          required: "language",
        })
      }
      // Language-model construction is a provider read just like getModel/getProvider.
      // Revalidate the per-instance provider snapshot so Config.invalidate() cannot
      // leave execution bound to stale transport options after a local config mutation.
      const s = yield* currentState(model.providerID)
      const binding = s.consoleBindings.get(model)
      const publicBinding = s.publicBindings.get(model)
      const compatBinding = s.zenCompatBindings.get(model)
      const activation = binding ? activateConsoleGeneration(s, binding) : undefined
      const envs = binding || publicBinding || compatBinding ? {} : yield* env.all()
      const key = binding
        ? `console/${binding.client.generation}/${model.providerID}/${model.id}/${model.api.id}`
        : publicBinding
          ? `public/${model.providerID}/${model.id}/${model.api.id}`
          : compatBinding
            ? `zen-compat/${compatBinding.accountID}/${model.providerID}/${model.id}/${model.api.id}`
            : `${model.providerID}/${model.id}`
      const existing = !activation || activation.cacheable ? s.models.get(key) : undefined
      if (existing) return existing

      const provider =
        binding?.providerInfo ?? publicBinding?.providerInfo ?? compatBinding?.providerInfo ?? s.providers[model.providerID]
      return yield* EffectPromise.refineRejection(
        async () => {
          const sdk = await resolveSDK(model, s, envs)
          const language = s.modelLoaders[model.providerID]
            ? await s.modelLoaders[model.providerID](
                sdk,
                model.api.id,
                {
                  ...provider.options,
                  ...model.options,
                  ...(binding ? { apiKey: binding.account.secret } : {}),
                  ...(publicBinding ? { apiKey: ZEN_PUBLIC_API_KEY } : {}),
                  ...(compatBinding ? { apiKey: compatBinding.secret } : {}),
                },
                model,
              )
            : sdk.languageModel(model.api.id)
          if (!activation || activation.cacheable) {
            s.models.set(key, language)
            activation?.slot?.modelKeys.add(key)
          }
          return language
        },
        (cause) =>
          cause instanceof NoSuchModelError
            ? new ModelNotFoundError({ modelID: model.id, providerID: model.providerID, cause })
            : undefined,
      )
    })

    const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderV2.ID, query: string[]) {
      const s = yield* currentState(providerID)
      const provider = s.providers[providerID]
      if (!provider) return undefined
      for (const item of query) {
        for (const model of Object.values(provider.models)) {
          if (!isLanguageModel(model)) continue
          if (model.id.includes(item)) return { providerID, modelID: model.id }
        }
      }
      return undefined
    })

    const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (providerID: ProviderV2.ID) {
      const cfg = yield* config.get()

      if (cfg.small_model) {
        const parsed = parseModel(cfg.small_model)
        const configured = yield* getModel(parsed.providerID, parsed.modelID).pipe(
          Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)),
        )
        return configured && isLanguageModel(configured) ? configured : undefined
      }

      const s = yield* currentState(providerID)
      const provider = s.providers[providerID]
      if (!provider) return undefined

      const experimental = yield* plugin.trigger<"experimental.provider.small_model">(
        "experimental.provider.small_model",
        { provider: toPublicInfo(provider) },
        { model: undefined },
      )
      if (experimental.model) {
        const candidate = {
          ...experimental.model,
          id: ModelV2.ID.make(experimental.model.id),
          providerID: ProviderV2.ID.make(experimental.model.providerID),
        }
        if (isLanguageModel(candidate)) return candidate
      }

      // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
      if (providerID === ProviderV2.ID.azure || providerID === ProviderV2.ID.make("azure-cognitive-services")) {
        return undefined
      }

      const priority = providerID.startsWith("opencode")
        ? ["gpt-nano"]
        : providerID.startsWith("github-copilot")
          ? ["gpt-mini", ...smallModelFamilyPriority]
          : smallModelFamilyPriority
      const models = sortBy(
        Object.values(provider.models).filter(isLanguageModel),
        [(model) => model.release_date, "desc"],
        [(model) => model.id, "desc"],
      )
      for (const family of priority) {
        const candidates = models.filter((model) => model.family === family)
        if (providerID === ProviderV2.ID.amazonBedrock) {
          const crossRegionPrefixes = ["global.", "us.", "eu."]

          const globalMatch = candidates.find((model) => model.id.startsWith("global."))
          if (globalMatch) return globalMatch

          const region = provider.options?.region
          if (region) {
            const regionPrefix = region.split("-")[0]
            if (regionPrefix === "us" || regionPrefix === "eu") {
              const regionalMatch = candidates.find((model) => model.id.startsWith(`${regionPrefix}.`))
              if (regionalMatch) return regionalMatch
            }
          }

          const unprefixed = candidates.find((model) => !crossRegionPrefixes.some((p) => model.id.startsWith(p)))
          if (unprefixed) return unprefixed
          continue
        }
        // Housekeeping calls (titles, summaries) run without user consent per-request, so
        // prefer a zero-cost variant of the same family over a newer paid one; fall back
        // to the newest paid model only when the family has no free option.
        const free = candidates.find((model) => model.cost.input === 0 && model.cost.output === 0)
        if (free) return free
        if (candidates[0]) return candidates[0]
      }

      return undefined
    })

    const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
      const cfg = yield* config.get()
      const s = yield* currentState(cfg.model ? parseModel(cfg.model).providerID : undefined)
      if (cfg.model) {
        const configured = parseModel(cfg.model)
        const model =
          s.providers[configured.providerID]?.models[configured.modelID]
        // Preserve explicit configuration when the current provider snapshot
        // cannot resolve it yet. Only self-heal away from a configured model
        // when we can positively prove it is not conversationally eligible.
        if (!model || isLanguageModel(model)) {
          return configured
        }
      }

      const recent = yield* fs.readJson(path.join(Global.Path.state, "model.json")).pipe(
        Effect.map((x): { providerID: ProviderV2.ID; modelID: ModelV2.ID }[] => {
          if (!isRecord(x) || !Array.isArray(x.recent)) return []
          return x.recent.flatMap((item) => {
            if (!isRecord(item)) return []
            if (typeof item.providerID !== "string") return []
            if (typeof item.modelID !== "string") return []
            return [{ providerID: ProviderV2.ID.make(item.providerID), modelID: ModelV2.ID.make(item.modelID) }]
          })
        }),
        Effect.catch(() => Effect.succeed([] as { providerID: ProviderV2.ID; modelID: ModelV2.ID }[])),
      )
      for (const entry of recent) {
        const provider = s.providers[entry.providerID]
        if (!provider) continue
        const model = provider.models[entry.modelID]
        if (!model || !isLanguageModel(model)) continue
        return { providerID: entry.providerID, modelID: entry.modelID }
      }

      const configured = Object.keys(cfg.provider ?? {})
      const candidates = Object.values(s.providers).filter((p) => configured.length === 0 || configured.includes(p.id))
      const provider =
        candidates.find((p) => Object.values(p.models).some(isLanguageModel)) ??
        candidates[0]
      if (!provider) return yield* new NoProvidersError()
      const [model] = sort(Object.values(provider.models).filter(isLanguageModel))
      if (!model) return yield* new NoModelsError({ providerID: provider.id })
      return {
        providerID: provider.id,
        modelID: model.id,
      }
    })

    return Service.of({
      list,
      listAccountModelProjections,
      getProvider,
      resolveAccountID,
      getModel,
      resolveRoutedModel,
      resolveInheritedRoutedModel,
      resolveTransientRoutedModel,
      getLanguage,
      closest,
      getSmallModel,
      defaultModel,
    })
  }),
)

const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
const smallModelFamilyPriority = ["gemini-flash", "gpt-nano", "claude-haiku"]
export function sort<T extends { id: string }>(models: T[]) {
  return sortBy(
    models,
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.id, "desc"],
  )
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  const split = splitModelIDForProvider(rest.join("/"), providerID)
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ModelV2.ID.make(split.baseModelID),
    ...(split.accountID ? { accountID: split.accountID } : {}),
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    FSUtil.node,
    Config.node,
    Auth.node,
    Env.node,
    Plugin.node,
    ModelsDev.node,
    RuntimeFlags.node,
    GensparkCatalog.node,
    Credential.node,
    CredentialResolver.node,
    ProviderRoute.node,
    ProviderRouteHealth.node,
    ProviderCatalogContributions.node,
    httpClientNode,
  ],
})

export * as Provider from "./provider"
