import { Database as BunDatabase } from "bun:sqlite"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import {
  effectiveSamples,
  meanVector,
  momentsFor,
  observeYieldStatistic,
  sessionMomentsFor,
  snapshotYieldStatistic,
  type YieldStatisticState,
} from "@opencode-ai/core/usage/yield-statistics"
import { FALLBACK_WORKLOAD_CORPUS } from "@opencode-ai/schema/model-select/usage-yield"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import { dirname, isAbsolute, join, resolve } from "node:path"

type UsageRow = {
  session_id: string
  provider_id: string
  model_id: string
  agent: string | null
  mode: string | null
  completed_at: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
}

type CatalogModel = {
  family?: string
  limit?: { context?: number; input?: number; output?: number }
}

type Donor = {
  key: string
  providerID: string
  modelID: string
  family?: string
  promptScale: number
  generationScale: number
  cacheShare: number
  reasoningShare: number
  promptMean: number
  generationMean: number
  ess: number
}

type Prediction = {
  prompt: number
  generation: number
  cacheShare: number
  reasoningShare: number
  donors: number
  weight: number
}

type ColdCase = {
  key: string
  providerID: string
  modelID: string
  family?: string
  firstSeenAt: number
  contextLimit?: number
  actual: Record<number, { prompt: number; generation: number; total: number }>
  predictions: Map<string, Prediction>
}

const HORIZONS = [1, 5, 20] as const
const HALF_LIFE = 8 as const
const EPS = 1e-9

function parseArgs(argv: string[]) {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!value?.startsWith("--")) continue
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      args.set(value, next)
      i++
    } else args.set(value, "true")
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
  return { db }
}

