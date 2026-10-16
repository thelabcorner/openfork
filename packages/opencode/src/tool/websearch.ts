import { Cause, Clock, Effect, Exit, Option, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import * as FirecrawlWebSearch from "./firecrawl-websearch"
import * as DuckDuckGoWebSearch from "./duckduckgo-websearch"
import * as BraveWebSearch from "./brave-websearch"
import * as TavilyWebSearch from "./tavily-websearch"
import * as SearxngWebSearch from "./searxng-websearch"
import * as OllamaWebSearch from "./ollama-websearch"
import DESCRIPTION from "./websearch.txt"
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
  "ollama",
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
      "Advanced override: strictly pin one search provider. Normally omit this so automatic search can use the free-first fallback chain. Run action:'providers' to inspect backend status.",
  }),
})

export type WebSearchFlags = Partial<Record<WebSearchProvider, boolean>>

// These providers offer anonymous search endpoints, but network/anti-abuse
// policy can still reject access for individual hosts. Feature flags are routing
// preferences, never substitutes for credentials where required.
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
  ollama: "OLLAMA_API_KEY",
}

// ── Anonymous anti-abuse cooldown (process-local, lazily expired) ────────────
// Keyless Firecrawl exists, but anti-abuse policy can deny individual hosts
// outright (HTTP 403) or throttle them (HTTP 429). Typed denials are recorded
// per provider + auth mode so automatic fallback stops re-probing a known-denied
// anonymous endpoint. State is process-local and expires lazily against the
// Effect Clock: no timers, no background probes, no persistence, no per-session
// or per-user state. Strict pins (provider param / OPENCODE_WEBSEARCH_PROVIDER)
// and a configured credential bypass the check by construction.

/** Denial statuses that suspend automatic anonymous probing, with their TTLs. */
const ANONYMOUS_COOLDOWN_TTL_MS: Readonly<Record<number, number>> = {
  401: 5 * 60_000,
  403: 5 * 60_000,
  429: 60_000,
}

export type ProviderAuthMode = "anonymous" | "authenticated"

type ProviderCooldown = {
  readonly expiresAt: number
  readonly status: number
}

const providerCooldowns = new Map<string, ProviderCooldown>()

/** Auth mode of a provider as configured right now; never exposes secrets. */
export function providerAuthMode(provider: WebSearchProvider): ProviderAuthMode {
  if (provider === "firecrawl") return process.env.FIRECRAWL_API_KEY ? "authenticated" : "anonymous"
  const env = PROVIDER_ENV[provider]
  return env && process.env[env] ? "authenticated" : "anonymous"
}

const cooldownKey = (provider: WebSearchProvider, mode: ProviderAuthMode) => `${provider}:${mode}`

/**
 * Active cooldown for `provider` under its *current* auth mode at `now` (ms),
 * or undefined. Expired entries are dropped here; nothing wakes up on expiry.
 * Because the key includes the auth mode, an authenticated request never reads
 * an anonymous cooldown and vice versa.
 */
export function providerCooldownInfo(
  provider: WebSearchProvider,
  now: number,
): { readonly status: number; readonly remainingMs: number } | undefined {
  const key = cooldownKey(provider, providerAuthMode(provider))
  const state = providerCooldowns.get(key)
  if (!state) return undefined
  const remainingMs = state.expiresAt - now
  if (remainingMs <= 0) {
    providerCooldowns.delete(key)
    return undefined
  }
  return { status: state.status, remainingMs }
}

/**
 * Record a typed provider denial. Only anonymous keyless mode cools down: a
 * configured credential is its own access mode and bypasses host-IP denials.
 * A longer existing window is never shortened by a later, shorter status.
 */
export function noteProviderCooldown(provider: WebSearchProvider, status: number, now: number): void {
  const ttl = ANONYMOUS_COOLDOWN_TTL_MS[status]
  if (ttl === undefined) return
  if (providerAuthMode(provider) !== "anonymous") return
  const expiresAt = now + ttl
  const key = cooldownKey(provider, "anonymous")
  const existing = providerCooldowns.get(key)
  if (existing && existing.expiresAt >= expiresAt) return
  providerCooldowns.set(key, { expiresAt, status })
}

/** Test-only: clear process-local cooldown state so tests cannot leak into each other. */
export function resetWebSearchCooldowns(): void {
  providerCooldowns.clear()
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
  "ollama",
]

// Automatic search should be predictable and resilient, not session-random.
// Prefer agent-oriented keyless APIs before brittle HTML scraping. Configured
// key/self-hosted providers remain ahead of DuckDuckGo as a final fallback.
export const DEFAULT_PROVIDER_ORDER: readonly WebSearchProvider[] = [
  "parallel",
  "exa",
  "firecrawl",
  "searxng",
  "brave",
  "tavily",
  "ollama",
  "duckduckgo",
]

export function isWebSearchProvider(value: string | undefined): value is WebSearchProvider {
  return value !== undefined && (WEBSEARCH_PROVIDERS as readonly string[]).includes(value)
}

