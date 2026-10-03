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

export interface ProjectOptions {
  readonly rho: number
  readonly gapThresholdMs: number
  readonly requestCharsPerToken: number
  readonly resultCharsPerToken: number
}

interface LaneState {
  requestC: number
  resultC: number
  requestT: number
  resultT: number
}

interface LazyLaneState {
  requestState: number
  resultState: number
  requestExposure: number
  resultExposure: number
  lastRound: number
}

interface ClusterLane {
  request: number
  result: number
}

interface Cluster {
  end: number
  request: number
  result: number
  byTool: Map<string, ClusterLane>
  bySource: Map<Source, ClusterLane>
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
  readonly uniqueRequestChars: number
  readonly uniqueResultChars: number
  readonly uniqueChars: number
  readonly uniqueTokens: number
}

export interface SourceSnapshot extends LaneSnapshot {
  readonly source: Source
  readonly requestCalls: number
  readonly resultCalls: number
  readonly uniqueChars: number
}

export interface Snapshot extends LaneSnapshot {
  readonly calls: number
  readonly activities: number
  readonly inferredRounds: number
  readonly uniqueRequestChars: number
  readonly uniqueResultChars: number
  readonly uniqueChars: number
  readonly uniqueTokens: number
  readonly amplification: number | null
  readonly byTool: readonly ToolSnapshot[]
  readonly bySource: readonly SourceSnapshot[]
}

/**
 * Aggregate-only recurrence used by rho sensitivity probes.
 *
 * It deliberately skips by-tool/by-source maps and unique accounting; those
 * are invariant across rho and are only needed for the calibrated rich
 * snapshot.
 */
export function projectTokenTotal(
  input: readonly Row[],
  options: ProjectOptions,
) {
  const rho = finiteNonNegative(options.rho, "rho")
  if (rho > 1) throw new Error("Invalid OXP attribution rho")
  finiteNonNegative(options.gapThresholdMs, "gap threshold")
  if (!(options.requestCharsPerToken > 0) || !(options.resultCharsPerToken > 0))
    throw new Error("Invalid OXP attribution tokenizer calibration")
  validateRows(input)

  let requestExposure = 0
  let resultExposure = 0
  for (let offset = 0; offset < input.length; ) {
    const activityID = input[offset]!.activityID
    let end = offset + 1
    while (end < input.length && input[end]!.activityID === activityID) end += 1

    let requestState = 0
    let resultState = 0
    let clusterEnd = Number.NEGATIVE_INFINITY
    let clusterRequest = 0
    let clusterResult = 0

    const flush = () => {
      if (clusterEnd === Number.NEGATIVE_INFINITY) return
      requestState = rho * requestState + clusterRequest
      resultState = rho * resultState + clusterResult
      requestExposure += requestState
      resultExposure += resultState
    }

    for (let index = offset; index < end; index += 1) {
      const row = input[index]!
      const rowEnd = row.completedAt ?? row.startedAt
      if (
        clusterEnd !== Number.NEGATIVE_INFINITY &&
        row.startedAt > clusterEnd + options.gapThresholdMs
      ) {
        flush()
        clusterEnd = rowEnd
        clusterRequest = 0
        clusterResult = 0
      } else {
        clusterEnd =
          clusterEnd === Number.NEGATIVE_INFINITY
            ? rowEnd
            : Math.max(clusterEnd, rowEnd)
      }
      clusterRequest += row.request?.chars ?? 0
      clusterResult += row.result?.chars ?? 0
    }
    flush()
    offset = end
  }

  return tokens(requestExposure, resultExposure, options).tokens
}

function lane() {
  return { requestC: 0, resultC: 0, requestT: 0, resultT: 0 }
}

function lazyLane(): LazyLaneState {
  return {
    requestState: 0,
    resultState: 0,
    requestExposure: 0,
    resultExposure: 0,
    lastRound: 0,
  }
}

function clusterLane(map: Map<string, ClusterLane>, key: string) {
  let value = map.get(key)
  if (!value) {
    value = { request: 0, result: 0 }
    map.set(key, value)
  }
  return value
}

function clusterSourceLane(map: Map<Source, ClusterLane>, key: Source) {
  let value = map.get(key)
  if (!value) {
    value = { request: 0, result: 0 }
    map.set(key, value)
  }
  return value
}

function finiteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid OXP attribution ${label}`)
  return value
}

function validateRows(input: readonly Row[]) {
  let previousActivity = ""
  let previousStartedAt = Number.NEGATIVE_INFINITY
  const closedActivities = new Set<string>()
  for (const row of input) {
    if (!row.id || !row.activityID || !row.tool) throw new Error("Invalid OXP attribution row identity")
    finiteNonNegative(row.startedAt, "startedAt")
    if (row.completedAt !== undefined) {
      finiteNonNegative(row.completedAt, "completedAt")
      if (row.completedAt < row.startedAt) throw new Error("Invalid OXP attribution invocation geometry")
    }
    if (row.request) finiteNonNegative(row.request.chars, "request mass")
    if (row.result) finiteNonNegative(row.result.chars, "result mass")

    if (row.activityID !== previousActivity) {
      if (closedActivities.has(row.activityID)) throw new Error("OXP attribution rows must be grouped by activity")
      if (previousActivity) closedActivities.add(previousActivity)
      previousActivity = row.activityID
      previousStartedAt = Number.NEGATIVE_INFINITY
    }
    if (row.startedAt < previousStartedAt)
      throw new Error("OXP attribution rows must be ordered by activity and start time")
    previousStartedAt = row.startedAt
  }
}

function tokens(requestChars: number, resultChars: number, options: ProjectOptions) {
  const requestTokens = requestChars / options.requestCharsPerToken
  const resultTokens = resultChars / options.resultCharsPerToken
  return {
    requestTokens,
    resultTokens,
    tokens: requestTokens + resultTokens,
  }
}

function snapshotExposure(requestChars: number, resultChars: number, options: ProjectOptions): LaneSnapshot {
  return {
    requestChars,
    resultChars,
    chars: requestChars + resultChars,
    ...tokens(requestChars, resultChars, options),
  }
}

function clusters(rows: readonly Row[], gapThresholdMs: number) {
  const result: Cluster[] = []
  let active: Cluster | undefined
  for (const row of rows) {
    const end = row.completedAt ?? row.startedAt
    if (!active || row.startedAt > active.end + gapThresholdMs) {
      active = {
        end,
        request: 0,
        result: 0,
        byTool: new Map(),
        bySource: new Map(),
      }
      result.push(active)
    } else {
      active.end = Math.max(active.end, end)
    }

    const tool = clusterLane(active.byTool, row.tool)
    if (row.request) {
      active.request += row.request.chars
      tool.request += row.request.chars
      clusterSourceLane(active.bySource, row.request.source).request += row.request.chars
    }
    if (row.result) {
      active.result += row.result.chars
      tool.result += row.result.chars
      clusterSourceLane(active.bySource, row.result.source).result += row.result.chars
    }
  }
  return result
}

function decaySum(state: number, rho: number, rounds: number) {
  if (!(state > 0) || rounds <= 0) return 0
  if (rho <= 0) return 0
  if (rho >= 1) return state * rounds
  const logRho = Math.log(rho)
  return (state * rho * -Math.expm1(logRho * rounds)) / -Math.expm1(logRho)
}

function decayState(state: number, rho: number, rounds: number) {
  if (!(state > 0) || rounds <= 0) return state
  if (rho <= 0) return 0
  if (rho >= 1) return state
  return state * Math.exp(Math.log(rho) * rounds)
}

function advanceLazy<K>(
  states: Map<K, LazyLaneState>,
  additions: ReadonlyMap<K, ClusterLane>,
  round: number,
  rho: number,
) {
  for (const [key, addition] of additions) {
    let state = states.get(key)
    if (!state) {
      state = lazyLane()
      states.set(key, state)
    }
    const emptyRounds = Math.max(0, round - state.lastRound - 1)
    state.requestExposure += decaySum(state.requestState, rho, emptyRounds)
    state.resultExposure += decaySum(state.resultState, rho, emptyRounds)
    state.requestState = decayState(state.requestState, rho, emptyRounds)
    state.resultState = decayState(state.resultState, rho, emptyRounds)
    state.requestState = rho * state.requestState + addition.request
    state.resultState = rho * state.resultState + addition.result
    state.requestExposure += state.requestState
    state.resultExposure += state.resultState
    state.lastRound = round
  }
}

function snapshotLazy(state: LazyLaneState, round: number, rho: number) {
  const missingRounds = Math.max(0, round - state.lastRound)
  return {
    request: state.requestExposure + decaySum(state.requestState, rho, missingRounds),
    result: state.resultExposure + decaySum(state.resultState, rho, missingRounds),
  }
}

export function project(input: readonly Row[], options: ProjectOptions): Snapshot {
  const rho = finiteNonNegative(options.rho, "rho")
  if (rho > 1) throw new Error("Invalid OXP attribution rho")
  finiteNonNegative(options.gapThresholdMs, "gap threshold")
  if (!(options.requestCharsPerToken > 0) || !(options.resultCharsPerToken > 0))
    throw new Error("Invalid OXP attribution tokenizer calibration")
  validateRows(input)

  const toolTotals = new Map<
    string,
    {
      requestExposure: number
      resultExposure: number
      calls: number
      uniqueRequest: number
      uniqueResult: number
    }
  >()
  const sourceTotals = new Map<
    Source,
    {
      requestExposure: number
      resultExposure: number
      requestCalls: number
      resultCalls: number
      unique: number
    }
  >()

  let requestT = 0
  let resultT = 0
  let uniqueRequest = 0
  let uniqueResult = 0
  let inferredRounds = 0
  let activities = 0

  for (let offset = 0; offset < input.length; ) {
    const activityID = input[offset]!.activityID
    let end = offset + 1
    while (end < input.length && input[end]!.activityID === activityID) end += 1
    const rows = input.slice(offset, end)
    activities += 1

    for (const row of rows) {
      let tool = toolTotals.get(row.tool)
      if (!tool) {
        tool = {
          requestExposure: 0,
          resultExposure: 0,
          calls: 0,
          uniqueRequest: 0,
          uniqueResult: 0,
        }
        toolTotals.set(row.tool, tool)
      }
      tool.calls += 1
      if (row.request) {
        uniqueRequest += row.request.chars
        tool.uniqueRequest += row.request.chars
        let source = sourceTotals.get(row.request.source)
        if (!source) {
          source = {
            requestExposure: 0,
            resultExposure: 0,
            requestCalls: 0,
            resultCalls: 0,
            unique: 0,
          }
          sourceTotals.set(row.request.source, source)
        }
        source.requestCalls += 1
        source.unique += row.request.chars
      }
      if (row.result) {
        uniqueResult += row.result.chars
        tool.uniqueResult += row.result.chars
        let source = sourceTotals.get(row.result.source)
        if (!source) {
          source = {
            requestExposure: 0,
            resultExposure: 0,
            requestCalls: 0,
            resultCalls: 0,
            unique: 0,
          }
          sourceTotals.set(row.result.source, source)
        }
        source.resultCalls += 1
        source.unique += row.result.chars
      }
    }

    const activityClusters = clusters(rows, options.gapThresholdMs)
    inferredRounds += activityClusters.length
    const total = lane()
    const byTool = new Map<string, LazyLaneState>()
    const bySource = new Map<Source, LazyLaneState>()

    for (let index = 0; index < activityClusters.length; index += 1) {
      const cluster = activityClusters[index]!
      const round = index + 1
      total.requestC = total.requestC * rho + cluster.request
      total.resultC = total.resultC * rho + cluster.result
      total.requestT += total.requestC
      total.resultT += total.resultC
      advanceLazy(byTool, cluster.byTool, round, rho)
      advanceLazy(bySource, cluster.bySource, round, rho)
    }

    requestT += total.requestT
    resultT += total.resultT
    for (const [tool, state] of byTool) {
      const aggregate = toolTotals.get(tool)!
      const exposure = snapshotLazy(state, activityClusters.length, rho)
      aggregate.requestExposure += exposure.request
      aggregate.resultExposure += exposure.result
    }
    for (const [source, state] of bySource) {
      const aggregate = sourceTotals.get(source)!
      const exposure = snapshotLazy(state, activityClusters.length, rho)
      aggregate.requestExposure += exposure.request
      aggregate.resultExposure += exposure.result
    }
    offset = end
  }

  const uniqueChars = uniqueRequest + uniqueResult
  const uniqueTokenParts = tokens(uniqueRequest, uniqueResult, options)
  const exposure = {
    requestChars: requestT,
    resultChars: resultT,
    chars: requestT + resultT,
    ...tokens(requestT, resultT, options),
  }

  return {
    calls: input.length,
    activities,
    inferredRounds,
    uniqueRequestChars: uniqueRequest,
    uniqueResultChars: uniqueResult,
    uniqueChars,
    uniqueTokens: uniqueTokenParts.tokens,
    amplification: uniqueTokenParts.tokens > 0 ? exposure.tokens / uniqueTokenParts.tokens : null,
    ...exposure,
    byTool: [...toolTotals.entries()]
      .map(([tool, value]) => ({
        tool,
        calls: value.calls,
        uniqueRequestChars: value.uniqueRequest,
        uniqueResultChars: value.uniqueResult,
        uniqueChars: value.uniqueRequest + value.uniqueResult,
        uniqueTokens: tokens(value.uniqueRequest, value.uniqueResult, options).tokens,
        ...snapshotExposure(value.requestExposure, value.resultExposure, options),
      }))
      .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls),
    bySource: [...sourceTotals.entries()]
      .map(([source, value]) => ({
        source,
        requestCalls: value.requestCalls,
        resultCalls: value.resultCalls,
        uniqueChars: value.unique,
        ...snapshotExposure(value.requestExposure, value.resultExposure, options),
      }))
      .sort((a, b) => b.tokens - a.tokens),
  }
}
