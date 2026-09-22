import { Database as BunDatabase } from "bun:sqlite"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import {
  effectiveSamples,
  momentsFor,
  observeYieldStatistic,
  sessionMomentsFor,
  snapshotYieldStatistic,
  type YieldHalfLife,
  type YieldObservation,
  type YieldStatisticState,
} from "@opencode-ai/core/usage/yield-statistics"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import { dirname, join } from "node:path"
import { GO_CAPACITY_CALIBRATION } from "../src/capacity/capacity"
import { GoCapacityPrior } from "../src/capacity/go-prior"

const HALF_LIVES = [8, 16, 32] as const satisfies readonly YieldHalfLife[]
const BASE_KAPPAS = [0.5, 1, 2, 4, 8] as const
const ACCOUNT_KAPPAS = [1, 2, 4, 8, 16, 32] as const
const RAW_RECENT = [8, 16, 32] as const
const SESSION_EXPERT_KAPPAS = [1, 2, 4, 8, 16] as const
const TUNE_FRACTION = 0.7
const HORIZON = 20
const STOPPING_BUDGETS = [5, 20, 100] as const
const PREDICTIVE_COVERAGE = 0.8

type Row = {
  message_id: string
  session_id: string
  model_id: string
  base_model_id: string | null
  account_id: string | null
  completed_at: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
}

type Item = {
  readonly index: number
  readonly row: Row
  readonly prior: GoCapacityPrior.ModelPrior
  readonly modelID: string
  readonly accountID?: string
  readonly tokens: YieldObservation["tokens"]
  readonly y: number
}

type StateMetric = {
  readonly observations: number
  readonly personalMean?: number
  readonly requestESS: number
  readonly sessionESS: number
}

type CandidateFamily =
  | "prior"
  | "raw"
  | "request"
  | "session"
  | "overlay"
  | "hier"
  | "session-expert"

type Candidate = {
  readonly name: string
  readonly family: CandidateFamily
  readonly halfLife?: YieldHalfLife
  readonly baseKappa?: number
  readonly accountKappa?: number
  readonly sessionKappa?: number
}

type Prediction = {
  readonly index: number
  readonly sessionID: string
  readonly actual: number
  readonly values: readonly number[]
  readonly baseObservations: number
  readonly accountObservations: number
  readonly baseSessionESS: Readonly<Record<number, number>>
  readonly accountSessionESS: Readonly<Record<number, number>>
  readonly currentSessionMean?: number
  readonly currentSessionCount: number
}

type Errors = {
  readonly absolute: number[]
  readonly signed: number[]
}

type Ranked = {
  readonly name: string
  readonly family: CandidateFamily
  readonly tune: ReturnType<typeof summarize>
  readonly test: ReturnType<typeof summarize>
}

const response = await fetch(GoCapacityPrior.SOURCE_URL)
if (!response.ok) throw new Error("Could not fetch current Go docs: " + response.status)
const priors = GoCapacityPrior.parse(await response.text())
const byModel = new Map(priors.map((prior) => [prior.modelID, prior]))

const dbPath = join(dirname(CoreDatabase.path()), "openfork-main.db")
const db = new BunDatabase(dbPath, { readonly: true, create: false, strict: true })
const rows = db.query<Row, []>(`
  SELECT message_id, session_id, model_id, base_model_id, account_id, completed_at,
         input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
  FROM usage_record
  WHERE provider_id = 'opencode-go'
    AND NOT (mode = 'compaction' OR agent = 'compaction' OR agent = 'summary')
  ORDER BY completed_at ASC, message_id ASC
`).all()
db.close()

const usable: Item[] = []
for (const row of rows) {
  const parsed = splitAccountModelID(row.model_id)
  const modelID = row.base_model_id ?? parsed.baseModelID
  const accountID = row.account_id ?? parsed.accountID
  const prior = byModel.get(modelID)
  if (!prior) continue
  const tokens: YieldObservation["tokens"] = {
    input: row.input_tokens,
    cacheRead: row.cache_read_tokens,
    cacheWrite: row.cache_write_tokens,
    output: row.output_tokens,
    reasoning: row.reasoning_tokens,
  }
  const typical = GoCapacityPrior.priceTypical(prior)
  const actual = GoCapacityPrior.priceTokens(prior, tokens)
  if (!(typical !== undefined && typical > 0 && actual !== undefined && actual > 0)) continue
  usable.push({
    index: usable.length,
    row,
    prior,
    modelID,
    ...(accountID ? { accountID } : {}),
    tokens,
    y: actual / typical,
  })
}

