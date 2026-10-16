/**
 * Bounded, allocation-free on observation, lifetime latency histogram.
 * No tool arguments, paths, session IDs or per-invocation telemetry retained.
 * Quantiles are upper bucket bounds (approximately +20% max overestimate),
 * not exact percentiles; min/max are direct observations.
 */
const BOUNDS: number[] = []
for (let upper = 0.01; upper < 300_000; upper *= 1.2) BOUNDS.push(upper)

export interface LatencySnapshot {
  readonly count: number
  readonly meanMs?: number
  readonly p50UpperMs?: number
  readonly p95UpperMs?: number
  readonly p99UpperMs?: number
  readonly maxMs?: number
}

export function createLatencyHistogram() {
  const bins = new Uint32Array(BOUNDS.length + 1)
  let count = 0
  let sum = 0
  let max = 0
  function observe(elapsedMs: number) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return
    // Lower-bound lookup is O(log bucket count), fixed memory and no
    // chronological sample accumulation even over years of uptime.
    let lo = 0
    let hi = BOUNDS.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (elapsedMs <= BOUNDS[mid]!) hi = mid
      else lo = mid + 1
    }
    bins[lo]++
    count++
    sum += elapsedMs
    max = Math.max(max, elapsedMs)
  }
  function snapshot(): LatencySnapshot {
    if (count === 0) return { count: 0 }
    const percentile = (q: number) => {
      const target = Math.ceil(count * q)
      let cumulative = 0
      for (let index = 0; index < bins.length; index++) {
        cumulative += bins[index]!
        if (cumulative >= target) return BOUNDS[index] ?? max
      }
      return max
    }
    const round = (value: number) => Math.round(value * 1_000) / 1_000
    return Object.freeze({
      count,
      meanMs: round(sum / count),
      p50UpperMs: round(percentile(0.50)),
      p95UpperMs: round(percentile(0.95)),
      p99UpperMs: round(percentile(0.99)),
      maxMs: round(max),
    })
  }
  return { observe, snapshot }
}
