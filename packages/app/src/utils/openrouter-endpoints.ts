// Pulls the per-model upstream infrastructure providers that OpenRouter can
// route a model to, so the model selector can show "who serves this model and
// at what price/uptime" and let the user pin one. The renderer calls the local
// authenticated server proxy for the public OpenRouter endpoint; this module
// owns only the in-memory + localStorage cache and in-flight dedup, and never
// blocks model selection on fetch failure.
//
// Response shape (verified against OpenRouter's endpoint API):
// `{ data: { ..., endpoints: [...] } }`. Besides provider/tag/pricing it carries
// per-endpoint quantization, token limits, supported parameters, implicit-cache
// support, 30m latency/throughput P50, and 5m/30m/1d uptime. The model id in the
// URL must keep its slashes UNencoded or OpenRouter 404s.

export type OpenRouterEndpoint = {
  providerName: string
  tag: string
  provider: string
  pricing: { prompt: number; completion: number; cacheRead: number }
  uptime: number | undefined
  /** OpenRouter's endpoint-level serving precision, e.g. fp16/fp8/int8/fp4. */
  quantization?: string
  contextLength?: number
  maxCompletionTokens?: number
  maxPromptTokens?: number
  supportedParameters?: string[]
  supportsImplicitCaching?: boolean
  /** P50 endpoint metrics from the public endpoints API (30 minute window). */
  latencyP50?: number
  throughputP50?: number
  uptime5m?: number
  uptime1d?: number
  status?: number
  telemetry?: {
    cacheHitPercent: number
    throughputTps?: number
  }
}

export type OpenRouterEndpointWire = {
  providerName: string
  tag: string
  provider: string
  pricing: { prompt: number | string; completion: number | string; cacheRead: number | string }
  uptime?: number | string
  quantization?: string
  contextLength?: number | string
  maxCompletionTokens?: number | string
  maxPromptTokens?: number | string
  supportedParameters?: readonly string[]
  supportsImplicitCaching?: boolean
  latencyP50?: number | string
  throughputP50?: number | string
  uptime5m?: number | string
  uptime1d?: number | string
  status?: number | string
}

type CacheEntry = { version: number; fetchedAt: number; endpoints: OpenRouterEndpoint[] }

const CACHE_TTL_MS = 60 * 60 * 1000
const WARM_TTL_MS = 24 * 60 * 60 * 1000
const WARM_CONCURRENCY = 3
const WARM_SCAN_BATCH = 8
const WARM_FAILURE_LIMIT = 3
const WARM_FAILURE_BACKOFF_MS = 5 * 60 * 1000

// Bump both the payload version and storage namespace whenever the persisted
// endpoint schema changes. v5 adds endpoint capabilities/quantization and the
// public 30m performance fields, so v4 rows should be refreshed immediately.
const CACHE_VERSION = 2

const memoryCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<OpenRouterEndpoint[] | undefined>>()
const pendingWrites = new Map<string, CacheEntry>()
const warmQueued = new Set<string>()
const warmQueue: Array<{
  modelID: string
  fetchEndpoints: (model: string) => Promise<OpenRouterEndpoint[]>
  ttlMs: number
}> = []
let warmActive = 0
let warmScheduled = false
let warmFailureStreak = 0
let warmRetryAfter = 0
let persistHandle: number | ReturnType<typeof setTimeout> | undefined

const cacheKey = (id: string) => `opencode.openrouter-endpoints.v5.${id}`