const boundary = Math.floor(usable.length * TUNE_FRACTION)
const candidates: Candidate[] = [
  { name: "prior_only", family: "prior" },
  ...RAW_RECENT.map((count) => ({ name: `raw_recent_${count}`, family: "raw" as const })),
]
for (const halfLife of HALF_LIVES) {
  for (const baseKappa of BASE_KAPPAS) {
    candidates.push({
      name: `request_h${halfLife}_k${baseKappa}`,
      family: "request",
      halfLife,
      baseKappa,
    })
    candidates.push({
      name: `session_h${halfLife}_k${baseKappa}`,
      family: "session",
      halfLife,
      baseKappa,
    })
    candidates.push({
      name: `overlay_h${halfLife}_k${baseKappa}`,
      family: "overlay",
      halfLife,
      baseKappa,
    })
    for (const accountKappa of ACCOUNT_KAPPAS) {
      candidates.push({
        name: `hier_h${halfLife}_kb${baseKappa}_ka${accountKappa}`,
        family: "hier",
        halfLife,
        baseKappa,
        accountKappa,
      })
    }
  }
}

const modelStates = new Map<string, YieldStatisticState>()
const accountStates = new Map<string, YieldStatisticState>()
const predictionsByModel = new Map<string, Prediction[]>()
const predictionsByAccount = new Map<string, Prediction[]>()
const nextErrors = new Map<number, { tune: Errors; test: Errors }>()

const emptyErrors = (): Errors => ({ absolute: [], signed: [] })

function errorsFor(map: Map<number, { tune: Errors; test: Errors }>, index: number) {
  let value = map.get(index)
  if (!value) {
    value = { tune: emptyErrors(), test: emptyErrors() }
    map.set(index, value)
  }
  return value
}

function addError(errors: Errors, predicted: number, actual: number) {
  if (!(predicted > 0 && actual > 0 && Number.isFinite(predicted) && Number.isFinite(actual))) return
  const signed = Math.log(predicted / actual)
  errors.signed.push(signed)
  errors.absolute.push(Math.abs(signed))
}

function accountKey(modelID: string, accountID: string) {
  return `${modelID}\u0000${accountID}`
}

function pricedMultiplier(
  prior: GoCapacityPrior.ModelPrior,
  tokens: readonly number[],
) {
  const typical = GoCapacityPrior.priceTypical(prior)
  if (!(typical !== undefined && typical > 0)) return undefined
  const cost = GoCapacityPrior.priceTokens(prior, {
    input: tokens[0] ?? 0,
    cacheRead: tokens[1] ?? 0,
    cacheWrite: tokens[2] ?? 0,
    output: tokens[3] ?? 0,
    reasoning: tokens[4] ?? 0,
  })
  return cost !== undefined && cost > 0 ? cost / typical : undefined
}

function metric(
  prior: GoCapacityPrior.ModelPrior,
  state: YieldStatisticState | undefined,
  halfLife: YieldHalfLife,
): StateMetric {
  if (!state) return { observations: 0, requestESS: 0, sessionESS: 0 }
  const snapshot = snapshotYieldStatistic(state)
  const request = momentsFor(snapshot, halfLife)
  const sessions = sessionMomentsFor(snapshot, halfLife)
  const requestESS = request ? effectiveSamples(request) : 0
  const sessionESS = sessions ? effectiveSamples(sessions) : 0

  const rho = 0.5 ** (1 / halfLife)
  let weight = 0
  let sum = 0
  for (let index = 0; index < snapshot.recent.length; index++) {
    const observation = snapshot.recent[index]!
    const multiplier = pricedMultiplier(prior, observation.tokens)
    if (!(multiplier !== undefined && multiplier > 0)) continue
    const currentWeight = rho ** (snapshot.recent.length - 1 - index)
    weight += currentWeight
    sum += currentWeight * multiplier
  }
  return {
    observations: snapshot.observations,
    personalMean: weight > 0 ? sum / weight : undefined,
    requestESS,
    sessionESS,
  }
}

