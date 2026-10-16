import { OxpAttributionModel as Model, type Source } from "./model"
import type { Coverage } from "./attribution"

type Contribution = { readonly totals: Model.Snapshot; readonly coverage: Coverage }
type Lane = { requestChars: number; resultChars: number }
type ToolLane = Lane & { calls: number }
type SourceLane = Lane & { requestCalls: number; resultCalls: number }

const sources = ["observed_boundary", "historical_detail", "calibrated_surrogate", "calibrated_donor"] as const
const requests = [...sources, "unavailable"] as const
const results = [...requests, "not_applicable"] as const

const requestCoverage = () => Object.fromEntries(requests.map((key) => [key, 0])) as Record<(typeof requests)[number], number>
const resultCoverage = () => Object.fromEntries(results.map((key) => [key, 0])) as Record<(typeof results)[number], number>

/**
 * Compact, additive global projection. The empirical turn model resets at each
 * activity boundary, so per-activity estimates are independent contributions.
 * Updating one activity never scans invocations belonging to another activity.
 */
export class Rollup {
  private readonly contributions = new Map<string, Contribution>()
  private readonly tools = new Map<string, ToolLane>()
  private readonly bySource = new Map<Source, SourceLane>()
  private readonly request = requestCoverage()
  private readonly result = resultCoverage()
  private invalid = 0
  private calls = 0
  private activities = 0
  private inferredTurns = 0
  private requestChars = 0
  private resultChars = 0
  private modeledTotal = 0

  update(id: string, next?: Contribution) {
    const previous = this.contributions.get(id)
    if (previous) this.accumulate(previous, -1)
    this.contributions.delete(id)
    if (!next || next.totals.calls === 0) return
    this.contributions.set(id, next)
    this.accumulate(next, 1)
  }

  private accumulate(part: Contribution, direction: 1 | -1) {
    const { totals, coverage } = part
    this.calls += direction * totals.calls
    this.activities += direction * totals.activities
    this.inferredTurns += direction * totals.inferredTurns
    this.requestChars += direction * totals.requestChars
    this.resultChars += direction * totals.resultChars
    this.modeledTotal += direction * totals.estimatedTotalTokens
    this.invalid += direction * coverage.invalidPersistedMeasurements
    for (const key of requests) this.request[key] += direction * coverage.request[key]
    for (const key of results) this.result[key] += direction * coverage.result[key]
    for (const tool of totals.byTool) {
      let lane = this.tools.get(tool.tool)
      if (!lane) {
        lane = { calls: 0, requestChars: 0, resultChars: 0 }
        this.tools.set(tool.tool, lane)
      }
      lane.calls += direction * tool.calls
      lane.requestChars += direction * tool.requestChars
      lane.resultChars += direction * tool.resultChars
      // Dynamic tool identifiers must not accumulate dead map entries.
      if (lane.calls === 0) this.tools.delete(tool.tool)
    }
    for (const source of totals.bySource) {
      let lane = this.bySource.get(source.source)
      if (!lane) {
        lane = { requestCalls: 0, resultCalls: 0, requestChars: 0, resultChars: 0 }
        this.bySource.set(source.source, lane)
      }
      lane.requestCalls += direction * source.requestCalls
      lane.resultCalls += direction * source.resultCalls
      lane.requestChars += direction * source.requestChars
      lane.resultChars += direction * source.resultChars
      if (lane.requestCalls === 0 && lane.resultCalls === 0) this.bySource.delete(source.source)
    }
  }

  snapshot(options: Model.ProjectOptions): Contribution {
    // Preserve the original regression result bit-for-bit when the global
    // history contains only one activity; repeated additions/subtractions
    // otherwise introduce a few ULPs of floating-point summation drift.
    if (this.contributions.size === 1) return this.contributions.values().next().value!
    const lane = (requestChars: number, resultChars: number) => {
      const requestTokens = requestChars / options.requestCharsPerToken
      const resultTokens = resultChars / options.resultCharsPerToken
      return {
        requestChars,
        resultChars,
        chars: requestChars + resultChars,
        requestTokens,
        resultTokens,
        tokens: requestTokens + resultTokens,
      }
    }
    const direct = lane(this.requestChars, this.resultChars)
    const estimatedTotalTokens = Math.max(direct.tokens, this.modeledTotal)
    return {
      totals: {
        ...direct,
        calls: this.calls,
        activities: this.activities,
        inferredTurns: this.inferredTurns,
        estimatedTotalTokens,
        estimatedSurroundingTokens: Math.max(0, estimatedTotalTokens - direct.tokens),
        byTool: [...this.tools.entries()]
          .filter(([, value]) => value.calls > 0)
          .map(([tool, value]) => ({ tool, calls: value.calls, ...lane(value.requestChars, value.resultChars) }))
          .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls),
        bySource: [...this.bySource.entries()]
          .filter(([, value]) => value.requestCalls > 0 || value.resultCalls > 0)
          .map(([source, value]) => ({
            source,
            requestCalls: value.requestCalls,
            resultCalls: value.resultCalls,
            ...lane(value.requestChars, value.resultChars),
          }))
          .sort((a, b) => b.tokens - a.tokens),
      },
      coverage: {
        request: { ...this.request },
        result: { ...this.result },
        invalidPersistedMeasurements: this.invalid,
        complete: this.request.unavailable === 0 && this.result.unavailable === 0 && this.invalid === 0,
      },
    }
  }
}