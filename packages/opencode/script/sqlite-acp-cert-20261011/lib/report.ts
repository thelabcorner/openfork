/// <reference types="bun" />
// Metric aggregation helpers. All latency inputs are milliseconds.

export type Summary = {
  count: number
  min: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  const weight = position - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

export function summarize(values: readonly number[]): Summary | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    count: sorted.length,
    min: sorted[0]!,
    mean: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1]!,
  }
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function roundSummary(summary: Summary | undefined): Summary | undefined {
  if (!summary) return undefined
  return {
    count: summary.count,
    min: round(summary.min),
    mean: round(summary.mean),
    p50: round(summary.p50),
    p95: round(summary.p95),
    p99: round(summary.p99),
    max: round(summary.max),
  }
}

export function errorRecord(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack?.slice(0, 2000) }
  return { message: String(error) }
}

export function nowIso(): string {
  return new Date().toISOString()
}
