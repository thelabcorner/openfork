// Defensive adapter for OpenRouter's undocumented frontend telemetry APIs.
// Uses endpoint UUID (not providerSlug) as the canonical identity because
// providerSlug is not unique (e.g. NovitaAI / Novita Fast share `novita`).

export type OpenRouterTelemetry = {
  endpointId: string
  providerName: string
  providerSlug: string
  // effective-pricing returns 0..1 ratios; display as 0..100 %
  cacheHitPercent: number
  // throughput-comparison latest point for standard endpoint
  throughputTps?: number
}

const ORIGIN = "https://openrouter.ai"

function normalizeSeriesEndpointId(key: string): string {
  const index = key.indexOf("::")
  return index === -1 ? key : key.slice(0, index)
}

export async function resolvePermaslug(modelId: string, variant = "standard"): Promise<string> {
  const slash = modelId.indexOf("/")
  if (slash <= 0) throw new Error(`Invalid OpenRouter model id: ${modelId}`)
  const author = modelId.slice(0, slash)
  const url = `${ORIGIN}/api/frontend/v1/author-models?authorSlug=${encodeURIComponent(author)}`
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`author-models failed: ${res.status}`)
  const payload = (await res.json()) as {
    data: {
      models: Array<{
        slug: string
        permaslug: string
        endpoint?: { variant?: string }
      }>
    }
  }
  const exact = payload.data.models.find(
    (m) => m.slug === modelId && m.endpoint?.variant === variant,
  )
  if (exact?.permaslug) return exact.permaslug
  const fallback = payload.data.models.find((m) => m.slug === modelId)
  if (fallback?.permaslug) return fallback.permaslug
  throw new Error(`Could not resolve permaslug for ${modelId}`)
}

export async function fetchTelemetry(
  modelId: string,
  timeRange: "1w" | "3d" = "1w",
  sdkClient?: { experimental?: { openrouterTelemetry?: { get: (input: unknown, opts?: unknown) => Promise<{ data?: Array<{ endpointId: string; providerName: string; providerSlug: string; cacheHitPercent: number; throughputTps?: number }> }> } } },
): Promise<OpenRouterTelemetry[]> {
  try {
    if (sdkClient?.experimental?.openrouterTelemetry?.get) {
      const result = await sdkClient.experimental.openrouterTelemetry.get({ model: modelId, timeRange }, { throwOnError: false }).catch((e: unknown) => {
        console.warn("[telemetry] SDK endpoint failed for", modelId, e)
        throw e
      })
      const payload = (result as { data?: Array<{ endpointId: string; providerName: string; providerSlug: string; cacheHitPercent: number; throughputTps?: number }> } | Array<{ endpointId: string; providerName: string; providerSlug: string; cacheHitPercent: number; throughputTps?: number }>)
      return Array.isArray(payload) ? payload : (payload.data ?? [])
    }
    // Fallback: direct proxy URL via server proxy endpoint
    const res = await fetch(`/experimental/openrouter-telemetry?model=${encodeURIComponent(modelId)}&timeRange=${encodeURIComponent(timeRange)}`, { headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error(`telemetry proxy failed: ${res.status}`)
    const payload = (await res.json()) as Array<{ endpointId: string; providerName: string; providerSlug: string; cacheHitPercent: number; throughputTps?: number }>
    return payload
  } catch (e) {
    console.warn("[openrouter-telemetry] fetch failed for", modelId, e)
    return []
  }
}