function posterior(priorMean: number, state: StateMetric, kappa: number, sessionAware: boolean) {
  const evidence = sessionAware ? Math.min(state.requestESS, state.sessionESS) : state.requestESS
  if (!(state.personalMean !== undefined && state.personalMean > 0 && evidence > 0)) {
    return { mean: priorMean, evidence: 0 }
  }
  return {
    mean: (kappa * priorMean + evidence * state.personalMean) / (kappa + evidence),
    evidence,
  }
}

function rawRecentMean(
  prior: GoCapacityPrior.ModelPrior,
  state: YieldStatisticState | undefined,
  count: number,
) {
  if (!state || state.recent.length === 0) return 1
  let sum = 0
  let n = 0
  for (const observation of state.recent.slice(-count)) {
    const multiplier = pricedMultiplier(prior, observation.tokens)
    if (!(multiplier !== undefined && multiplier > 0)) continue
    sum += multiplier
    n++
  }
  return n > 0 ? sum / n : 1
}

function currentSessionMean(
  prior: GoCapacityPrior.ModelPrior,
  state: YieldStatisticState | undefined,
  sessionID: string,
) {
  if (!state || state.recent.length === 0) return { mean: undefined, count: 0 }
  let sum = 0
  let count = 0
  for (const observation of state.recent) {
    if (observation.sessionID !== sessionID) continue
    const multiplier = pricedMultiplier(prior, observation.tokens)
    if (!(multiplier !== undefined && multiplier > 0)) continue
    sum += multiplier
    count++
  }
  return { mean: count > 0 ? sum / count : undefined, count }
}

function recordPrediction(
  item: Item,
  values: readonly number[],
  baseMetrics: ReadonlyMap<YieldHalfLife, StateMetric>,
  accountMetrics: ReadonlyMap<YieldHalfLife, StateMetric>,
  baseState: YieldStatisticState | undefined,
  accountState: YieldStatisticState | undefined,
) {
  const session = currentSessionMean(item.prior, accountState ?? baseState, item.row.session_id)
  const baseSessionESS = Object.fromEntries(
    HALF_LIVES.map((halfLife) => [halfLife, baseMetrics.get(halfLife)?.sessionESS ?? 0]),
  )
  const accountSessionESS = Object.fromEntries(
    HALF_LIVES.map((halfLife) => [halfLife, accountMetrics.get(halfLife)?.sessionESS ?? 0]),
  )
  const prediction: Prediction = {
    index: item.index,
    sessionID: item.row.session_id,
    actual: item.y,
    values,
    baseObservations: baseState?.observations ?? 0,
    accountObservations: accountState?.observations ?? 0,
    baseSessionESS,
    accountSessionESS,
    currentSessionMean: session.mean,
    currentSessionCount: session.count,
  }
  const modelRows = predictionsByModel.get(item.modelID) ?? []
  modelRows.push(prediction)
  predictionsByModel.set(item.modelID, modelRows)
  if (item.accountID) {
    const key = accountKey(item.modelID, item.accountID)
    const accountRows = predictionsByAccount.get(key) ?? []
    accountRows.push(prediction)
    predictionsByAccount.set(key, accountRows)
  }
}

for (const item of usable) {
  const baseState = modelStates.get(item.modelID)
  const key = item.accountID ? accountKey(item.modelID, item.accountID) : undefined
  const accountState = key ? accountStates.get(key) : undefined
  const baseMetrics = new Map<YieldHalfLife, StateMetric>()
  const accountMetrics = new Map<YieldHalfLife, StateMetric>()
  for (const halfLife of HALF_LIVES) {
    baseMetrics.set(halfLife, metric(item.prior, baseState, halfLife))
    accountMetrics.set(halfLife, metric(item.prior, accountState, halfLife))
  }

  const values = new Array<number>(candidates.length)
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex]!
    let predicted = 1

    if (candidate.family === "raw") {
      const count = Number(candidate.name.slice("raw_recent_".length))
      predicted = rawRecentMean(item.prior, accountState ?? baseState, count)
    } else if (
      candidate.family === "request" ||
      candidate.family === "session" ||
      candidate.family === "overlay" ||
      candidate.family === "hier"
    ) {
      const halfLife = candidate.halfLife!
      const baseMetric = baseMetrics.get(halfLife)!
      const base = posterior(1, baseMetric, candidate.baseKappa!, candidate.family !== "request")

      if (candidate.family === "request" || candidate.family === "session") {
        predicted = base.mean
      } else if (candidate.family === "overlay") {
        const overlayMetric = accountState ? accountMetrics.get(halfLife)! : baseMetric
        predicted = posterior(1, overlayMetric, candidate.baseKappa!, true).mean
      } else {
        const accountMetric = accountMetrics.get(halfLife)!
        predicted = accountState
          ? posterior(base.mean, accountMetric, candidate.accountKappa!, true).mean
          : base.mean
      }
    }

    values[candidateIndex] = predicted
    const split = item.index < boundary ? "tune" : "test"
    addError(errorsFor(nextErrors, candidateIndex)[split], predicted, item.y)
  }

  recordPrediction(item, values, baseMetrics, accountMetrics, baseState, accountState)

  const observation: YieldObservation = {
    sessionID: item.row.session_id,
    completedAt: item.row.completed_at,
    tokens: item.tokens,
  }
  modelStates.set(item.modelID, observeYieldStatistic(baseState, observation))
  if (key) accountStates.set(key, observeYieldStatistic(accountState, observation))
}

