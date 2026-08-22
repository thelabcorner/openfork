// Pulls the per-model upstream infrastructure providers that OpenRouter can
// route a model to, so the model selector can show "who serves this model and
// at what price/uptime" and let the user pin one. The renderer calls the local
// authenticated server proxy for the public OpenRouter endpoint; this module
// owns only the in-memory + localStorage cache and in-flight dedup, and never
// blocks model selection on fetch failure.
//
// Response shape (verified live): `{ data: { ..., endpoints: [...] } }` where
// each endpoint carries `provider_name`, `tag` (e.g. "novita/fp8"), string
// `pricing.{prompt,completion,input_cache_read}` and `uptime_last_30m`. The
// model id in the URL must keep its slashes UNencoded or OpenRouter 404s.

export type OpenRouterEndpoint = {
  providerName: string
  tag: string
  provider: string
  pricing: { prompt: number; completion: number; cacheRead: number }
  uptime: number | undefined
  telemetry?: {
    cacheHitPercent: number
    throughputTps?: number
  }
}

type CacheEntry = { version: number; fetchedAt: number; endpoints: OpenRouterEndpoint[] }

const CACHE_TTL_MS = 60 * 60 * 1000

// Bump the key whenever the stored payload's units/schema change so stale
// localStorage entries can't be replayed. v4 invalidates v3 entries that were
// written by pre-normalization builds holding per-token prices.
const CACHE_VERSION = 1

const memoryCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<OpenRouterEndpoint[] | undefined>>()
const pendingWrites = new Map<string, CacheEntry>()
let persistHandle: number | ReturnType<typeof setTimeout> | undefined

const cacheKey = (id: string) => `opencode.openrouter-endpoints.v4.${id}`

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
    typeof requestIdleCallback === "function"
      ? requestIdleCallback(flush, { timeout: 1_000 })
      : setTimeout(flush, 100)
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
        if (endpoints.length === 0 && cached) return cached.endpoints
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