export function isProviderAvailable(p: WebSearchProvider, flags: WebSearchFlags = {}): boolean {
  void flags
  if (KEYLESS_PROVIDERS.has(p)) return true
  const env = PROVIDER_ENV[p]
  return env !== undefined && Boolean(process.env[env])
}

/** Per-provider config status for the `providers` action. */
export function providerStatus(p: WebSearchProvider, flags: WebSearchFlags = {}, now: number = Date.now()): string {
  const base = configuredProviderStatus(p, flags)
  const cooldown = providerCooldownInfo(p, now)
  if (!cooldown) return base
  return `${base} (cooldown ${Math.ceil(cooldown.remainingMs / 1000)}s after HTTP ${cooldown.status})`
}

function configuredProviderStatus(p: WebSearchProvider, flags: WebSearchFlags): string {
  if (p === "firecrawl") {
    const mode = process.env.FIRECRAWL_API_KEY
      ? "ready (authenticated)"
      : "keyless-conditional (IP policy may require FIRECRAWL_API_KEY)"
    return flags[p] ? `${mode} (preferred via flag)` : mode
  }
  if (KEYLESS_PROVIDERS.has(p)) return flags[p] ? "keyless-ready (preferred via flag)" : "keyless-ready"
  const env = PROVIDER_ENV[p]
  if (env && process.env[env]) return flags[p] ? "ready (preferred via flag)" : "ready"
  return flags[p] ? `needs ${env} (flag set but provider is not configured)` : `needs ${env}`
}

export function webSearchProviderCandidates(
  flags: WebSearchFlags = {},
  pin?: WebSearchProvider,
): readonly WebSearchProvider[] {
  // Explicit call-site pins and the operational env override retain strict
  // semantics. Flags are preferences: if a preferred backend fails, automatic
  // search may still fall through to another available backend.
  if (pin && isWebSearchProvider(pin)) return [pin]
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (isWebSearchProvider(override)) return [override]

  const preferred = PROVIDER_FLAG_ORDER.filter((provider) => flags[provider] && isProviderAvailable(provider, flags))
  const automatic = DEFAULT_PROVIDER_ORDER.filter((provider) => isProviderAvailable(provider, flags))
  return [...new Set([...preferred, ...automatic])]
}