function mean(values: readonly number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN
}

function quantile(values: readonly number[], q: number) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) return sorted[low]!
  const fraction = position - low
  return sorted[low]! * (1 - fraction) + sorted[high]! * fraction
}

function summarize(errors: Errors) {
  return {
    n: errors.absolute.length,
    meanAbsLog: mean(errors.absolute),
    rmsle:
      errors.absolute.length > 0
        ? Math.sqrt(errors.absolute.reduce((sum, value) => sum + value * value, 0) / errors.absolute.length)
        : Number.NaN,
    geometricBiasPct: errors.signed.length > 0 ? (Math.exp(mean(errors.signed)) - 1) * 100 : Number.NaN,
    medianFactor: errors.absolute.length > 0 ? Math.exp(quantile(errors.absolute, 0.5)) : Number.NaN,
    p90Factor: errors.absolute.length > 0 ? Math.exp(quantile(errors.absolute, 0.9)) : Number.NaN,
  }
}

function horizonErrors(groups: Iterable<Prediction[]>) {
  const result = new Map<number, { tune: Errors; test: Errors }>()
  for (const group of groups) {
    if (group.length < HORIZON) continue
    const prefix = new Array<number>(group.length + 1).fill(0)
    for (let i = 0; i < group.length; i++) prefix[i + 1] = prefix[i]! + group[i]!.actual
    for (let i = 0; i + HORIZON <= group.length; i++) {
      const first = group[i]!
      const last = group[i + HORIZON - 1]!
      const split =
        first.index < boundary && last.index < boundary
          ? "tune"
          : first.index >= boundary
            ? "test"
            : undefined
      if (!split) continue
      const actual = (prefix[i + HORIZON]! - prefix[i]!) / HORIZON
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        addError(errorsFor(result, candidateIndex)[split], first.values[candidateIndex]!, actual)
      }
    }
  }
  return result
}

function ranked(errors: Map<number, { tune: Errors; test: Errors }>, family?: CandidateFamily): Ranked[] {
  return [...errors.entries()]
    .map(([candidateIndex, value]) => ({
      candidateIndex,
      candidate: candidates[candidateIndex]!,
      tune: summarize(value.tune),
      test: summarize(value.test),
    }))
    .filter((entry) => (!family || entry.candidate.family === family) && entry.tune.n > 0)
    .sort((a, b) => a.tune.meanAbsLog - b.tune.meanAbsLog)
    .map((entry) => ({
      name: entry.candidate.name,
      family: entry.candidate.family,
      tune: entry.tune,
      test: entry.test,
    }))
}

const modelHorizon = horizonErrors(predictionsByModel.values())
const accountHorizon = horizonErrors(predictionsByAccount.values())

function familyWinners(errors: Map<number, { tune: Errors; test: Errors }>) {
  return Object.fromEntries(
    (["prior", "raw", "request", "session", "overlay", "hier"] as const).map((family) => [
      family,
      ranked(errors, family).slice(0, 5),
    ]),
  )
}

