import type { OpenRouterEndpoint } from "./openrouter-endpoints"

export type OpenRouterEndpointRank = {
  endpoint: OpenRouterEndpoint
  /** 0..100 equal-weight rank fusion across every globally available metric. */
  score: number
  fastest: boolean
  cheapest: boolean
  bestCache: boolean
}

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value)

export const endpointThroughput = (endpoint: OpenRouterEndpoint) =>
  // Prefer OpenRouter's official endpoint-local 30m P50: it is the freshest,
  // apples-to-apples measure for choosing an upstream right now. The older
  // frontend telemetry series remains a fallback for endpoints whose public
  // record has not populated throughput yet.
  finite(endpoint.throughputP50)
    ? endpoint.throughputP50
    : finite(endpoint.telemetry?.throughputTps)
      ? endpoint.telemetry!.throughputTps
      : undefined

export const endpointHeadlinePrice = (endpoint: OpenRouterEndpoint) =>
  Math.max(0, endpoint.pricing.prompt) + Math.max(0, endpoint.pricing.completion)

export const endpointCacheHit = (endpoint: OpenRouterEndpoint) => {
  const value = endpoint.telemetry?.cacheHitPercent
  return finite(value) ? Math.max(0, Math.min(100, value)) : undefined
}

type MetricDirection = "asc" | "desc"

/**
 * Convert one metric into a scale-free 0..1 rank score. Using rank fusion
 * instead of raw-value normalization is deliberate: $/M and tok/s routinely
 * differ by orders of magnitude, and a raw weighted sum lets whichever metric
 * has the wildest range dominate. Ties receive the same average rank.
 *
 * A metric that is unavailable for every endpoint is omitted from the overall
 * score. Once the metric exists for at least one endpoint, unknown rows score
 * zero for that dimension rather than being optimistically treated as median.
 */
function metricRanks(
  endpoints: OpenRouterEndpoint[],
  read: (endpoint: OpenRouterEndpoint) => number | undefined,
  direction: MetricDirection,
): Map<OpenRouterEndpoint, number> | undefined {
  const known = endpoints
    .map((endpoint) => ({ endpoint, value: read(endpoint) }))
    .filter((entry): entry is { endpoint: OpenRouterEndpoint; value: number } => finite(entry.value))

  if (known.length === 0) return undefined
  known.sort((a, b) => (direction === "asc" ? a.value - b.value : b.value - a.value))

  const result = new Map<OpenRouterEndpoint, number>()
  if (known.length === 1) {
    result.set(known[0].endpoint, 1)
    return result
  }

  let index = 0
  while (index < known.length) {
    let end = index + 1
    while (end < known.length && known[end].value === known[index].value) end++
    const averageRank = (index + (end - 1)) / 2
    const score = 1 - averageRank / (known.length - 1)
    for (let i = index; i < end; i++) result.set(known[i].endpoint, score)
    index = end
  }
  return result
}

/**
 * OpenRouter upstream "tri-sort": equal-weight rank fusion of
 *   1. highest throughput,
 *   2. lowest displayed input+output $/M,
 *   3. highest cache-hit percentage.
 *
 * This is intentionally a Pareto-ish rank aggregation rather than a
 * lexicographic sort. A provider that is second-best in all three dimensions
 * should beat one that is fastest but catastrophically expensive with poor
 * cache behavior. Uptime and stable identity are deterministic tie-breakers.
 */
export function rankOpenRouterEndpoints(endpoints: readonly OpenRouterEndpoint[]): OpenRouterEndpointRank[] {
  const list = [...endpoints]
  if (list.length === 0) return []

  const speed = metricRanks(list, endpointThroughput, "desc")
  const price = metricRanks(list, endpointHeadlinePrice, "asc")
  const cache = metricRanks(list, endpointCacheHit, "desc")
  const metrics = [speed, price, cache].filter((entry): entry is Map<OpenRouterEndpoint, number> => !!entry)

  const fastestValue = Math.max(...list.map((entry) => endpointThroughput(entry) ?? Number.NEGATIVE_INFINITY))
  const cheapestValue = Math.min(...list.map(endpointHeadlinePrice))
  const cacheValues = list.map(endpointCacheHit).filter((entry): entry is number => entry !== undefined)
  const bestCacheValue = cacheValues.length > 0 ? Math.max(...cacheValues) : undefined

  const ranked = list.map((endpoint) => {
    const score =
      metrics.length === 0
        ? 0
        : (metrics.reduce((sum, metric) => sum + (metric.get(endpoint) ?? 0), 0) / metrics.length) * 100
    const throughput = endpointThroughput(endpoint)
    const cacheHit = endpointCacheHit(endpoint)
    return {
      endpoint,
      score,
      fastest: finite(throughput) && throughput === fastestValue,
      cheapest: endpointHeadlinePrice(endpoint) === cheapestValue,
      bestCache: bestCacheValue !== undefined && cacheHit === bestCacheValue,
    }
  })

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const speedA = endpointThroughput(a.endpoint) ?? Number.NEGATIVE_INFINITY
    const speedB = endpointThroughput(b.endpoint) ?? Number.NEGATIVE_INFINITY
    if (speedA !== speedB) return speedB - speedA
    const priceA = endpointHeadlinePrice(a.endpoint)
    const priceB = endpointHeadlinePrice(b.endpoint)
    if (priceA !== priceB) return priceA - priceB
    const cacheA = endpointCacheHit(a.endpoint) ?? Number.NEGATIVE_INFINITY
    const cacheB = endpointCacheHit(b.endpoint) ?? Number.NEGATIVE_INFINITY
    if (cacheA !== cacheB) return cacheB - cacheA
    const uptimeA = a.endpoint.uptime ?? Number.NEGATIVE_INFINITY
    const uptimeB = b.endpoint.uptime ?? Number.NEGATIVE_INFINITY
    if (uptimeA !== uptimeB) return uptimeB - uptimeA
    return (
      a.endpoint.providerName.localeCompare(b.endpoint.providerName) || a.endpoint.tag.localeCompare(b.endpoint.tag)
    )
  })

  return ranked
}