export function normalizeOpenRouterEndpoints(entries: readonly OpenRouterEndpointWire[]): OpenRouterEndpoint[] {
  return entries.map((entry) => ({
    providerName: entry.providerName,
    tag: entry.tag,
    provider: entry.provider,
    pricing: {
      // The local Tier-0 proxy is the normalization boundary and already
      // converts OpenRouter's per-token wire prices to $/M. Renderer consumers
      // only coerce defensive string payloads; never infer units from magnitude
      // or ultra-cheap endpoint prices can be multiplied twice.
      prompt: Number(entry.pricing.prompt),
      completion: Number(entry.pricing.completion),
      cacheRead: Number(entry.pricing.cacheRead),
    },
    uptime: entry.uptime === undefined ? undefined : Number(entry.uptime),
    quantization: entry.quantization,
    contextLength: entry.contextLength === undefined ? undefined : Number(entry.contextLength),
    maxCompletionTokens: entry.maxCompletionTokens === undefined ? undefined : Number(entry.maxCompletionTokens),
    maxPromptTokens: entry.maxPromptTokens === undefined ? undefined : Number(entry.maxPromptTokens),
    supportedParameters: entry.supportedParameters ? [...entry.supportedParameters] : undefined,
    supportsImplicitCaching: entry.supportsImplicitCaching,
    latencyP50: entry.latencyP50 === undefined ? undefined : Number(entry.latencyP50),
    throughputP50: entry.throughputP50 === undefined ? undefined : Number(entry.throughputP50),
    uptime5m: entry.uptime5m === undefined ? undefined : Number(entry.uptime5m),
    uptime1d: entry.uptime1d === undefined ? undefined : Number(entry.uptime1d),
    status: entry.status === undefined ? undefined : Number(entry.status),
  }))
}

function readCache(id: string): CacheEntry | undefined {
  const mem = memoryCache.get(id)
  if (mem) return mem
  if (typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(cacheKey(id))
    if (!raw) return undefined
    const entry = JSON.parse(raw) as CacheEntry
    if (entry.version !== CACHE_VERSION) return undefined
    memoryCache.set(id, entry)
    return entry
  } catch {
    return undefined
  }
}

function writeCache(id: string, entry: CacheEntry) {
  memoryCache.set(id, entry)
  if (typeof localStorage === "undefined") return
  pendingWrites.set(cacheKey(id), entry)
  schedulePersist()
}

/** Synchronous stale-ok read for latency-sensitive provider submenus. */
export function peekOpenRouterEndpoints(modelID: string): OpenRouterEndpoint[] | undefined {
  return readCache(modelID)?.endpoints
}

function scheduleWarmPump() {
  if (warmScheduled || warmQueue.length === 0 || warmActive >= WARM_CONCURRENCY) return
  warmScheduled = true
  const pump = () => {
    warmScheduled = false
    let scanned = 0
    while (warmActive < WARM_CONCURRENCY && warmQueue.length > 0 && scanned < WARM_SCAN_BATCH) {
      const job = warmQueue.shift()!
      scanned++
      const cached = readCache(job.modelID)
      if (cached && Date.now() - cached.fetchedAt < job.ttlMs) {
        warmQueued.delete(job.modelID)
        continue
      }
      // A foreground hover/open that got here first already owns the same-model
      // refresh. Do not spend one of the bounded background slots waiting on it.
      if (inflight.has(job.modelID)) {
        warmQueued.delete(job.modelID)
        continue
      }
      warmActive++
      const guardedFetch = async (modelID: string) => {
        try {
          const endpoints = await job.fetchEndpoints(modelID)
          warmFailureStreak = 0
          warmRetryAfter = 0
          return endpoints
        } catch (error) {
          warmFailureStreak++
          if (warmFailureStreak >= WARM_FAILURE_LIMIT) {
            // An outage should cost a few probes, not one timeout per visible
            // model. Drop only the queued background sweep; foreground fetches
            // remain available. Back off before accepting another sweep so a
            // reactive provider/catalog update cannot immediately recreate the
            // timeout fan-out while OpenRouter or the local proxy is unhealthy.
            for (const queued of warmQueue) warmQueued.delete(queued.modelID)
            warmQueue.length = 0
            warmFailureStreak = 0
            warmRetryAfter = Date.now() + WARM_FAILURE_BACKOFF_MS
          }
          throw error
        }
      }
      void getOpenRouterEndpoints(job.modelID, guardedFetch).finally(() => {
        warmActive--
        warmQueued.delete(job.modelID)
        scheduleWarmPump()
      })
    }
    // Cache admission itself touches synchronous localStorage on a cold renderer.
    // Bound those reads per idle slice just like network concurrency, otherwise a
    // several-hundred-model catalog can still produce a long task before any HTTP
    // request starts.
    if (warmQueue.length > 0 && warmActive < WARM_CONCURRENCY) scheduleWarmPump()
  }
  if (typeof requestIdleCallback === "function") requestIdleCallback(pump, { timeout: 1_500 })
  else setTimeout(pump, 100)
}

