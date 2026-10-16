import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"

export type PerformanceRow = {
  providerID: string
  modelID?: string
  generations: number
  measuredGenerations: number
  generationMs: number
  wallRecords: number
  wallMs: number
  input: number
  cacheRead: number
  output: number
  reasoning: number
}

type Totals = Pick<PerformanceRow, "generations" | "measuredGenerations" | "generationMs" | "wallRecords" | "wallMs" | "input" | "cacheRead" | "output" | "reasoning">
export type PerformanceScope = Totals & { covered: boolean }

const empty = (): Totals => ({ generations: 0, measuredGenerations: 0, generationMs: 0, wallRecords: 0, wallMs: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0 })
const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 0
const merge = (t: Totals, r: Totals) => {
  t.generations += positive(r.generations)
  t.measuredGenerations += positive(r.measuredGenerations)
  t.generationMs += positive(r.generationMs)
  t.wallRecords += positive(r.wallRecords)
  t.wallMs += positive(r.wallMs)
  t.input += positive(r.input)
  t.cacheRead += positive(r.cacheRead)
  t.output += positive(r.output)
  t.reasoning += positive(r.reasoning)
  return t
}

export function performanceProviders(summary: UsageSummaryResponse): PerformanceRow[] {
  return summary.providers.map((p) => ({
    providerID: p.providerID,
    generations: p.messages,
    measuredGenerations: p.generationRecords,
    generationMs: p.generationMs,
    wallRecords: p.durationRecords,
    wallMs: p.durationMs,
    input: p.tokens.input,
    cacheRead: p.tokens.cacheRead,
    output: p.tokens.output,
    reasoning: p.tokens.reasoning,
  }))
}

/** Variants are distinct settlement rows; combine only when provider and model identity match. */
export function performanceModels(summary: UsageSummaryResponse): PerformanceRow[] {
  const byKey = new Map<string, PerformanceRow>()
  for (const row of summary.models) {
    const key = JSON.stringify([row.providerID, row.modelID])
    let target = byKey.get(key)
    if (!target) {
      target = { ...empty(), providerID: row.providerID, modelID: row.modelID }
      byKey.set(key, target)
    }
    merge(target, {
      generations: row.messages,
      measuredGenerations: row.generationRecords,
      generationMs: row.generationMs,
      wallRecords: row.durationRecords,
      wallMs: row.durationMs,
      input: row.tokens.input,
      cacheRead: row.tokens.cacheRead,
      output: row.tokens.output,
      reasoning: row.tokens.reasoning,
    })
  }
  return [...byKey.values()]
}

/**
 * Never promote an unmeasured 0 ms interval to a fast timing. Expose a separate
 * observed denominator for every value; older usage may have zero coverage.
 */
export function performanceScope(rows: readonly PerformanceRow[]): PerformanceScope {
  const result = rows.reduce(merge, empty())
  return { ...result, covered: result.measuredGenerations > 0 }
}

export function averageMeasured(ms: number, samples: number): number | undefined {
  return Number.isFinite(ms) && Number.isFinite(samples) && samples > 0 && ms >= 0
    ? ms / samples
    : undefined
}

export function outputThroughput(row: PerformanceRow): number | undefined {
  return row.generationMs > 0 && row.measuredGenerations > 0
    ? (positive(row.output) + positive(row.reasoning)) * 1000 / row.generationMs
    : undefined
}