function macroAccountRanking(family: CandidateFamily) {
  const indices = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter((entry) => entry.candidate.family === family)
  const macro = new Map<number, { tune: number[]; test: number[] }>()

  for (const group of predictionsByAccount.values()) {
    if (group.length < HORIZON) continue
    const prefix = new Array<number>(group.length + 1).fill(0)
    for (let i = 0; i < group.length; i++) prefix[i + 1] = prefix[i]! + group[i]!.actual

    const perCandidate = new Map<number, { tune: Errors; test: Errors }>()
    for (let i = 0; i + HORIZON <= group.length; i++) {
      const first = group[i]!
      const last = group[i + HORIZON - 1]!
      const split =
        first.index < boundary && last.index < boundary
          ? "tune"
          : first.index >= boundary
            ? "test"
            : undefined
      if (!split) continue
      const actual = (prefix[i + HORIZON]! - prefix[i]!) / HORIZON
      for (const { index } of indices) {
        addError(errorsFor(perCandidate, index)[split], first.values[index]!, actual)
      }
    }

    for (const { index } of indices) {
      const scoped = perCandidate.get(index)
      if (!scoped) continue
      const target = macro.get(index) ?? { tune: [], test: [] }
      if (scoped.tune.absolute.length > 0) target.tune.push(mean(scoped.tune.absolute))
      if (scoped.test.absolute.length > 0) target.test.push(mean(scoped.test.absolute))
      macro.set(index, target)
    }
  }

  return [...macro.entries()]
    .map(([index, value]) => ({
      name: candidates[index]!.name,
      family,
      tuneAccountScopes: value.tune.length,
      tuneMacroMeanAbsLog: mean(value.tune),
      testAccountScopes: value.test.length,
      testMacroMeanAbsLog: mean(value.test),
    }))
    .sort((a, b) => a.tuneMacroMeanAbsLog - b.tuneMacroMeanAbsLog)
}

function candidateIndex(name: string) {
  return candidates.findIndex((candidate) => candidate.name === name)
}

function exactObservationBucket(n: number) {
  if (n === 0) return "n=0"
  if (n === 1) return "n=1"
  if (n === 2) return "n=2"
  if (n === 3) return "n=3"
  if (n === 4) return "n=4"
  if (n === 5) return "n=5"
  if (n <= 10) return "n=6-10"
  if (n <= 20) return "n=11-20"
  if (n <= 50) return "n=21-50"
  return "n>50"
}

function coldStart(
  groups: Iterable<Prediction[]>,
  name: string,
  accountScope: boolean,
) {
  const index = candidateIndex(name)
  if (index < 0) return {}
  const buckets = new Map<string, Errors>()
  for (const group of groups) {
    if (group.length < HORIZON) continue
    const prefix = new Array<number>(group.length + 1).fill(0)
    for (let i = 0; i < group.length; i++) prefix[i + 1] = prefix[i]! + group[i]!.actual
    for (let i = 0; i + HORIZON <= group.length; i++) {
      const first = group[i]!
      const last = group[i + HORIZON - 1]!
      if (first.index < boundary || last.index < boundary) continue
      const bucketName = exactObservationBucket(accountScope ? first.accountObservations : first.baseObservations)
      const target = buckets.get(bucketName) ?? emptyErrors()
      const actual = (prefix[i + HORIZON]! - prefix[i]!) / HORIZON
      addError(target, first.values[index]!, actual)
      buckets.set(bucketName, target)
    }
  }
  return Object.fromEntries([...buckets.entries()].map(([bucket, errors]) => [bucket, summarize(errors)]))
}

// Production must preserve the session-cluster evidence cap and the explicit
// published -> personal-base -> account hierarchy. Request-only candidates stay
// in the report as ablations, but they are not eligible to configure Capacity.
//
// Keep empirical winners separate from the deployed candidate. The account-level
// tuning prefix contains too few independent physical account scopes to justify
// selecting an aggressive account kappa from row-weighted error alone, so
// production deliberately regularizes the account overlay more strongly.
const rowWeightedHierWinner = ranked(accountHorizon, "hier")[0]
const macroHierWinner = macroAccountRanking("hier")[0]
const productionCandidateName =
  `hier_h${GO_CAPACITY_CALIBRATION.personalHalfLife}_kb${GO_CAPACITY_CALIBRATION.basePriorEquivalent}_ka${GO_CAPACITY_CALIBRATION.accountPriorEquivalent}`
