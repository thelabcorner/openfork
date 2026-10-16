export * as OxpAttributionModel from "./model"

export type Source = "observed_boundary" | "historical_detail" | "calibrated_surrogate" | "calibrated_donor"

export interface Mass {
  readonly chars: number
  readonly source: Source
}

export interface Row {
  readonly id: string
  readonly activityID: string
  readonly tool: string
  readonly status: string
  readonly startedAt: number
  readonly completedAt?: number
  readonly request?: Mass
  readonly result?: Mass
}

export interface UpstreamModel {
  readonly coefficients: readonly number[]
  readonly means: readonly number[]
  readonly stds: readonly number[]
}

export interface ProjectOptions {
  readonly turnGapThresholdMs: number
  readonly requestCharsPerToken: number
  readonly resultCharsPerToken: number
  readonly upstream: UpstreamModel
}

export interface LaneSnapshot {
  readonly requestChars: number
  readonly resultChars: number
  readonly chars: number
  readonly requestTokens: number
  readonly resultTokens: number
  readonly tokens: number
}

export interface ToolSnapshot extends LaneSnapshot {
  readonly tool: string
  readonly calls: number
}

export interface SourceSnapshot extends LaneSnapshot {
  readonly source: Source
  readonly requestCalls: number
  readonly resultCalls: number
}

export interface Snapshot extends LaneSnapshot {
  readonly calls: number
  readonly activities: number
  readonly inferredTurns: number
  readonly estimatedSurroundingTokens: number
  readonly estimatedTotalTokens: number
  readonly byTool: readonly ToolSnapshot[]
  readonly bySource: readonly SourceSnapshot[]
}

type Lane = {
  requestChars: number
  resultChars: number
}

type ToolLane = Lane & {
  calls: number
}

type SourceLane = Lane & {
  requestCalls: number
  resultCalls: number
}

type Turn = Lane & {
  start: number
  end: number
  calls: number
}

function finiteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid OXP usage ${label}`)
  return value
}

function validateOptions(options: ProjectOptions) {
  finiteNonNegative(options.turnGapThresholdMs, "turn gap threshold")
  if (!(options.requestCharsPerToken > 0) || !(options.resultCharsPerToken > 0))
    throw new Error("Invalid OXP usage tokenizer calibration")
  const width = 8
  if (
    options.upstream.coefficients.length !== width ||
    options.upstream.means.length !== width ||
    options.upstream.stds.length !== width
  ) {
    throw new Error("Invalid OXP upstream calibration dimensions")
  }
  if (options.upstream.stds.some((value) => !(value > 0) || !Number.isFinite(value)))
    throw new Error("Invalid OXP upstream calibration scaling")
}


function tokenParts(requestChars: number, resultChars: number, options: ProjectOptions) {
  const requestTokens = requestChars / options.requestCharsPerToken
  const resultTokens = resultChars / options.resultCharsPerToken
  return {
    requestTokens,
    resultTokens,
    tokens: requestTokens + resultTokens,
  }
}

function snapshot(requestChars: number, resultChars: number, options: ProjectOptions): LaneSnapshot {
  return {
    requestChars,
    resultChars,
    chars: requestChars + resultChars,
    ...tokenParts(requestChars, resultChars, options),
  }
}

function estimateTurnTotal(
  turn: Turn,
  index: number,
  cumulativeTokens: number,
  cumulativeCalls: number,
  options: ProjectOptions,
) {
  const direct = tokenParts(turn.requestChars, turn.resultChars, options)
  const { coefficients: c, means: m, stds: s } = options.upstream
  // Eight fixed calibration features; avoid allocating a seven-log array for
  // every inferred turn. The accumulation order and centering are unchanged,
  // preserving floating-point results rather than refitting the estimator.
  let logEstimate = c[0]!
  logEstimate += ((Math.log1p(direct.requestTokens) - m[1]!) / s[1]!) * c[1]!
  logEstimate += ((Math.log1p(direct.resultTokens) - m[2]!) / s[2]!) * c[2]!
  logEstimate += ((Math.log1p(turn.calls) - m[3]!) / s[3]!) * c[3]!
  logEstimate += ((Math.log1p(cumulativeTokens) - m[4]!) / s[4]!) * c[4]!
  logEstimate += ((Math.log1p(cumulativeCalls) - m[5]!) / s[5]!) * c[5]!
  logEstimate += ((Math.log1p(index) - m[6]!) / s[6]!) * c[6]!
  logEstimate += ((Math.log1p(Math.max(0, turn.end - turn.start) / 1000) - m[7]!) / s[7]!) * c[7]!
  const estimate = Math.expm1(logEstimate)
  if (!Number.isFinite(estimate)) return direct.tokens
  return Math.max(direct.tokens, estimate)
}

export function project(input: readonly Row[], options: ProjectOptions): Snapshot {
  validateOptions(options)

  const direct: Lane = { requestChars: 0, resultChars: 0 }
  const tools = new Map<string, ToolLane>()
  const sources = new Map<Source, SourceLane>()
  let activities = 0
  let inferredTurns = 0
  let estimatedTotalTokens = 0
  let previousActivity: string | undefined
  let previousStartedAt = Number.NEGATIVE_INFINITY
  const closedActivities = new Set<string>()
  let active: Turn | undefined
  let turnIndex = 0
  let cumulativeTokens = 0
  let cumulativeCalls = 0

  // Stream one activity's interval union at a time. No per-activity row
  // copies or turn arrays: prefix features advance only when a turn closes.
  const flush = () => {
    if (!active) return
    turnIndex += 1
    inferredTurns += 1
    cumulativeTokens += tokenParts(active.requestChars, active.resultChars, options).tokens
    cumulativeCalls += active.calls
    estimatedTotalTokens += estimateTurnTotal(active, turnIndex, cumulativeTokens, cumulativeCalls, options)
    active = undefined
  }

  for (const row of input) {
    // Fuse correctness validation into the streaming projector: the same
    // grouped/ordered input contract, but no preliminary O(N) traversal.
    if (!row.id || !row.activityID || !row.tool) throw new Error("Invalid OXP usage row identity")
    finiteNonNegative(row.startedAt, "startedAt")
    if (row.completedAt !== undefined) {
      finiteNonNegative(row.completedAt, "completedAt")
      if (row.completedAt < row.startedAt) throw new Error("Invalid OXP usage invocation geometry")
    }
    if (row.request) finiteNonNegative(row.request.chars, "request mass")
    if (row.result) finiteNonNegative(row.result.chars, "result mass")
    if (row.activityID !== previousActivity) {
      if (closedActivities.has(row.activityID)) throw new Error("OXP usage rows must be grouped by activity")
      if (previousActivity !== undefined) closedActivities.add(previousActivity)
      flush()
      previousActivity = row.activityID
      activities += 1
      turnIndex = 0
      cumulativeTokens = 0
      cumulativeCalls = 0
      previousStartedAt = Number.NEGATIVE_INFINITY
    }
    if (row.startedAt < previousStartedAt) throw new Error("OXP usage rows must be ordered by activity and start time")
    previousStartedAt = row.startedAt
    const end = row.completedAt ?? row.startedAt
    if (!active || row.startedAt > active.end + options.turnGapThresholdMs) {
      flush()
      active = { start: row.startedAt, end, calls: 0, requestChars: 0, resultChars: 0 }
    } else {
      active.end = Math.max(active.end, end)
    }
    active.requestChars += row.request?.chars ?? 0
    active.resultChars += row.result?.chars ?? 0
    active.calls += 1

    let tool = tools.get(row.tool)
    if (!tool) {
      tool = { calls: 0, requestChars: 0, resultChars: 0 }
      tools.set(row.tool, tool)
    }
    tool.calls += 1

    if (row.request) {
      direct.requestChars += row.request.chars
      tool.requestChars += row.request.chars
      let source = sources.get(row.request.source)
      if (!source) {
        source = { requestCalls: 0, resultCalls: 0, requestChars: 0, resultChars: 0 }
        sources.set(row.request.source, source)
      }
      source.requestCalls += 1
      source.requestChars += row.request.chars
    }
    if (row.result) {
      direct.resultChars += row.result.chars
      tool.resultChars += row.result.chars
      let source = sources.get(row.result.source)
      if (!source) {
        source = { requestCalls: 0, resultCalls: 0, requestChars: 0, resultChars: 0 }
        sources.set(row.result.source, source)
      }
      source.resultCalls += 1
      source.resultChars += row.result.chars
    }
  }

  flush()

  const total = snapshot(direct.requestChars, direct.resultChars, options)
  estimatedTotalTokens = Math.max(total.tokens, estimatedTotalTokens)

  return {
    calls: input.length,
    activities,
    inferredTurns,
    estimatedSurroundingTokens: Math.max(0, estimatedTotalTokens - total.tokens),
    estimatedTotalTokens,
    ...total,
    byTool: [...tools.entries()]
      .map(([tool, value]) => ({
        tool,
        calls: value.calls,
        ...snapshot(value.requestChars, value.resultChars, options),
      }))
      .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls),
    bySource: [...sources.entries()]
      .map(([source, value]) => ({
        source,
        requestCalls: value.requestCalls,
        resultCalls: value.resultCalls,
        ...snapshot(value.requestChars, value.resultChars, options),
      }))
      .sort((a, b) => b.tokens - a.tokens),
  }
}