/**
 * Low-priority daily warmer. IDs are consumed in caller-supplied priority
 * order and coalesced module-wide, so several model-aware surfaces cannot
 * create duplicate OpenRouter fan-out.
 */
export function warmOpenRouterEndpoints(
  modelIDs: readonly string[],
  fetchEndpoints: (model: string) => Promise<OpenRouterEndpoint[]>,
  options: { ttlMs?: number } = {},
) {
  if (Date.now() < warmRetryAfter) return
  const ttlMs = options.ttlMs ?? WARM_TTL_MS
  const seen = new Set<string>()
  for (const modelID of modelIDs) {
    if (!modelID || seen.has(modelID)) continue
    seen.add(modelID)
    // Reactive recents/favorites/provider updates can invoke the warmer many
    // times per day. Once a model has been admitted into the in-memory index,
    // skip it here in O(1) rather than enqueueing hundreds of fresh rows only
    // to rediscover their TTL through synchronous localStorage in idle slices.
    const cached = memoryCache.get(modelID)
    if (cached && Date.now() - cached.fetchedAt < ttlMs) continue
    if (warmQueued.has(modelID) || inflight.has(modelID)) continue
    warmQueued.add(modelID)
    warmQueue.push({ modelID, fetchEndpoints, ttlMs })
  }
  scheduleWarmPump()
}

// localStorage serialization and writes are synchronous. Keep them out of the
// request completion path and commit at most one model per idle slice so a ring
// of OpenRouter responses cannot interrupt hover/scroll frames.
function schedulePersist() {
  if (persistHandle !== undefined || pendingWrites.size === 0) return
  const flush = () => {
    persistHandle = undefined
    const next = pendingWrites.entries().next()
    if (next.done) return
    pendingWrites.delete(next.value[0])
    try {
      localStorage.setItem(next.value[0], JSON.stringify(next.value[1]))
    } catch {
      // best-effort cache only
    }
    schedulePersist()
  }
  persistHandle =
    typeof requestIdleCallback === "function" ? requestIdleCallback(flush, { timeout: 1_000 }) : setTimeout(flush, 100)
}

// Returns the endpoint list for a model, `[]` when the model has no upstream
// providers to show (e.g. a dynamic-router/alias model), or `undefined` when
// the fetch itself failed — so callers can tell "nothing to pin" apart from
// "couldn't reach OpenRouter".
//
// The actual HTTP request is delegated to `fetchEndpoints`, which the caller
// wires to the local opencode server's `/experimental/openrouter-endpoints`
// proxy (same-origin, so it avoids the renderer's cross-origin fetch failing
// under CORS). This module only owns the cache + in-flight dedup.
export async function getOpenRouterEndpoints(
  modelID: string,
  fetchEndpoints: (model: string) => Promise<OpenRouterEndpoint[]>,
): Promise<OpenRouterEndpoint[] | undefined> {
  const cached = readCache(modelID)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.endpoints
  if (!inflight.has(modelID)) {
    const promise = fetchEndpoints(modelID)
      .then((endpoints) => {
        // `[]` is a successful authoritative response (the model currently has
        // no pin-able upstreams), not a transport failure. Persist it so removed
        // providers do not survive forever in stale cache. Only the catch path
        // below falls back to the previous value.
        writeCache(modelID, { version: CACHE_VERSION, fetchedAt: Date.now(), endpoints })
        return endpoints
      })
      .catch((error) => {
        // Best-effort: never block model selection on a fetch failure, but log
        // the actual cause (with the id) so a silent "no providers" is diagnosable.
        console.warn(`[openrouter-endpoints] fetch failed for ${modelID}`, error)
        return cached?.endpoints
      })
      .finally(() => {
        inflight.delete(modelID)
      })
    inflight.set(modelID, promise)
  }
  const result = await inflight.get(modelID)
  return result
}
