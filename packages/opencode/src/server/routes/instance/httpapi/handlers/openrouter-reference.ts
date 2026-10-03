import { Effect, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import {
  OpenRouterEndpointsQuery,
  OpenRouterReferenceApi,
  OpenRouterTelemetryQuery,
} from "../groups/openrouter-reference"

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_MAX_MODELS = 2_048
const TELEMETRY_CACHE_MAX_KEYS = 512

// OpenRouter's model endpoint API requires slashes between author/model path
// segments to remain path separators. Encode each segment independently so
// query/hash characters cannot escape into the URL while slashes stay intact.
const endpointPath = (model: string) => model.split("/").map(encodeURIComponent).join("/")

// Mirrors the renderer's defensive parser. OpenRouter returns
// { data: { endpoints: [] } }; malformed rows are skipped and numeric strings
// are normalized once at this transport boundary.
function parseOpenRouterEndpoints(payload: unknown) {
  const rows = (payload as { data?: { endpoints?: unknown } } | null)?.data?.endpoints
  if (!Array.isArray(rows)) return []
  const num = (value: unknown) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined
    if (typeof value === "string") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return undefined
  }
  const result: Array<{
    providerName: string
    tag: string
    provider: string
    pricing: { prompt: number; completion: number; cacheRead: number }
    uptime?: number
    quantization?: string
    contextLength?: number
    maxCompletionTokens?: number
    maxPromptTokens?: number
    supportedParameters?: string[]
    supportsImplicitCaching?: boolean
    latencyP50?: number
    throughputP50?: number
    uptime5m?: number
    uptime1d?: number
    status?: number
  }> = []

  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const item = row as {
      provider_name?: unknown
      tag?: unknown
      pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown }
      uptime_last_30m?: unknown
      uptime_last_5m?: unknown
      uptime_last_1d?: unknown
      quantization?: unknown
      context_length?: unknown
      max_completion_tokens?: unknown
      max_prompt_tokens?: unknown
      supported_parameters?: unknown
      supports_implicit_caching?: unknown
      latency_last_30m?: { p50?: unknown }
      throughput_last_30m?: { p50?: unknown }
      status?: unknown
    }
    const tag = typeof item.tag === "string" ? item.tag : undefined
    if (!tag) continue

    const uptime = num(item.uptime_last_30m)
    const uptime5m = num(item.uptime_last_5m)
    const uptime1d = num(item.uptime_last_1d)
    const contextLength = num(item.context_length)
    const maxCompletionTokens = num(item.max_completion_tokens)
    const maxPromptTokens = num(item.max_prompt_tokens)
    const latencyP50 = num(item.latency_last_30m?.p50)
    const throughputP50 = num(item.throughput_last_30m?.p50)
    const status = num(item.status)
    const supportedParameters = Array.isArray(item.supported_parameters)
      ? item.supported_parameters.filter((value): value is string => typeof value === "string")
      : undefined
    const perMillion = (value: unknown) => (num(value) ?? 0) * 1_000_000

    result.push({
      providerName: typeof item.provider_name === "string" ? item.provider_name : tag,
      tag,
      provider: tag.split("/")[0],
      pricing: {
        prompt: perMillion(item.pricing?.prompt),
        completion: perMillion(item.pricing?.completion),
        cacheRead: perMillion(item.pricing?.input_cache_read),
      },
      ...(uptime === undefined ? {} : { uptime }),
      ...(typeof item.quantization === "string" && item.quantization ? { quantization: item.quantization } : {}),
      ...(contextLength === undefined ? {} : { contextLength }),
      ...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
      ...(maxPromptTokens === undefined ? {} : { maxPromptTokens }),
      ...(supportedParameters === undefined ? {} : { supportedParameters }),
      ...(typeof item.supports_implicit_caching === "boolean"
        ? { supportsImplicitCaching: item.supports_implicit_caching }
        : {}),
      ...(latencyP50 === undefined ? {} : { latencyP50 }),
      ...(throughputP50 === undefined ? {} : { throughputP50 }),
      ...(uptime5m === undefined ? {} : { uptime5m }),
      ...(uptime1d === undefined ? {} : { uptime1d }),
      ...(status === undefined ? {} : { status }),
    })
  }

  return result
}

/**
 * Tier-0 OpenRouter reference-data proxy.
 *
 * The renderer owns the persistent 24h warm policy; this process cache protects
 * the upstream endpoint from duplicate browser/PWA/renderers and coalesces
 * same-model requests while preserving the existing unified SDK operation.
 */