function median(values: readonly number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function promptTokens(row: UsageRow) {
  return (
    finiteNonNegative(row.input_tokens) +
    finiteNonNegative(row.cache_read_tokens) +
    finiteNonNegative(row.cache_write_tokens)
  )
}

function generationTokens(row: UsageRow) {
  return finiteNonNegative(row.output_tokens) + finiteNonNegative(row.reasoning_tokens)
}

function isUserFacing(row: UsageRow) {
  return row.mode !== "compaction" && row.agent !== "compaction" && row.agent !== "summary" && row.mode !== "maintenance"
}

function loadRows(dbPath: string) {
  const db = new BunDatabase(dbPath, { readonly: true, create: false, strict: true })
  try {
    return db
      .query<UsageRow, []>(
        `SELECT
           session_id, provider_id, model_id, agent, mode, completed_at,
           input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
         FROM usage_record
         ORDER BY completed_at ASC, message_id ASC`,
      )
      .all()
      .filter(isUserFacing)
  } finally {
    db.close()
  }
}

async function loadCatalog(): Promise<Record<string, { models?: Record<string, CatalogModel> }>> {
  try {
    return await Bun.file(join(Global.Path.cache, "models.json")).json()
  } catch {
    return {}
  }
}

function canonical(row: UsageRow) {
  const split = splitAccountModelID(row.model_id)
  return {
    providerID: row.provider_id,
    modelID: split.baseModelID,
    key: `${row.provider_id}:${split.baseModelID}`,
  }
}

function modelMetadata(
  catalog: Record<string, { models?: Record<string, CatalogModel> }>,
  providerID: string,
  modelID: string,
) {
  const direct = catalog[providerID]?.models?.[modelID]
  if (direct) return direct
  const matches: CatalogModel[] = []
  for (const provider of Object.values(catalog)) {
    const candidate = provider.models?.[modelID]
    if (candidate) matches.push(candidate)
  }
  if (matches.length === 0) return undefined
  const family = matches.map((model) => model.family).find(Boolean)
  const limits = matches.map((model) => model.limit).filter(Boolean) as NonNullable<CatalogModel["limit"]>[]
  return {
    ...(family ? { family } : {}),
    ...(limits.length
      ? {
          limit: {
            context: Math.max(...limits.map((value) => value.context ?? 0)),
            input: Math.max(...limits.map((value) => value.input ?? 0)),
            output: Math.max(...limits.map((value) => value.output ?? 0)),
          },
        }
      : {}),
  } satisfies CatalogModel
}

const STANDARD_PROMPT = median(FALLBACK_WORKLOAD_CORPUS.map((row) => row.contextTokens))
const STANDARD_GENERATION = median(FALLBACK_WORKLOAD_CORPUS.map((row) => row.outputTokens))
const STANDARD_CACHE_SHARE = median(
  FALLBACK_WORKLOAD_CORPUS.map((row) =>
    row.contextTokens > 0 ? row.cachedReadTokens / row.contextTokens : 0,
  ),
)

function donorFromState(
  key: string,
  providerID: string,
  modelID: string,
  family: string | undefined,
  state: YieldStatisticState,
): Donor | undefined {
  const snapshot = snapshotYieldStatistic(state)
  const request = momentsFor(snapshot, HALF_LIFE)
  const sessions = sessionMomentsFor(snapshot, HALF_LIFE)
  if (!request || !sessions) return undefined
  const mean = meanVector(request)
  if (!mean) return undefined
  const prompt = (mean[0] ?? 0) + (mean[1] ?? 0) + (mean[2] ?? 0)
  const generation = (mean[3] ?? 0) + (mean[4] ?? 0)
  const ess = Math.min(effectiveSamples(request), effectiveSamples(sessions))
  if (!(prompt > 0) || !(generation > 0) || !(ess > 0)) return undefined
  return {
    key,
    providerID,
    modelID,
    ...(family ? { family } : {}),
    promptScale: prompt / STANDARD_PROMPT,
    generationScale: generation / STANDARD_GENERATION,
    cacheShare: Math.max(0, Math.min(1, (mean[1] ?? 0) / prompt)),
    reasoningShare: Math.max(0, Math.min(1, (mean[4] ?? 0) / generation)),
    promptMean: prompt,
    generationMean: generation,
    ess,
  }
}

function aggregate(
  donors: readonly Donor[],
  weightCap: number,
  kappa: number,
  targetContext?: number,
): Prediction | undefined {
  if (donors.length === 0) return undefined
  let weight = 0
  let promptLog = 0
  let generationLog = 0
  let cache = 0
  let reasoning = 0
  for (const donor of donors) {
    const w = Math.min(weightCap, donor.ess)
    if (!(w > 0)) continue
    weight += w
    promptLog += w * Math.log(Math.max(EPS, donor.promptScale))
    generationLog += w * Math.log(Math.max(EPS, donor.generationScale))
    cache += w * donor.cacheShare
    reasoning += w * donor.reasoningShare
  }
  if (!(weight > 0)) return undefined
  const shrink = weight / (weight + kappa)
  const promptScale = Math.exp((promptLog / weight) * shrink)
  const generationScale = Math.exp((generationLog / weight) * shrink)
  const cacheShare = (cache + kappa * STANDARD_CACHE_SHARE) / (weight + kappa)
  const reasoningShare = reasoning / (weight + kappa)
  let prompt = STANDARD_PROMPT * promptScale
  let generation = STANDARD_GENERATION * generationScale
  if (targetContext && targetContext > 0) {
    const maxPrompt = Math.max(1, targetContext - generation)
    prompt = Math.min(prompt, maxPrompt)
  }
  return {
    prompt,
    generation,
    cacheShare,
    reasoningShare,
    donors: donors.length,
    weight,
  }
}

function rawAggregate(donors: readonly Donor[], targetContext?: number): Prediction | undefined {
  if (donors.length === 0) return undefined
  let prompt = donors.reduce((sum, donor) => sum + donor.promptMean, 0) / donors.length
  const generation = donors.reduce((sum, donor) => sum + donor.generationMean, 0) / donors.length
  const cacheShare = donors.reduce((sum, donor) => sum + donor.cacheShare, 0) / donors.length
  const reasoningShare = donors.reduce((sum, donor) => sum + donor.reasoningShare, 0) / donors.length
  if (targetContext && targetContext > 0) prompt = Math.min(prompt, Math.max(1, targetContext - generation))
  return { prompt, generation, cacheShare, reasoningShare, donors: donors.length, weight: donors.length }
}

function medianAggregate(donors: readonly Donor[], shrink: number, targetContext?: number): Prediction | undefined {
  if (donors.length === 0) return undefined
  const promptScale =
    Math.exp(median(donors.map((donor) => Math.log(Math.max(EPS, donor.promptScale)))) * shrink)
  const generationScale =
    Math.exp(median(donors.map((donor) => Math.log(Math.max(EPS, donor.generationScale)))) * shrink)
  let prompt = STANDARD_PROMPT * promptScale
  const generation = STANDARD_GENERATION * generationScale
  if (targetContext && targetContext > 0) prompt = Math.min(prompt, Math.max(1, targetContext - generation))
  return {
    prompt,
    generation,
    cacheShare: median(donors.map((donor) => donor.cacheShare)),
    reasoningShare: median(donors.map((donor) => donor.reasoningShare)),
    donors: donors.length,
    weight: donors.length,
  }
}

function metric(values: readonly { predicted: number; actual: number }[]) {
  const usable = values.filter((item) => item.predicted > 0 && item.actual > 0)
  if (usable.length === 0) return undefined
  const signed = usable.map((item) => Math.log(item.predicted / item.actual))
  const absolute = signed.map(Math.abs).sort((a, b) => a - b)
  const meanAbsLog = absolute.reduce((sum, value) => sum + value, 0) / absolute.length
  const rmsle = Math.sqrt(signed.reduce((sum, value) => sum + value * value, 0) / signed.length)
  const bias = Math.exp(signed.reduce((sum, value) => sum + value, 0) / signed.length) - 1
  const quantile = (q: number) => {
    const pos = (absolute.length - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    const mix = pos - lo
    return absolute[lo]! * (1 - mix) + absolute[hi]! * mix
  }
  return {
    n: usable.length,
    meanAbsLog,
    rmsle,
    geometricBiasPct: bias * 100,
    medianFactor: Math.exp(quantile(0.5)),
    p90Factor: Math.exp(quantile(0.9)),
  }
}

function predictionFor(item: ColdCase, name: string) {
  return item.predictions.get(name) ?? item.predictions.get("standard")
}

function summarize(cases: readonly ColdCase[], name: string, horizon: number) {
  const total = cases.flatMap((item) => {
    const prediction = predictionFor(item, name)
    const actual = item.actual[horizon]
    return prediction && actual ? [{ predicted: prediction.prompt + prediction.generation, actual: actual.total }] : []
  })
  const prompt = cases.flatMap((item) => {
    const prediction = predictionFor(item, name)
    const actual = item.actual[horizon]
    return prediction && actual ? [{ predicted: prediction.prompt, actual: actual.prompt }] : []
  })
  const generation = cases.flatMap((item) => {
    const prediction = predictionFor(item, name)
    const actual = item.actual[horizon]
    return prediction && actual ? [{ predicted: prediction.generation, actual: actual.generation }] : []
  })
  return {
    total: metric(total),
    prompt: metric(prompt),
    generation: metric(generation),
  }
}

function summarizeHybrid(
  cases: readonly ColdCase[],
  promptName: string,
  generationName: string,
  horizon: number,
) {
  const total = cases.flatMap((item) => {
    const promptPrediction = predictionFor(item, promptName)
    const generationPrediction = predictionFor(item, generationName)
    const actual = item.actual[horizon]
    return promptPrediction && generationPrediction && actual
      ? [{ predicted: promptPrediction.prompt + generationPrediction.generation, actual: actual.total }]
      : []
  })
  const prompt = cases.flatMap((item) => {
    const prediction = predictionFor(item, promptName)
    const actual = item.actual[horizon]
    return prediction && actual ? [{ predicted: prediction.prompt, actual: actual.prompt }] : []
  })
  const generation = cases.flatMap((item) => {
    const prediction = predictionFor(item, generationName)
    const actual = item.actual[horizon]
    return prediction && actual ? [{ predicted: prediction.generation, actual: actual.generation }] : []
  })
  return {
    total: metric(total),
    prompt: metric(prompt),
    generation: metric(generation),
  }
}

async function main() {
  const { db } = parseArgs(process.argv.slice(2))
  const rows = loadRows(db)
  if (rows.length === 0) throw new Error(`No user-facing rows in ${db}`)
  const catalog = await loadCatalog()
  const grouped = new Map<string, UsageRow[]>()
  for (const row of rows) {
    const id = canonical(row)
    const list = grouped.get(id.key)
    if (list) list.push(row)
    else grouped.set(id.key, [row])
  }

  const state = new Map<string, YieldStatisticState>()
  const metadata = new Map<string, { providerID: string; modelID: string; family?: string; contextLimit?: number }>()
  const cases: ColdCase[] = []
  const seen = new Set<string>()
  const configs = [
    ...[1, 2, 4, 8].flatMap((weightCap) =>
      [1, 2, 4, 8].flatMap((kappa) =>
        ["global", "provider", "family", "same-base", "hier"].map((scope) => ({
          name: `${scope}:cap${weightCap}:k${kappa}`,
          scope,
          weightCap,
          kappa,
        })),
      ),
    ),
  ]

  for (const row of rows) {
    const id = canonical(row)
    let meta = metadata.get(id.key)
    if (!meta) {
      const model = modelMetadata(catalog, id.providerID, id.modelID)
      meta = {
        providerID: id.providerID,
        modelID: id.modelID,
        ...(model?.family ? { family: model.family } : {}),
        ...(model?.limit?.context ? { contextLimit: model.limit.context } : {}),
      }
      metadata.set(id.key, meta)
    }

    if (!seen.has(id.key)) {
      seen.add(id.key)
      const donors: Donor[] = []
      for (const [donorKey, donorState] of state) {
        if (donorKey === id.key) continue
        const donorMeta = metadata.get(donorKey)
        if (!donorMeta) continue
        const donor = donorFromState(
          donorKey,
          donorMeta.providerID,
          donorMeta.modelID,
          donorMeta.family,
          donorState,
        )
        if (donor) donors.push(donor)
      }

      const predictions = new Map<string, Prediction>()
      predictions.set("standard", {
        prompt: meta.contextLimit
          ? Math.min(STANDARD_PROMPT, Math.max(1, meta.contextLimit - STANDARD_GENERATION))
          : STANDARD_PROMPT,
        generation: STANDARD_GENERATION,
        cacheShare: STANDARD_CACHE_SHARE,
        reasoningShare: 0,
        donors: 0,
        weight: 0,
      })
      const raw = rawAggregate(donors, meta.contextLimit)
      if (raw) predictions.set("raw-global", raw)
      for (const shrink of [0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 0.75, 1]) {
        const robust = medianAggregate(donors, shrink, meta.contextLimit)
        if (robust) predictions.set(`median-global:s${shrink}`, robust)
      }

      for (const config of configs) {
        const scoped = donors.filter((donor) => {
          if (config.scope === "global") return true
          if (config.scope === "provider") return donor.providerID === id.providerID
          if (config.scope === "family") return !!meta?.family && donor.family === meta.family
          if (config.scope === "same-base") return donor.modelID === id.modelID
          return false
        })
        let selected = scoped
        if (config.scope === "hier") {
          const sameBase = donors.filter((donor) => donor.modelID === id.modelID)
          const family = meta.family ? donors.filter((donor) => donor.family === meta!.family) : []
          const provider = donors.filter((donor) => donor.providerID === id.providerID)
          selected =
            sameBase.length > 0
              ? sameBase
              : family.length >= 2
                ? family
                : provider.length >= 2
                  ? provider
                  : donors
        }
        const prediction = aggregate(selected, config.weightCap, config.kappa, meta.contextLimit)
        if (prediction) predictions.set(config.name, prediction)
      }

      const actual: ColdCase["actual"] = {}
      const targetRows = grouped.get(id.key) ?? []
      for (const horizon of HORIZONS) {
        const sample = targetRows.slice(0, horizon)
        if (sample.length === 0) continue
        const prompt = sample.reduce((sum, value) => sum + promptTokens(value), 0) / sample.length
        const generation = sample.reduce((sum, value) => sum + generationTokens(value), 0) / sample.length
        actual[horizon] = { prompt, generation, total: prompt + generation }
      }
      cases.push({
        key: id.key,
        providerID: id.providerID,
        modelID: id.modelID,
        ...(meta.family ? { family: meta.family } : {}),
        firstSeenAt: row.completed_at,
        ...(meta.contextLimit ? { contextLimit: meta.contextLimit } : {}),
        actual,
        predictions,
      })
    }

    const observation = {
      sessionID: row.session_id,
      completedAt: row.completed_at,
      tokens: {
        input: row.input_tokens,
        cacheRead: row.cache_read_tokens,
        cacheWrite: row.cache_write_tokens,
        output: row.output_tokens,
        reasoning: row.reasoning_tokens,
      },
    }
    state.set(id.key, observeYieldStatistic(state.get(id.key), observation))
  }

  cases.sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.key.localeCompare(b.key))
  const split = Math.max(1, Math.floor(cases.length * 0.7))
  const tune = cases.slice(0, split)
  const held = cases.slice(split)
  const names = [
    "standard",
    "raw-global",
    "median-global:s0.05",
    "median-global:s0.1",
    "median-global:s0.15",
    "median-global:s0.2",
    "median-global:s0.25",
    "median-global:s0.5",
    "median-global:s0.75",
    "median-global:s1",
    ...configs.map((value) => value.name),
  ]

  const tuneRank = names
    .map((name) => ({
      name,
      coverage: tune.filter((item) => item.predictions.has(name)).length,
      summary: summarize(tune, name, 5),
    }))
    .filter((row) => row.summary.total)
    .sort((a, b) => a.summary.total!.meanAbsLog - b.summary.total!.meanAbsLog)
  const best = tuneRank[0]?.name ?? "standard"
  const tunePromptRank = [...tuneRank].sort(
    (a, b) => a.summary.prompt!.meanAbsLog - b.summary.prompt!.meanAbsLog,
  )
  const tuneGenerationRank = [...tuneRank].sort(
    (a, b) => a.summary.generation!.meanAbsLog - b.summary.generation!.meanAbsLog,
  )
  const bestPrompt = tunePromptRank[0]?.name ?? "standard"
  const bestGeneration = tuneGenerationRank[0]?.name ?? "standard"

  const report = {
    version: 1,
    db,
    corpus: {
      rows: rows.length,
      modelKeys: cases.length,
      tuneModels: tune.length,
      heldoutModels: held.length,
      providers: new Set(cases.map((item) => item.providerID)).size,
      standardPrompt: STANDARD_PROMPT,
      standardGeneration: STANDARD_GENERATION,
      standardCacheShare: STANDARD_CACHE_SHARE,
    },
    selectedOnTuneH5: best,
    selectedPromptOnTuneH5: bestPrompt,
    selectedGenerationOnTuneH5: bestGeneration,
    tuneTop10: tuneRank.slice(0, 10),
    candidateH5: Object.fromEntries(
      names.map((name) => [
        name,
        {
          coverage: tune.filter((item) => item.predictions.has(name)).length,
          tune: summarize(tune, name, 5),
          heldout: summarize(held, name, 5),
        },
      ]),
    ),
    tunePromptTop5: tunePromptRank.slice(0, 5),
    tuneGenerationTop5: tuneGenerationRank.slice(0, 5),
    heldout: Object.fromEntries(
      ["standard", "raw-global", best].map((name) => [
        name,
        Object.fromEntries(HORIZONS.map((horizon) => [horizon, summarize(held, name, horizon)])),
      ]),
    ),
    heldoutHybrid: Object.fromEntries(
      HORIZONS.map((horizon) => [
        horizon,
        summarizeHybrid(held, bestPrompt, bestGeneration, horizon),
      ]),
    ),
    diagnostics: Object.fromEntries(
      [
        "median-global:s0.25",
        "median-global:s0.5",
        "median-global:s0.75",
        "median-global:s1",
        "global:cap1:k8",
        "global:cap2:k8",
        "provider:cap1:k8",
        "hier:cap1:k8",
      ].map((name) => [
        name,
        {
          tuneCoverage: tune.filter((item) => item.predictions.has(name)).length,
          heldoutCoverage: held.filter((item) => item.predictions.has(name)).length,
          tune: Object.fromEntries(HORIZONS.map((horizon) => [horizon, summarize(tune, name, horizon)])),
          heldout: Object.fromEntries(HORIZONS.map((horizon) => [horizon, summarize(held, name, horizon)])),
        },
      ]),
    ),
    all: Object.fromEntries(
      ["standard", "raw-global", best].map((name) => [
        name,
        Object.fromEntries(HORIZONS.map((horizon) => [horizon, summarize(cases, name, horizon)])),
      ]),
    ),
    allHybrid: Object.fromEntries(
      HORIZONS.map((horizon) => [
        horizon,
        summarizeHybrid(cases, bestPrompt, bestGeneration, horizon),
      ]),
    ),
    heldoutModels: held.map((item) => ({
      key: item.key,
      providerID: item.providerID,
      modelID: item.modelID,
      family: item.family,
      firstSeenAt: item.firstSeenAt,
      contextLimit: item.contextLimit,
      donors: item.predictions.get(best)?.donors ?? 0,
      weight: item.predictions.get(best)?.weight ?? 0,
    })),
  }

  console.log(JSON.stringify(report, null, 2))
}

await main()