const productionCandidateIndex = candidateIndex(productionCandidateName)
if (productionCandidateIndex < 0) {
  throw new Error(`Production Go capacity calibration is outside the replay grid: ${productionCandidateName}`)
}
const productionCandidate = candidates[productionCandidateIndex]!
const productionAccountFuture = ranked(accountHorizon).find((entry) => entry.name === productionCandidateName)

// Evaluate a fast current-session expert only after fixing the exact production
// durable predictor. The held-out suffix is diagnostics only, never selection.
const sessionExpertResults = new Map<number, { tune: Errors; test: Errors }>()
if (productionCandidateIndex >= 0) {
  for (const group of predictionsByAccount.values()) {
    if (group.length < HORIZON) continue
    const prefix = new Array<number>(group.length + 1).fill(0)
    for (let i = 0; i < group.length; i++) prefix[i + 1] = prefix[i]! + group[i]!.actual
    for (let i = 0; i + HORIZON <= group.length; i++) {
      const first = group[i]!
      const last = group[i + HORIZON - 1]!
      const split =
        first.index < boundary && last.index < boundary
          ? "tune"
          : first.index >= boundary
            ? "test"
            : undefined
      if (!split) continue
      const actual = (prefix[i + HORIZON]! - prefix[i]!) / HORIZON
      const durable = first.values[productionCandidateIndex]!
      for (let kappaIndex = 0; kappaIndex < SESSION_EXPERT_KAPPAS.length; kappaIndex++) {
        const kappa = SESSION_EXPERT_KAPPAS[kappaIndex]!
        const predicted =
          first.currentSessionMean !== undefined && first.currentSessionCount > 0
            ? (kappa * durable + first.currentSessionCount * first.currentSessionMean) /
              (kappa + first.currentSessionCount)
            : durable
        addError(errorsFor(sessionExpertResults, kappaIndex)[split], predicted, actual)
      }
    }
  }
}
const sessionExpertRanking = [...sessionExpertResults.entries()]
  .map(([index, value]) => ({
    name: `session_expert_k${SESSION_EXPERT_KAPPAS[index]}`,
    kappa: SESSION_EXPERT_KAPPAS[index]!,
    tune: summarize(value.tune),
    test: summarize(value.test),
  }))
  .sort((a, b) => a.tune.meanAbsLog - b.tune.meanAbsLog)

type StoppingObservation = {
  readonly split: "tune" | "test"
  readonly budget: number
  readonly predicted: number
  readonly actual: number
  readonly effectiveSamples: number
}

function selectedEvidence(prediction: Prediction, candidate: Candidate) {
  const halfLife = candidate.halfLife ?? 8
  if (candidate.family === "hier" || candidate.family === "overlay") {
    return prediction.accountObservations > 0
      ? prediction.accountSessionESS[halfLife] ?? 0
      : prediction.baseSessionESS[halfLife] ?? 0
  }
  return prediction.baseSessionESS[halfLife] ?? 0
}

function stoppingObservations(index: number, candidate: Candidate) {
  const observations: StoppingObservation[] = []
  for (const group of predictionsByAccount.values()) {
    for (let start = 0; start < group.length; start++) {
      const first = group[start]!
      const predictedMean = first.values[index]!
      if (!(predictedMean > 0)) continue

      for (const budget of STOPPING_BUDGETS) {
        let cumulative = 0
        let actualCount = 0
        for (let cursor = start; cursor < group.length; cursor++) {
          cumulative += group[cursor]!.actual
          actualCount++
          if (cumulative >= budget) break
        }
        if (cumulative < budget) continue

        const last = group[start + actualCount - 1]!
        const split =
          first.index < boundary && last.index < boundary
            ? "tune"
            : first.index >= boundary
              ? "test"
              : undefined
        if (!split) continue
        observations.push({
          split,
          budget,
          predicted: budget / predictedMean,
          actual: actualCount,
          effectiveSamples: selectedEvidence(first, candidate),
        })
      }
    }
  }
  return observations
}

function essBucket(value: number) {
  if (!(value > 0)) return "ess=0"
  if (value < 1.5) return "ess<1.5"
  if (value < 3) return "ess<3"
  if (value < 6) return "ess<6"
  if (value < 12) return "ess<12"
  return "ess>=12"
}

function evidenceBand(value: number) {
  return value >= 12 ? "mature" as const : "learning" as const
}