export const openRouterReferenceHandlers = HttpApiBuilder.group(
  OpenRouterReferenceApi,
  "openrouterReference",
  (handlers) =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      // The renderer already caps its daily sweep, but desktop + paired PWA (or
      // multiple windows) can warm concurrently. This process-wide route owner
      // is the final admission boundary before OpenRouter, so cap aggregate
      // upstream pressure here as well.
      const upstreamAdmission = Semaphore.makeUnsafe(4)
      const cache = new Map<string, { fetchedAt: number; endpoints: ReturnType<typeof parseOpenRouterEndpoints> }>()
      const inflight = new Map<
        string,
        Effect.Effect<ReturnType<typeof parseOpenRouterEndpoints>, HttpApiError.InternalServerError>
      >()
      type Telemetry = Array<{
        endpointId: string
        providerName: string
        providerSlug: string
        cacheHitPercent: number
        throughputTps?: number
      }>
      const telemetryCache = new Map<string, { fetchedAt: number; value: Telemetry }>()
      const telemetryInflight = new Map<string, Effect.Effect<Telemetry, never>>()

      const remember = (model: string, endpoints: ReturnType<typeof parseOpenRouterEndpoints>) => {
        if (!cache.has(model) && cache.size >= CACHE_MAX_MODELS) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(model, { fetchedAt: Date.now(), endpoints })
      }

      const fetchUpstream = Effect.fn("OpenRouterReferenceHttpApi.fetch")(function* (model: string) {
        return yield* upstreamAdmission.withPermits(1)(
          Effect.gen(function* () {
            const request = HttpClientRequest.get(
              `https://openrouter.ai/api/v1/models/${endpointPath(model)}/endpoints`,
            ).pipe(HttpClientRequest.accept("application/json"))
            const response = yield* http.execute(request).pipe(
              Effect.timeoutOrElse({
                duration: "15 seconds",
                orElse: () => Effect.fail(new HttpApiError.InternalServerError({})),
              }),
              Effect.mapError(() => new HttpApiError.InternalServerError({})),
            )
            // Persisted recents/favorites/pins can legitimately outlive an
            // OpenRouter model. Treat upstream 404 as authoritative "no
            // endpoints" instead of poisoning the background warmer's outage
            // streak. Other non-2xx statuses (notably 429/5xx) still fail so
            // renderer stale-if-error + backoff semantics remain intact.
            if (response.status === 404) return []
            if (response.status < 200 || response.status >= 300) {
              return yield* Effect.fail(new HttpApiError.InternalServerError({}))
            }
            const body = yield* response.json.pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
            return parseOpenRouterEndpoints(body)
          }),
        )
      })

      const endpoints = Effect.fn("OpenRouterReferenceHttpApi.endpoints")(function* (ctx: {
        query: typeof OpenRouterEndpointsQuery.Type
      }) {
        const model = ctx.query.model
        const cached = cache.get(model)
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.endpoints

        const running = inflight.get(model)
        if (running) return yield* running

        // Effect.cached is the single-flight primitive: every request that
        // arrives while this model refreshes observes the same execution.
        // Do not return stale process data as HTTP 200 on upstream failure: the
        // renderer intentionally owns stale-if-error and must retain the old
        // fetchedAt. Restamping stale rows here would suppress its daily retry.
        const shared = yield* Effect.cached(
          fetchUpstream(model).pipe(
            Effect.tap((value) => Effect.sync(() => remember(model, value))),
          ),
        )
        inflight.set(model, shared)
        return yield* shared.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (inflight.get(model) === shared) inflight.delete(model)
            }),
          ),
        )
      })

      const fetchTelemetry = Effect.fn("OpenRouterReferenceHttpApi.fetchTelemetry")(function* (
        rawModelId: string,
        timeRange: "1w" | "3d",
      ) {
        // Best-effort enrichment — unpublished/alias models frequently have no
        // frontend telemetry. Return [] rather than making a decorative metric
        // capable of failing the provider picker.
        const modelId = rawModelId.replace(/^~+/, "")
        const slash = modelId.indexOf("/")
        if (slash <= 0) return [] satisfies Telemetry
        const author = modelId.slice(0, slash)

        const fetchJson = (url: string) =>
          upstreamAdmission.withPermits(1)(
            http
              .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.accept("application/json")))
              .pipe(
                Effect.timeout("10 seconds"),
                Effect.catch(() => Effect.succeed(null)),
                Effect.flatMap((response) => {
                  if (!response || response.status < 200 || response.status >= 300) return Effect.succeed(null)
                  return response.json.pipe(Effect.catch(() => Effect.succeed(null)))
                }),
              ),
          )

        const permaslugBody = (yield* fetchJson(
          `https://openrouter.ai/api/frontend/v1/author-models?authorSlug=${encodeURIComponent(author)}`,
        )) as { data?: { models?: Array<{ slug?: string; permaslug?: string; endpoint?: { variant?: string } }> } } | null
        if (!permaslugBody) return [] satisfies Telemetry
        const models = permaslugBody.data?.models ?? []
        const permaslug =
          models.find((model) => (model.slug === modelId || model.slug === rawModelId) && model.endpoint?.variant === "standard")
            ?.permaslug ?? models.find((model) => model.slug === modelId || model.slug === rawModelId)?.permaslug
        if (!permaslug) return [] satisfies Telemetry

        const pricingBody = (yield* fetchJson(
          `https://openrouter.ai/api/frontend/v1/stats/effective-pricing?permaslug=${encodeURIComponent(permaslug)}&shape=v7&variant=standard`,
        )) as {
          data?: {
            providerSummaries?: Array<{
              endpointId?: string
              providerName?: string
              providerSlug?: string
              cacheHitRate?: number
            }>
          }
        } | null
        if (!pricingBody) return [] satisfies Telemetry
        const summaries = pricingBody.data?.providerSummaries ?? []
        const allowedIds = new Set(summaries.map((summary) => summary.endpointId).filter((id): id is string => !!id))

        const throughputLatest = new Map<string, number>()
        const throughputBody = (yield* fetchJson(
          `https://openrouter.ai/api/frontend/v1/stats/throughput-comparison?permaslug=${encodeURIComponent(permaslug)}&timeRange=${encodeURIComponent(timeRange)}&variant=standard`,
        )) as { data?: Array<{ x?: string; y?: Record<string, number> }> } | null
        if (throughputBody?.data) {
          const today = new Date().toISOString().slice(0, 10)
          for (const point of throughputBody.data) {
            const bucket = point.x?.slice(0, 10)
            if (bucket && bucket >= today) continue
            for (const [rawKey, value] of Object.entries(point.y ?? {})) {
              const endpointId = rawKey.split("::", 1)[0]
              if (allowedIds.has(endpointId) && typeof value === "number") throughputLatest.set(endpointId, value)
            }
          }
        }

        return summaries.flatMap((summary) => {
          const endpointId = summary.endpointId
          if (!endpointId) return []
          return [{
            endpointId,
            providerName: summary.providerName ?? endpointId,
            providerSlug: summary.providerSlug ?? endpointId,
            cacheHitPercent: Math.round((summary.cacheHitRate ?? 0) * 10_000) / 100,
            ...(throughputLatest.has(endpointId)
              ? { throughputTps: Math.round(throughputLatest.get(endpointId)! * 100) / 100 }
              : {}),
          }]
        })
      })

      const telemetry = Effect.fn("OpenRouterReferenceHttpApi.telemetry")(function* (ctx: {
        query: typeof OpenRouterTelemetryQuery.Type
      }) {
        const timeRange = ctx.query.timeRange ?? "1w"
        const key = `${ctx.query.model}\0${timeRange}`
        const cached = telemetryCache.get(key)
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value

        const running = telemetryInflight.get(key)
        if (running) return yield* running

        const shared = yield* Effect.cached(
          fetchTelemetry(ctx.query.model, timeRange).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                if (!telemetryCache.has(key) && telemetryCache.size >= TELEMETRY_CACHE_MAX_KEYS) {
                  const oldest = telemetryCache.keys().next().value
                  if (oldest !== undefined) telemetryCache.delete(oldest)
                }
                telemetryCache.set(key, { fetchedAt: Date.now(), value })
              }),
            ),
          ),
        )
        telemetryInflight.set(key, shared)
        return yield* shared.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (telemetryInflight.get(key) === shared) telemetryInflight.delete(key)
            }),
          ),
        )
      })

      return handlers.handle("endpoints", endpoints).handle("openrouterTelemetry", telemetry)
    }),
)
