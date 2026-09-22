import { Database as BunDatabase } from "bun:sqlite"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { writeFileSync } from "node:fs"

type UsageRow = {
  message_id: string
  session_id: string
  provider_id: string
  model_id: string
  variant: string | null
  agent: string | null
  mode: string | null
  completed_at: number
  cost_usd: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
}

type ReplayRow = UsageRow & {
  baseModelID: string
  accountID?: string
  rawKey: string
  canonicalKey: string
  crossProviderKey: string
  workload: number
  priced: boolean
}

type RunningStats = {
  n: number
  sum: number
  sumSq: number
}

type Prediction = {
  actual: number
  predicted: number
}

type MetricSummary = {
  n: number
  meanAbsLog: number
  rmsle: number
  geometricBiasPct: number
  medianFactor: number
  p90Factor: number
}

type HorizonSummary = MetricSummary & {
  horizon: number
}

const HALF_LIVES = [8, 16, 32, 64, 128, 256, 512, 1024] as const
const KAPPAS = [2, 4, 8, 16, 32, 64, 128] as const
const RECENT_LIMIT = 200
const TUNE_FRACTION = 0.7
const HORIZONS = [1, 5, 20] as const

function parseArgs(argv: string[]) {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!value.startsWith("--")) continue
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      args.set(value, next)
      i++
    } else {
      args.set(value, "true")
    }
  }

  const defaultDb = CoreDatabase.path()
  const dbArg = args.get("--db")
  const db =
    !dbArg || dbArg === "default"
      ? defaultDb
      : dbArg === "main"
        ? join(dirname(defaultDb), "openfork-main.db")
        : isAbsolute(dbArg)
          ? dbArg
          : resolve(process.cwd(), dbArg)

  const outArg = args.get("--out")
  const out = outArg ? (isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg)) : undefined
  const includeMaintenance = args.get("--include-maintenance") === "true"

  return { db, out, includeMaintenance }
}