function empiricalCentralBounds(residuals: readonly number[]) {
  if (residuals.length === 0) return undefined
  const sorted = [...residuals].sort((a, b) => a - b)
  const alpha = 1 - PREDICTIVE_COVERAGE

  // Conservative finite-sample order statistics rather than interpolated
  // quantiles. Sparse calibration buckets therefore widen naturally instead of
  // manufacturing precision from fractional ranks.
  const lowerRank = Math.max(1, Math.floor((sorted.length + 1) * (alpha / 2)))
  const upperRank = Math.min(sorted.length, Math.ceil((sorted.length + 1) * (1 - alpha / 2)))
  return {
    low: sorted[lowerRank - 1]!,
    high: sorted[upperRank - 1]!,
  }
}

function calibratedStoppingRange(observations: readonly StoppingObservation[]) {
  const result: Record<string, unknown> = {}
  for (const budget of STOPPING_BUDGETS) {
    const tune = observations.filter((row) => row.budget === budget && row.split === "tune")
    const test = observations.filter((row) => row.budget === budget && row.split === "test")
    const residuals = tune.map((row) => Math.log(row.actual / row.predicted))
    const globalBounds = empiricalCentralBounds(residuals)!

    const tuneByEss = new Map<string, number[]>()
    for (const row of tune) {
      const key = essBucket(row.effectiveSamples)
      const values = tuneByEss.get(key) ?? []
      values.push(Math.log(row.actual / row.predicted))
      tuneByEss.set(key, values)
    }
    const boundsByEss = new Map(
      [...tuneByEss.entries()].flatMap(([key, values]) => {
        const bounds = empiricalCentralBounds(values)
        return bounds ? [[key, bounds] as const] : []
      }),
    )

    const tuneByBand = new Map<ReturnType<typeof evidenceBand>, number[]>()
    for (const row of tune) {
      const key = evidenceBand(row.effectiveSamples)
      const values = tuneByBand.get(key) ?? []
      values.push(Math.log(row.actual / row.predicted))
      tuneByBand.set(key, values)
    }
    const boundsByBand = new Map(
      [...tuneByBand.entries()].flatMap(([key, values]) => {
        const bounds = empiricalCentralBounds(values)
        return bounds ? [[key, bounds] as const] : []
      }),
    )

    const evaluate = (
      rows: readonly StoppingObservation[],
      boundsFor: (row: StoppingObservation) => { low: number; high: number },
    ) => {
      let covered = 0
      let normalizedWidth = 0
      const byEss = new Map<string, { n: number; covered: number; width: number }>()
      for (const row of rows) {
        const bounds = boundsFor(row)
        const lower = Math.max(0, row.predicted * Math.exp(bounds.low))
        const upper = row.predicted * Math.exp(bounds.high)
        const isCovered = row.actual >= lower && row.actual <= upper
        if (isCovered) covered++
        normalizedWidth += (upper - lower) / Math.max(1, row.predicted)

        const key = essBucket(row.effectiveSamples)
        const bucket = byEss.get(key) ?? { n: 0, covered: 0, width: 0 }
        bucket.n++
        if (isCovered) bucket.covered++
        bucket.width += (upper - lower) / Math.max(1, row.predicted)
        byEss.set(key, bucket)
      }
      return {
        n: rows.length,
        empiricalCoverage: rows.length > 0 ? covered / rows.length : Number.NaN,
        meanNormalizedWidth: rows.length > 0 ? normalizedWidth / rows.length : Number.NaN,
        byEffectiveSamples: Object.fromEntries(
          [...byEss.entries()].map(([key, value]) => [key, {
            n: value.n,
            empiricalCoverage: value.n > 0 ? value.covered / value.n : Number.NaN,
            meanNormalizedWidth: value.n > 0 ? value.width / value.n : Number.NaN,
          }]),
        ),
      }
    }

    result[String(budget)] = {
      targetCoverage: PREDICTIVE_COVERAGE,
      tuneN: tune.length,
      global: {
        lowerMultiplier: Math.exp(globalBounds.low),
        upperMultiplier: Math.exp(globalBounds.high),
        test: evaluate(test, () => globalBounds),
      },
      conditionedByEffectiveSamples: {
        calibration: Object.fromEntries(
          [...boundsByEss.entries()].map(([key, bounds]) => [key, {
            tuneN: tuneByEss.get(key)?.length ?? 0,
            lowerMultiplier: Math.exp(bounds.low),
            upperMultiplier: Math.exp(bounds.high),
          }]),
        ),
        test: evaluate(test, (row) => boundsByEss.get(essBucket(row.effectiveSamples)) ?? globalBounds),
      },
      conditionedByEvidenceBand: {
        calibration: Object.fromEntries(
          [...boundsByBand.entries()].map(([key, bounds]) => [key, {
            tuneN: tuneByBand.get(key)?.length ?? 0,
            lowerMultiplier: Math.exp(bounds.low),
            upperMultiplier: Math.exp(bounds.high),
          }]),
        ),
        test: evaluate(test, (row) => boundsByBand.get(evidenceBand(row.effectiveSamples)) ?? globalBounds),
      },
    }
  }
  return result
}

