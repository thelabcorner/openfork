import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import * as FirecrawlWebSearch from "./firecrawl-websearch"
import * as DuckDuckGoWebSearch from "./duckduckgo-websearch"
import * as BraveWebSearch from "./brave-websearch"
import * as TavilyWebSearch from "./tavily-websearch"
import * as SearxngWebSearch from "./searxng-websearch"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@opencode-ai/core/util/encode"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"

export const WEBSEARCH_PROVIDERS = [
  "exa",
  "parallel",
  "firecrawl",
  "duckduckgo",
  "brave",
  "tavily",
  "searxng",
] as const
export type WebSearchProvider = (typeof WEBSEARCH_PROVIDERS)[number]

const WebSearchProviderSchema = Schema.Literals(WEBSEARCH_PROVIDERS)

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["search", "providers"])).annotate({
    description:
      "Action: 'search' (default) runs a query and returns results; 'providers' lists the available search providers, their config status (keyless-ready | needs <ENV_VAR>), and how to enable each.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Websearch query (required for action 'search')",
  }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
  provider: Schema.optional(WebSearchProviderSchema).annotate({
    description:
      "Explicitly pin a search provider: exa | parallel | firecrawl | duckduckgo | brave | tavily | searxng. Overrides automatic selection (env override, feature flags, session checksum). Run action:'providers' to see which are usable.",
  }),
})

export type WebSearchFlags = Partial<Record<WebSearchProvider, boolean>>

// Keyless-ready providers work with no configuration; key/config providers
// become available when their env var is set (or their flag is enabled).
const KEYLESS_PROVIDERS: ReadonlySet<WebSearchProvider> = new Set([
  "exa",
  "parallel",
  "firecrawl",
  "duckduckgo",
])

const PROVIDER_ENV: Partial<Record<WebSearchProvider, string>> = {
  brave: "BRAVE_API_KEY",
  tavily: "TAVILY_API_KEY",
  searxng: "SEARXNG_URL",
}

// Flag precedence when multiple flags are set (parallel-first preserved, then
// exa/firecrawl, then the free providers in insertion order).
export const PROVIDER_FLAG_ORDER: readonly WebSearchProvider[] = [
  "parallel",
  "exa",
  "firecrawl",
  "duckduckgo",
  "brave",
  "tavily",
  "searxng",
]

export function isWebSearchProvider(value: string | undefined): value is WebSearchProvider {
  return value !== undefined && (WEBSEARCH_PROVIDERS as readonly string[]).includes(value)
}

export function isProviderAvailable(p: WebSearchProvider, flags: WebSearchFlags = {}): boolean {
  if (flags[p]) return true
  if (KEYLESS_PROVIDERS.has(p)) return true
  const env = PROVIDER_ENV[p]
  return env !== undefined && Boolean(process.env[env])
}

/** Per-provider config status for the `providers` action. */
export function providerStatus(p: WebSearchProvider, flags: WebSearchFlags = {}): string {
  if (flags[p]) return "enabled via flag"
  if (KEYLESS_PROVIDERS.has(p)) return "keyless-ready"
  const env = PROVIDER_ENV[p]
  if (env && process.env[env]) return "ready"
  return `needs ${env}`
}

export function selectWebSearchProvider(
  sessionID: string,
  flags: WebSearchFlags = {},
  pin?: WebSearchProvider,
): WebSearchProvider {
  // Explicit in-call pin wins (the agent/user deliberately chose a provider).
  if (pin && isWebSearchProvider(pin)) return pin
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (isWebSearchProvider(override)) return override
  for (const p of PROVIDER_FLAG_ORDER) {
    if (flags[p]) return p
  }

  // Deterministic per-session spread over the AVAILABLE providers only —
  // keyless-first when no keys are configured.
  const available = WEBSEARCH_PROVIDERS.filter((p) => isProviderAvailable(p, flags))
  const mod = Number.parseInt(checksum(sessionID) ?? "0", 36) % available.length
  return available[mod]
}

