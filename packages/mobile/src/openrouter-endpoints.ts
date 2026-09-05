/**
 * OpenRouter upstream-provider ("endpoint") data for the model selector.
 *
 * Mirrors the desktop's `utils/openrouter-endpoints.ts`: one hour cache, the
 * same localStorage key, and the same tri-state result where `[]` means "this
 * model has nothing to pin" and `undefined` means "the fetch failed". The
 * distinction matters in the UI - a model with a single upstream should not
 * show a routing affordance, but a failed fetch must say so rather than look
 * empty.
 */

export type OpenRouterEndpoint = {
  providerName: string
  tag: string
  provider: string
  pricing: { prompt: number; completion: number; cacheRead: number }
  uptime?: number
}

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_VERSION = "v1"

type CacheEntry = { at: number; endpoints: OpenRouterEndpoint[] }

/**
 * Deliberately namespaced away from the desktop's
 * `opencode.openrouter-endpoints.v4.*`. The two store different entry shapes
 * (`{at}` here, `{version, fetchedAt}` there), so were they ever served from
 * one origin they would each reject and overwrite the other's entries on every
 * read - a cache that is strictly worse than no cache. Bump the version here
 * whenever this entry shape changes.
 */
function cacheKey(modelID: string) {
  return `opencode.mobile.openrouter-endpoints.${CACHE_VERSION}.${modelID}`
}

function readCache(modelID: string): OpenRouterEndpoint[] | undefined {
  try {
    const raw = localStorage.getItem(cacheKey(modelID))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CacheEntry
    if (!parsed || typeof parsed.at !== "number" || !Array.isArray(parsed.endpoints)) return undefined
    if (Date.now() - parsed.at > CACHE_TTL_MS) return undefined
    return parsed.endpoints
  } catch {
    return undefined
  }
}

function writeCache(modelID: string, endpoints: OpenRouterEndpoint[]) {
  try {
    localStorage.setItem(cacheKey(modelID), JSON.stringify({ at: Date.now(), endpoints } satisfies CacheEntry))
  } catch {
    // Cache is an optimization; a miss just re-fetches.
  }
}

/**
 * `undefined` means the fetch failed; an empty array is a real "this model has
 * no upstreams to pin". The UI shows them differently, so they must not
 * collapse into one another.
 */
export type EndpointsFetcher = (modelID: string) => Promise<OpenRouterEndpoint[] | undefined>

/**
 * OpenRouter prices are per-token; the upstream occasionally reports them
 * already scaled. Anything that looks like a per-token rate is multiplied to
 * per-million so the price column is comparable with the catalog's.
 */
function perMillion(value: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.abs(n) > 0 && Math.abs(n) < 1e-4 ? n * 1_000_000 : n
}

/** Builds a fetcher bound to a live client. */
export function createEndpointsFetcher(client: () => { experimental?: any } | undefined): EndpointsFetcher {
  const inflight = new Map<string, Promise<OpenRouterEndpoint[] | undefined>>()

  return (modelID: string) => {
    const cached = readCache(modelID)
    if (cached) return Promise.resolve(cached)

    const existing = inflight.get(modelID)
    if (existing) return existing

    const task = (async (): Promise<OpenRouterEndpoint[] | undefined> => {
      // No client, or a server too old to expose the endpoint: nothing to pin,
      // and retrying every open would only burn requests.
      const live = client()
      if (!live?.experimental?.openrouterEndpoints) return undefined
      try {
        const response = await live.experimental.openrouterEndpoints.get({ model: modelID }, { throwOnError: true })
        const rows = (response?.data ?? []) as Record<string, any>[]
        const endpoints = rows.map((entry) => {
          const result: OpenRouterEndpoint = {
            providerName: String(entry.providerName ?? entry.provider ?? ""),
            tag: String(entry.tag ?? ""),
            provider: String(entry.provider ?? ""),
            pricing: {
              prompt: perMillion(entry.pricing?.prompt ?? 0),
              completion: perMillion(entry.pricing?.completion ?? 0),
              cacheRead: perMillion(entry.pricing?.cacheRead ?? 0),
            },
          }
          if (typeof entry.uptime === "number") result.uptime = entry.uptime
          return result
        })
        writeCache(modelID, endpoints)
        return endpoints
      } catch {
        return undefined
      }
    })().finally(() => inflight.delete(modelID))

    inflight.set(modelID, task)
    return task
  }
}

/**
 * Cheapest first, then most reliable, then alphabetical. Cheapest is the
 * useful default because upstreams for one model are otherwise
 * indistinguishable to the user - they serve identical weights.
 */
export function sortEndpoints(endpoints: readonly OpenRouterEndpoint[]): OpenRouterEndpoint[] {
  return [...endpoints].sort((a, b) => {
    const costA = a.pricing.prompt + a.pricing.completion
    const costB = b.pricing.prompt + b.pricing.completion
    if (costA !== costB) return costA - costB
    const upA = a.uptime ?? 0
    const upB = b.uptime ?? 0
    if (upA !== upB) return upB - upA
    return a.providerName.localeCompare(b.providerName)
  })
}

/**
 * Uptime tiers. OpenRouter publishes throughput and latency fields but they are
 * null for essentially every upstream, so uptime is the only trust signal that
 * is actually populated.
 */
export function uptimeTone(uptime: number): "success" | "warning" | "danger" {
  if (uptime >= 99) return "success"
  if (uptime >= 95) return "warning"
  return "danger"
}