export function selectWebSearchProvider(
  sessionID: string,
  flags: WebSearchFlags = {},
  pin?: WebSearchProvider,
): WebSearchProvider {
  void sessionID
  return webSearchProviderCandidates(flags, pin)[0] ?? "parallel"
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
    ollama: "Ollama Web Search",
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

export function callProvider(
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  context: { readonly sessionID: string; readonly modelName?: string },
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
        session_id: context.sessionID,
        model_name: context.modelName,
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

  if (provider === "ollama") {
    return OllamaWebSearch.call(http, params.query!, Math.min(Math.max(Math.trunc(params.numResults || 8), 1), 20))
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

export type WebSearchAttempt = {
  readonly provider: WebSearchProvider
  readonly status: "success" | "empty" | "error" | "unavailable"
  readonly detail?: string
}

export type WebSearchExecution = {
  readonly provider: WebSearchProvider
  readonly output: string
  readonly attempts: readonly WebSearchAttempt[]
}

// Some remote search tools return a natural-language empty-result marker as a
// successful text block. Such a response must not terminate the fallback chain.
export function hasSearchResults(output: string | undefined): boolean {
  if (!output?.trim()) return false
  return !/^(?:no (?:search )?results(?: found)?|no relevant results(?: found)?)(?:[.!]\s*(?:please try.*)?)?$/i.test(
    output.trim(),
  )
}

export const searchWithFallback = Effect.fn("WebSearch.searchWithFallback")(function* (
  http: HttpClient.HttpClient,
  params: Schema.Schema.Type<typeof Parameters>,
  context: { readonly sessionID: string; readonly modelName?: string },
  flags: WebSearchFlags = {},
) {
  const candidates = webSearchProviderCandidates(flags, params.provider)
  const attempts: WebSearchAttempt[] = []
  // Strict selection (explicit provider param, or the operational env pin that
  // `webSearchProviderCandidates` also treats as strict) bypasses the anonymous
  // cooldown: that caller deliberately chose this backend over the chain.
  const envPin = process.env.OPENCODE_WEBSEARCH_PROVIDER
  const pinned = params.provider ?? (isWebSearchProvider(envPin) ? envPin : undefined)

  for (const provider of candidates) {
    const now = yield* Clock.currentTimeMillis
    if (!isProviderAvailable(provider, flags)) {
      attempts.push({ provider, status: "unavailable", detail: providerStatus(provider, flags, now) })
      continue
    }

    if (pinned !== provider) {
      const cooldown = providerCooldownInfo(provider, now)
      if (cooldown) {
        attempts.push({
          provider,
          status: "unavailable",
          detail: `cooldown ${Math.ceil(cooldown.remainingMs / 1000)}s after HTTP ${cooldown.status}`,
        })
        continue
      }
    }

    // Provider clients are not yet uniform about typed failures versus defects.
    // Capture the full Exit so one broken backend cannot terminate auto search.
    // Bound *the complete provider effect*, including response body consumption.
    // Provider adapters currently time out their header request only.
    const exit = yield* Effect.exit(
      callProvider(http, provider, params, context).pipe(
        Effect.timeoutOrElse({
          duration: candidates.length === 1 ? "25 seconds" : "12 seconds",
          orElse: () => Effect.fail(new Error("Search provider exceeded its response deadline")),
        }),
      ),
    )
    if (Exit.isSuccess(exit)) {
      const output = exit.value?.trim()
      if (hasSearchResults(output)) {
        attempts.push({ provider, status: "success" })
        return { provider, output: output!, attempts } satisfies WebSearchExecution
      }
      attempts.push({ provider, status: "empty" })
      continue
    }

    // Do not misclassify a caller cancellation as an unavailable provider and
    // continue issuing network requests after an interrupted search. A
    // cancelled attempt also records no cooldown: only completed denials do.
    if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause)

    const failure = Cause.findErrorOption(exit.cause)
    if (Option.isSome(failure) && FirecrawlWebSearch.isFirecrawlHttpStatusError(failure.value)) {
      noteProviderCooldown(provider, failure.value.status, yield* Clock.currentTimeMillis)
    }
    attempts.push({
      provider,
      status: "error",
      detail: Cause.pretty(exit.cause).slice(0, 500),
    })
  }

  const summary = attempts.map((attempt) => `${attempt.provider}:${attempt.status}`).join(", ")
  return yield* Effect.fail(new Error(`Web search failed across all eligible providers (${summary || "none"})`))
})

export const executeWebSearch = Effect.fn("WebSearch.execute")(function* (
  http: HttpClient.HttpClient,
  params: Schema.Schema.Type<typeof Parameters>,
  context: { readonly sessionID: string; readonly modelName?: string },
  flags: WebSearchFlags = {},
) {
  return yield* searchWithFallback(http, params, context, flags).pipe(
    Effect.timeoutOrElse({
      duration: "45 seconds",
      orElse: () => Effect.fail(new Error("Web search exceeded its 45-second total deadline")),
    }),
  )
})

export function providersOutput(flags: Record<string, boolean>, now: number = Date.now()): string {
  const keyless = WEBSEARCH_PROVIDERS.filter((p) => KEYLESS_PROVIDERS.has(p)).length
  const lines = [
    `websearch providers (${WEBSEARCH_PROVIDERS.length}, ${keyless} keyless-ready):`,
  ]
  for (const p of WEBSEARCH_PROVIDERS) {
    const status = providerStatus(p, flags, now)
    const note =
      p === "brave" ? "  (free tier: https://brave.com/search/api/)"
      : p === "tavily" ? "  (free tier: https://tavily.com)"
      : p === "firecrawl" ? "  (free tier: https://firecrawl.dev/pricing)"
      : p === "searxng" ? "  (self-hosted: https://docs.searxng.org)"
      : p === "ollama" ? "  (free account: https://ollama.com/blog/web-search)"
      : ""
    lines.push(`  ${p.padEnd(11)} ${status}${note}`)
  }
  lines.push("")
  lines.push("Enable a key-based provider by setting its env var (e.g. BRAVE_API_KEY=...).")
  lines.push('Pin a provider with provider: "brave", or set OPENCODE_WEBSEARCH_PROVIDER=brave.')
  return lines.join("\n")
}

export function flagMap(flags: RuntimeFlags.Info): Record<WebSearchProvider, boolean> {
  return {
    exa: flags.enableExa,
    parallel: flags.enableParallel,
    firecrawl: flags.enableFirecrawl,
    duckduckgo: flags.enableDuckDuckGo,
    brave: flags.enableBrave,
    tavily: flags.enableTavily,
    searxng: flags.enableSearxng,
    ollama: flags.enableOllamaSearch,
  }
}

type WebSearchMeta = {
  action: "search" | "providers"
  provider: WebSearchProvider | undefined
  attemptedProviders?: readonly WebSearchProvider[]
}

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
          const flagsByProvider = flagMap(flags)

          // ── Introspection: no query, no network, no permission ask ──
          if (params.action === "providers") {
            const output = providersOutput(flagsByProvider, yield* Clock.currentTimeMillis)
            return {
              title: "websearch providers",
              output,
              metadata: { action: "providers" as const, provider: undefined },
            }
          }

          if (!params.query) {
            return yield* Effect.fail(new Error("query is required for action 'search'"))
          }

          const candidates = webSearchProviderCandidates(flagsByProvider, params.provider)
          const preferredProvider = candidates[0]
          yield* ctx.metadata({
            title: `Web Search "${params.query}"`,
            metadata: { provider: preferredProvider, providers: candidates },
          })

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
              provider: preferredProvider,
              providers: candidates,
            },
          })

          const result = yield* executeWebSearch(
            http,
            params,
            {
              sessionID: ctx.sessionID,
              modelName: webSearchModelName(ctx.extra),
            },
            flagsByProvider,
          )
          const title = webSearchProviderLabel(result.provider)

          return {
            output: result.output,
            title: `${title}: ${params.query}`,
            metadata: {
              provider: result.provider,
              action: "search" as const,
              attemptedProviders: result.attempts.map((attempt) => attempt.provider),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