export function webSearchProviderLabel(provider: unknown) {
  const labels: Record<string, string> = {
    parallel: "Parallel Web Search",
    exa: "Exa Web Search",
    firecrawl: "Firecrawl Web Search",
    duckduckgo: "DuckDuckGo",
    brave: "Brave Search",
    tavily: "Tavily Search",
    searxng: "SearXNG",
  }
  if (typeof provider === "string" && provider in labels) return labels[provider]
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

function parallelAuthHeaders() {
  const headers = { "User-Agent": `opencode/${InstallationVersion}` }
  if (!process.env.PARALLEL_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` }
}

function callProvider(
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query!,
        search_queries: [params.query!],
        session_id: ctx.sessionID,
        model_name: webSearchModelName(ctx.extra),
      },
      "25 seconds",
      parallelAuthHeaders(),
    )
  }

  if (provider === "firecrawl") {
    return FirecrawlWebSearch.call(
      http,
      params.query!,
      Math.min(Math.max(Math.trunc(params.numResults || 8), 1), 100),
    )
  }

  if (provider === "duckduckgo") {
    return DuckDuckGoWebSearch.call(http, params.query!)
  }

  if (provider === "brave") {
    return BraveWebSearch.call(http, params.query!, Math.min(Math.max(Math.trunc(params.numResults || 8), 1), 20))
  }

  if (provider === "tavily") {
    return TavilyWebSearch.call(http, params.query!, Math.min(Math.max(Math.trunc(params.numResults || 8), 1), 20))
  }

  if (provider === "searxng") {
    return SearxngWebSearch.call(http, params.query!)
  }

  return McpWebSearch.call(
    http,
    McpWebSearch.EXA_URL,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query!,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
}

function providersOutput(flags: Record<string, boolean>): string {
  const keyless = WEBSEARCH_PROVIDERS.filter((p) => KEYLESS_PROVIDERS.has(p)).length
  const lines = [
    `websearch providers (${WEBSEARCH_PROVIDERS.length}, ${keyless} keyless-ready):`,
  ]
  for (const p of WEBSEARCH_PROVIDERS) {
    const status = providerStatus(p, flags)
    const note =
      p === "brave" ? "  (free tier: https://brave.com/search/api/)"
      : p === "tavily" ? "  (free tier: https://tavily.com)"
      : p === "searxng" ? "  (self-hosted: https://docs.searxng.org)"
      : ""
    lines.push(`  ${p.padEnd(11)} ${status}${note}`)
  }
  lines.push("")
  lines.push("Enable a key-based provider by setting its env var (e.g. BRAVE_API_KEY=...).")
  lines.push('Pin a provider with provider: "brave", or set OPENCODE_WEBSEARCH_PROVIDER=brave.')
  return lines.join("\n")
}

type WebSearchMeta = { action: "search" | "providers"; provider: WebSearchProvider | undefined }

export const WebSearchTool = Tool.define<
  typeof Parameters,
  WebSearchMeta,
  HttpClient.HttpClient | RuntimeFlags.Service
>(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const flagMap = {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
            firecrawl: flags.enableFirecrawl,
            duckduckgo: flags.enableDuckDuckGo,
            brave: flags.enableBrave,
            tavily: flags.enableTavily,
            searxng: flags.enableSearxng,
          }

          // ── Introspection: no query, no network, no permission ask ──
          if (params.action === "providers") {
            const output = providersOutput(flagMap)
            return {
              title: "websearch providers",
              output,
              metadata: { action: "providers" as const, provider: undefined },
            }
          }

          if (!params.query) {
            return yield* Effect.fail(new Error("query is required for action 'search'"))
          }

          const provider = selectWebSearchProvider(ctx.sessionID, flagMap, params.provider)
          const title = webSearchProviderLabel(provider)
          yield* ctx.metadata({ title: `${title} "${params.query}"`, metadata: { provider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider,
            },
          })

          const result = yield* callProvider(http, provider, params, ctx)

          return {
            output: result ?? "No search results found. Please try a different query.",
            title: `${title}: ${params.query}`,
            metadata: { provider, action: "search" as const },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