function isMaintenance(row: UsageRow) {
  return row.mode === "compaction" || row.agent === "compaction" || row.agent === "summary"
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function toReplayRow(row: UsageRow): ReplayRow {
  const identity = splitAccountModelID(row.model_id)
  const baseModelID = identity.baseModelID
  const workload =
    finiteNonNegative(row.input_tokens) +
    finiteNonNegative(row.cache_read_tokens) +
    finiteNonNegative(row.cache_write_tokens) +
    finiteNonNegative(row.output_tokens) +
    finiteNonNegative(row.reasoning_tokens)

  return {
    ...row,
    baseModelID,
    accountID: identity.accountID,
    rawKey: `${row.provider_id}:${row.model_id}`,
    canonicalKey: `${row.provider_id}:${baseModelID}`,
    crossProviderKey: baseModelID,
    workload: Math.max(1, workload),
    priced: Number.isFinite(row.cost_usd) && row.cost_usd > 0,
  }
}

function statsMean(stats: RunningStats | undefined) {
  return stats && stats.n > 0 ? stats.sum / stats.n : undefined
}

function updateStats(map: Map<string, RunningStats>, key: string, value: number) {
  const stats = map.get(key)
  if (stats) {
    stats.n++
    stats.sum += value
    stats.sumSq += value * value
    return
  }
  map.set(key, { n: 1, sum: value, sumSq: value * value })
}

function subtractStats(total: RunningStats | undefined, part: RunningStats | undefined): RunningStats | undefined {
  if (!total) return undefined
  const n = total.n - (part?.n ?? 0)
  if (n <= 0) return undefined
  return {
    n,
    sum: total.sum - (part?.sum ?? 0),
    sumSq: total.sumSq - (part?.sumSq ?? 0),
  }
}

class RecentMean {
  readonly #limit: number
  readonly #values = new Map<string, number[]>()
  readonly #sums = new Map<string, number>()

  constructor(limit = RECENT_LIMIT) {
    this.#limit = limit
  }

  get(key: string) {
    const values = this.#values.get(key)
    if (!values || values.length === 0) return undefined
    return (this.#sums.get(key) ?? 0) / values.length
  }

  count(key: string) {
    return this.#values.get(key)?.length ?? 0
  }

  update(key: string, value: number) {
    const values = this.#values.get(key) ?? []
    let sum = this.#sums.get(key) ?? 0
    values.push(value)
    sum += value
    if (values.length > this.#limit) {
      const removed = values.shift()
      if (removed !== undefined) sum -= removed
    }
    this.#values.set(key, values)
    this.#sums.set(key, sum)
  }
}

class EwmaMean {
  readonly #rho: number
  readonly #state = new Map<string, { weight: number; sum: number }>()

  constructor(halfLife: number) {
    this.#rho = 0.5 ** (1 / halfLife)
  }

  get(key: string) {
    const state = this.#state.get(key)
    return state && state.weight > 0 ? state.sum / state.weight : undefined
  }

  update(key: string, value: number) {
    const state = this.#state.get(key)
    if (!state) {
      this.#state.set(key, { weight: 1, sum: value })
      return
    }
    state.weight = this.#rho * state.weight + 1
    state.sum = this.#rho * state.sum + value
  }
}

class MetricCollector {
  readonly #errors = new Map<string, number[]>()
  readonly #signed = new Map<string, number[]>()

  add(method: string, actual: number, predicted: number | undefined) {
    if (!(actual > 0) || !(predicted !== undefined && predicted > 0) || !Number.isFinite(predicted)) return
    const signed = Math.log(predicted / actual)
    const abs = Math.abs(signed)
    const errors = this.#errors.get(method) ?? []
    const signedErrors = this.#signed.get(method) ?? []
    errors.push(abs)
    signedErrors.push(signed)
    this.#errors.set(method, errors)
    this.#signed.set(method, signedErrors)
  }

  summary(method: string): MetricSummary {
    const errors = this.#errors.get(method) ?? []
    const signed = this.#signed.get(method) ?? []
    if (errors.length === 0) {
      return {
        n: 0,
        meanAbsLog: Number.POSITIVE_INFINITY,
        rmsle: Number.POSITIVE_INFINITY,
        geometricBiasPct: Number.NaN,
        medianFactor: Number.NaN,
        p90Factor: Number.NaN,
      }
    }
    const sorted = [...errors].sort((a, b) => a - b)
    const meanAbsLog = errors.reduce((sum, value) => sum + value, 0) / errors.length
    const rmsle = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length)
    const meanSigned = signed.reduce((sum, value) => sum + value, 0) / signed.length
    return {
      n: errors.length,
      meanAbsLog,
      rmsle,
      geometricBiasPct: (Math.exp(meanSigned) - 1) * 100,
      medianFactor: Math.exp(quantile(sorted, 0.5)),
      p90Factor: Math.exp(quantile(sorted, 0.9)),
    }
  }

  methods() {
    return [...this.#errors.keys()]
  }
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return Number.NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  const weight = pos - lo
  return sorted[lo] * (1 - weight) + sorted[hi] * weight
}

function exactSampleBucket(n: number) {
  if (n === 0) return "0"
  if (n === 1) return "1"
  if (n === 2) return "2"
  if (n <= 4) return "3-4"
  if (n <= 9) return "5-9"
  if (n <= 19) return "10-19"
  if (n <= 49) return "20-49"
  if (n <= 199) return "50-199"
  return "200+"
}

type TargetState = {
  exactRaw: Map<string, RunningStats>
  exactCanonical: Map<string, RunningStats>
  crossProvider: Map<string, RunningStats>
  provider: Map<string, RunningStats>
  global: RunningStats
  recentRaw: RecentMean
  recentCanonical: RecentMean
  ewmas: Map<number, EwmaMean>
}

function makeTargetState(): TargetState {
  return {
    exactRaw: new Map(),
    exactCanonical: new Map(),
    crossProvider: new Map(),
    provider: new Map(),
    global: { n: 0, sum: 0, sumSq: 0 },
    recentRaw: new RecentMean(),
    recentCanonical: new RecentMean(),
    ewmas: new Map(HALF_LIVES.map((halfLife) => [halfLife, new EwmaMean(halfLife)])),
  }
}

function updateGlobal(stats: RunningStats, value: number) {
  stats.n++
  stats.sum += value
  stats.sumSq += value * value
}

function priorFor(row: ReplayRow, state: TargetState) {
  const exact = state.exactCanonical.get(row.canonicalKey)

  const crossTotal = state.crossProvider.get(row.crossProviderKey)
  const crossOther = subtractStats(crossTotal, exact)
  const crossMean = statsMean(crossOther)
  if (crossMean !== undefined) return { mean: crossMean, source: "cross-provider-model" as const }

  const providerTotal = state.provider.get(row.provider_id)
  const providerOther = subtractStats(providerTotal, exact)
  const providerMean = statsMean(providerOther)
  if (providerMean !== undefined) return { mean: providerMean, source: "provider" as const }

  if (state.global.n > 0) return { mean: state.global.sum / state.global.n, source: "global" as const }
  return undefined
}

function hierarchicalPrediction(row: ReplayRow, state: TargetState, kappa: number) {
  const exact = state.exactCanonical.get(row.canonicalKey)
  const prior = priorFor(row, state)

  if (!exact || exact.n === 0) return prior?.mean
  const exactMean = exact.sum / exact.n
  if (!prior) return exactMean
  return (kappa * prior.mean + exact.sum) / (kappa + exact.n)
}

function predictMethods(row: ReplayRow, state: TargetState) {
  const out = new Map<string, number | undefined>()
  out.set("recent200_raw", state.recentRaw.get(row.rawKey))
  out.set("recent200_canonical", state.recentCanonical.get(row.canonicalKey))
  out.set("lifetime_canonical", statsMean(state.exactCanonical.get(row.canonicalKey)))
  out.set("prior_only", priorFor(row, state)?.mean)
  for (const halfLife of HALF_LIVES) {
    out.set(`ewma_${halfLife}`, state.ewmas.get(halfLife)?.get(row.canonicalKey))
  }
  for (const kappa of KAPPAS) {
    out.set(`hier_${kappa}`, hierarchicalPrediction(row, state, kappa))
  }
  return out
}

function updateTarget(row: ReplayRow, state: TargetState, value: number) {
  updateStats(state.exactRaw, row.rawKey, value)
  updateStats(state.exactCanonical, row.canonicalKey, value)
  updateStats(state.crossProvider, row.crossProviderKey, value)
  updateStats(state.provider, row.provider_id, value)
  updateGlobal(state.global, value)
  state.recentRaw.update(row.rawKey, value)
  state.recentCanonical.update(row.canonicalKey, value)
  for (const ewma of state.ewmas.values()) ewma.update(row.canonicalKey, value)
}

function loadRows(dbPath: string, includeMaintenance: boolean) {
  const db = new BunDatabase(dbPath, { readonly: true, create: false, strict: true })
  try {
    const exists = db
      .query<{ ok: number }, []>("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='usage_record'")
      .get()
    if (!exists) throw new Error(`usage_record does not exist in ${dbPath}`)

    const rows = db
      .query<UsageRow, []>(
        `SELECT
           message_id, session_id, provider_id, model_id, variant, agent, mode,
           completed_at, cost_usd,
           input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
         FROM usage_record
         ORDER BY completed_at ASC, message_id ASC`,
      )
      .all()

    return rows.filter((row) => includeMaintenance || !isMaintenance(row)).map(toReplayRow)
  } finally {
    db.close()
  }
}

function summarizeFragmentation(rows: ReplayRow[]) {
  const rawKeys = new Set<string>()
  const canonicalKeys = new Set<string>()
  const groups = new Map<
    string,
    { providerID: string; baseModelID: string; rows: number; rawIDs: Map<string, number>; accounts: Set<string> }
  >()

  let qualifiedRows = 0
  for (const row of rows) {
    rawKeys.add(row.rawKey)
    canonicalKeys.add(row.canonicalKey)
    if (row.accountID) qualifiedRows++

    const group = groups.get(row.canonicalKey) ?? {
      providerID: row.provider_id,
      baseModelID: row.baseModelID,
      rows: 0,
      rawIDs: new Map<string, number>(),
      accounts: new Set<string>(),
    }
    group.rows++
    group.rawIDs.set(row.model_id, (group.rawIDs.get(row.model_id) ?? 0) + 1)
    if (row.accountID) group.accounts.add(row.accountID)
    groups.set(row.canonicalKey, group)
  }

  const fragmented = [...groups.values()]
    .filter((group) => group.rawIDs.size > 1 || group.accounts.size > 0)
    .sort((a, b) => b.rows - a.rows)
    .slice(0, 30)
    .map((group) => ({
      providerID: group.providerID,
      baseModelID: group.baseModelID,
      rows: group.rows,
      rawIDCount: group.rawIDs.size,
      accountCount: group.accounts.size,
      rawIDs: [...group.rawIDs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([modelID, count]) => ({ modelID, count })),
    }))

  return {
    rawModelKeys: rawKeys.size,
    canonicalModelKeys: canonicalKeys.size,
    qualifiedRows,
    qualifiedFraction: rows.length > 0 ? qualifiedRows / rows.length : 0,
    topFragmentedGroups: fragmented,
  }
}

type SweepResult = {
  tune: Record<string, MetricSummary>
  test: Record<string, MetricSummary>
  coldStartTest: Record<string, Record<string, MetricSummary>>
}

function runSweep(rows: ReplayRow[], target: "workload" | "cost"): SweepResult {
  const state = makeTargetState()
  const tune = new MetricCollector()
  const test = new MetricCollector()
  const cold = new Map<string, MetricCollector>()
  const tuneBoundary = Math.floor(rows.length * TUNE_FRACTION)

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (target === "cost" && !row.priced) continue
    const value = target === "cost" ? row.cost_usd : row.workload
    if (!(value > 0)) continue

    const exactCount = state.exactCanonical.get(row.canonicalKey)?.n ?? 0
    const predictions = predictMethods(row, state)
    const collector = index < tuneBoundary ? tune : test

    for (const [method, predicted] of predictions) {
      collector.add(method, value, predicted)
      if (index >= tuneBoundary) {
        const bucket = exactSampleBucket(exactCount)
        const bucketCollector = cold.get(bucket) ?? new MetricCollector()
        bucketCollector.add(method, value, predicted)
        cold.set(bucket, bucketCollector)
      }
    }

    updateTarget(row, state, value)
  }

  const summarize = (collector: MetricCollector) =>
    Object.fromEntries(collector.methods().sort().map((method) => [method, collector.summary(method)]))

  return {
    tune: summarize(tune),
    test: summarize(test),
    coldStartTest: Object.fromEntries(
      [...cold.entries()].map(([bucket, collector]) => [bucket, summarize(collector)]),
    ),
  }
}

function bestMethod(
  metrics: Record<string, MetricSummary>,
  prefix: string,
): { method: string; metrics: MetricSummary } | undefined {
  const candidates = Object.entries(metrics)
    .filter(([method, summary]) => method.startsWith(prefix) && summary.n >= 50 && Number.isFinite(summary.meanAbsLog))
    .sort((a, b) => a[1].meanAbsLog - b[1].meanAbsLog)
  const first = candidates[0]
  return first ? { method: first[0], metrics: first[1] } : undefined
}

type HorizonRecord = {
  actual: number
  predicted: Record<string, number | undefined>
}

function runSelectedReplay(
  rows: ReplayRow[],
  target: "workload" | "cost",
  selectedMethods: string[],
): Record<string, Record<string, HorizonSummary>> {
  const state = makeTargetState()
  const byKey = new Map<string, HorizonRecord[]>()

  for (const row of rows) {
    if (target === "cost" && !row.priced) continue
    const value = target === "cost" ? row.cost_usd : row.workload
    if (!(value > 0)) continue

    const all = predictMethods(row, state)
    const predictions = Object.fromEntries(selectedMethods.map((method) => [method, all.get(method)]))
    const list = byKey.get(row.canonicalKey) ?? []
    list.push({ actual: value, predicted: predictions })
    byKey.set(row.canonicalKey, list)

    updateTarget(row, state, value)
  }

  const result: Record<string, Record<string, HorizonSummary>> = {}

  for (const horizon of HORIZONS) {
    const collectors = new Map<string, MetricCollector>()
    for (const method of selectedMethods) collectors.set(method, new MetricCollector())

    for (const list of byKey.values()) {
      const prefix = new Array(list.length + 1).fill(0)
      for (let i = 0; i < list.length; i++) prefix[i + 1] = prefix[i] + list[i].actual

      for (let i = 0; i < list.length; i++) {
        const end = Math.min(list.length, i + horizon)
        if (end - i < horizon) continue
        const futureMean = (prefix[end] - prefix[i]) / horizon
        for (const method of selectedMethods) {
          collectors.get(method)?.add(method, futureMean, list[i].predicted[method])
        }
      }
    }

    result[String(horizon)] = Object.fromEntries(
      selectedMethods.map((method) => [
        method,
        { ...collectors.get(method)!.summary(method), horizon },
      ]),
    )
  }

  return result
}

function sessionDependence(rows: ReplayRow[]) {
  const groups = new Map<string, Map<string, number[]>>()
  for (const row of rows) {
    const model = groups.get(row.canonicalKey) ?? new Map<string, number[]>()
    const values = model.get(row.session_id) ?? []
    values.push(Math.log(row.workload))
    model.set(row.session_id, values)
    groups.set(row.canonicalKey, model)
  }

  const out: Array<{
    key: string
    requests: number
    sessions: number
    meanRequestsPerSession: number
    icc: number
    designEffect: number
    effectiveSamples: number
  }> = []

  for (const [key, sessions] of groups) {
    const sessionEntries = [...sessions.values()]
    const requests = sessionEntries.reduce((sum, values) => sum + values.length, 0)
    if (requests < 100 || sessionEntries.length < 5) continue

    const all = sessionEntries.flat()
    const grand = all.reduce((sum, value) => sum + value, 0) / all.length
    const totalVar = all.reduce((sum, value) => sum + (value - grand) ** 2, 0) / Math.max(1, all.length - 1)
    if (!(totalVar > 0)) continue

    let betweenNumerator = 0
    let withinNumerator = 0
    let withinDf = 0
    for (const values of sessionEntries) {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      betweenNumerator += values.length * (mean - grand) ** 2
      for (const value of values) withinNumerator += (value - mean) ** 2
      withinDf += Math.max(0, values.length - 1)
    }

    const between = betweenNumerator / Math.max(1, sessionEntries.length - 1)
    const within = withinNumerator / Math.max(1, withinDf)
    const meanClusterSize = requests / sessionEntries.length
    const tau = Math.max(0, (between - within) / Math.max(1, meanClusterSize))
    const icc = Math.max(0, Math.min(0.999, tau / (tau + within)))
    const designEffect = 1 + Math.max(0, meanClusterSize - 1) * icc
    const effectiveSamples = requests / designEffect

    out.push({
      key,
      requests,
      sessions: sessionEntries.length,
      meanRequestsPerSession: meanClusterSize,
      icc,
      designEffect,
      effectiveSamples,
    })
  }

  return out.sort((a, b) => b.requests - a.requests).slice(0, 50)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = performance.now()
  const rows = loadRows(options.db, options.includeMaintenance)
  if (rows.length === 0) throw new Error(`No user-facing usage rows found in ${options.db}`)

  const pricedRows = rows.filter((row) => row.priced)
  const workload = runSweep(rows, "workload")
  const cost = runSweep(rows, "cost")

  const selectedWorkloadEwma = bestMethod(workload.tune, "ewma_")
  const selectedWorkloadHierarchy = bestMethod(workload.tune, "hier_")
  const selectedCostEwma = bestMethod(cost.tune, "ewma_")
  const selectedCostHierarchy = bestMethod(cost.tune, "hier_")

  const workloadMethods = [
    "recent200_raw",
    "recent200_canonical",
    "lifetime_canonical",
    selectedWorkloadEwma?.method,
    selectedWorkloadHierarchy?.method,
  ].filter((value): value is string => !!value)

  const costMethods = [
    "recent200_raw",
    "recent200_canonical",
    "lifetime_canonical",
    selectedCostEwma?.method,
    selectedCostHierarchy?.method,
  ].filter((value): value is string => !!value)

  const report = {
    version: 1,
    generatedAt: Date.now(),
    db: options.db,
    corpus: {
      rows: rows.length,
      pricedRows: pricedRows.length,
      sessions: new Set(rows.map((row) => row.session_id)).size,
      providers: new Set(rows.map((row) => row.provider_id)).size,
      firstCompletedAt: rows[0]?.completed_at,
      lastCompletedAt: rows.at(-1)?.completed_at,
      tuneFraction: TUNE_FRACTION,
      maintenanceIncluded: options.includeMaintenance,
    },
    identity: summarizeFragmentation(rows),
    workload: {
      target: "sum(input + cacheRead + cacheWrite + output + reasoning)",
      sweep: workload,
      selected: {
        ewma: selectedWorkloadEwma,
        hierarchy: selectedWorkloadHierarchy,
      },
      futureMean: runSelectedReplay(rows, "workload", workloadMethods),
    },
    cost: {
      target: "positive recorded cost_usd only",
      sweep: cost,
      selected: {
        ewma: selectedCostEwma,
        hierarchy: selectedCostHierarchy,
      },
      futureMean: runSelectedReplay(rows, "cost", costMethods),
    },
    sessionDependence: sessionDependence(rows),
    elapsedMs: performance.now() - startedAt,
  }

  const compact = {
    corpus: report.corpus,
    identity: {
      rawModelKeys: report.identity.rawModelKeys,
      canonicalModelKeys: report.identity.canonicalModelKeys,
      qualifiedRows: report.identity.qualifiedRows,
      qualifiedFraction: report.identity.qualifiedFraction,
      topFragmentedGroups: report.identity.topFragmentedGroups.slice(0, 8),
    },
    selected: {
      workload: report.workload.selected,
      cost: report.cost.selected,
    },
    workloadTest: Object.fromEntries(
      workloadMethods.map((method) => [method, report.workload.sweep.test[method]]),
    ),
    workloadFutureMean: report.workload.futureMean,
    costTest: Object.fromEntries(costMethods.map((method) => [method, report.cost.sweep.test[method]])),
    costFutureMean: report.cost.futureMean,
    sessionDependence: report.sessionDependence.slice(0, 10),
    elapsedMs: report.elapsedMs,
  }

  console.log(JSON.stringify(compact, null, 2))

  if (options.out) {
    writeFileSync(options.out, JSON.stringify(report, null, 2) + "\n", "utf8")
    console.error(`Wrote ${options.out}`)
  }
}

main()