const stopping = calibratedStoppingRange(
  stoppingObservations(productionCandidateIndex, productionCandidate),
)

const constrainedDiagnostics = [
  "session_h8_k0.5",
  "session_h8_k1",
  "overlay_h8_k0.5",
  "overlay_h8_k1",
  "hier_h8_kb0.5_ka1",
  "hier_h8_kb0.5_ka4",
  "hier_h8_kb0.5_ka8",
  "hier_h8_kb0.5_ka16",
].map((name) => ({
  name,
  accountFuture: ranked(accountHorizon).find((entry) => entry.name === name),
  coldStart: coldStart(predictionsByAccount.values(), name, true),
}))

console.log(JSON.stringify({
  corpus: {
    dbPath,
    docsModels: priors.length,
    sourceRows: rows.length,
    usableRows: usable.length,
    attributedRows: usable.filter((item) => item.accountID !== undefined).length,
    accountScopes: predictionsByAccount.size,
    modelScopes: predictionsByModel.size,
    tuneRows: boundary,
    testRows: usable.length - boundary,
  },
  methodology: {
    chronologicalTuneFraction: TUNE_FRACTION,
    futureMeanHorizonRequests: HORIZON,
    currentPricingReprice: true,
    productionSessionEvidence: "min(request ESS, contiguous-session-block ESS)",
    hierarchicalPosterior:
      "published prior -> session-aware personal base-model posterior -> session-aware account overlay posterior",
    fairAccountComparison: "all account-family candidates scored on the same account-group future sequences",
    predictiveRange:
      "chronological residual calibration against realized renewal stopping counts; no formal confidence label",
  },
  modelScopeFutureMean: familyWinners(modelHorizon),
  accountScopeFutureMean: familyWinners(accountHorizon),
  accountMacroFutureMean: {
    session: macroAccountRanking("session").slice(0, 10),
    overlay: macroAccountRanking("overlay").slice(0, 10),
    hierarchical: macroAccountRanking("hier").slice(0, 20),
  },
  accountScopeNextRequest: familyWinners(nextErrors),
  empiricalHierarchicalWinners: {
    rowWeighted: rowWeightedHierWinner,
    accountMacro: macroHierWinner,
  },
  productionCalibration: {
    constants: GO_CAPACITY_CALIBRATION,
    candidate: productionAccountFuture,
    selectionBasis:
      "h=8/base-kappa=1 are stable session-aware tuning choices; account-kappa=32 is deliberate regularization because only three independent account scopes exist in the tuning prefix",
    coldStartTest: coldStart(predictionsByAccount.values(), productionCandidateName, true),
  },
  accountHierarchyColdStartTradeoff: Object.fromEntries(
    ["hier_h8_kb0.5_ka1", "hier_h8_kb0.5_ka2", "hier_h8_kb0.5_ka4", "hier_h8_kb0.5_ka8", "hier_h8_kb0.5_ka16", "hier_h8_kb0.5_ka32"]
      .filter((name) => candidateIndex(name) >= 0)
      .map((name) => [name, coldStart(predictionsByAccount.values(), name, true)]),
  ),
  constrainedDiagnostics,
  currentSessionExpert: {
    durableBase: productionCandidateName,
    candidates: sessionExpertRanking,
  },
  stoppingTimeCalibration: {
    selectedMethod: productionCandidateName,
    targetCoverage: PREDICTIVE_COVERAGE,
    typicalRequestEquivalentBudgets: STOPPING_BUDGETS,
    ranges: stopping,
  },
}, null, 2))
