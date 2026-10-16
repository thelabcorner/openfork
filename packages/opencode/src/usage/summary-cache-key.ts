/**
 * Summary caches may approximate a rolling, near-now range within the TTL.
 * Fixed historical windows must retain their exact boundaries: equal-length
 * ranges at different dates are not equivalent and must never share a result.
 */
export function usageSummaryServerCacheKey(input: {
  database: string
  since: number
  until: number
  resolution: string
  projectID?: string | null
  now: number
  ttlMs: number
}): string {
  const nearNow = input.until <= input.now + 5_000 && input.until >= input.now - input.ttlMs
  const bounds = nearNow
    ? ["rolling", input.since === 0 ? "all" : input.until - input.since]
    : ["fixed", input.since, input.until]
  return JSON.stringify([input.database, input.resolution, input.projectID ?? null, bounds])
}
