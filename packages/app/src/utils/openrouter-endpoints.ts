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
  // OpenRouter's provider.only pins by provider slug, not the quantization
  // tag — derive it by stripping any "/quantization" suffix from `tag`.
  provider: string
  pricing: { prompt: number; completion: number; cacheRead: number }
  uptime: number | undefined
}

type CacheEntry = { version: number; fetchedAt: number; endpoints: OpenRouterEndpoint[] }

const CACHE_TTL_MS = 60 * 60 * 1000

// Bump the key whenever the stored payload's units/schema change so stale
// localStorage entries can't be replayed. v4 invalidates v3 entries that were
// written by pre-normalization builds holding per-token prices.
const CACHE_VERSION = 1

const memoryCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<OpenRouterEndpoint[] | undefined>>()

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
  try {
    localStorage.setItem(cacheKey(id), JSON.stringify(entry))
  } catch {
    // best-effort cache only
  }
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
