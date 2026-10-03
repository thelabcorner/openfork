import type { UsageYield } from "@opencode-ai/core/usage/yield"
import {
  effectiveSamples,
  meanVector,
  momentsFor,
  sessionMomentsFor,
  snapshotYieldStatistic,
} from "@opencode-ai/core/usage/yield-statistics"
import { FALLBACK_WORKLOAD_CORPUS } from "@opencode-ai/schema/model-select/usage-yield"
import { Schema } from "effect"

const HALF_LIFE = 8 as const
const RECENT_LIMIT = 128
const CORPUS_SIZE = 16
const MAX_DIRECT_MODELS = 128
const MIN_PERSONAL_REQUESTS = 8
export const MIN_PERSONAL_EFFECTIVE_SAMPLES = 4
const RHO = 0.5 ** (1 / HALF_LIFE)

export const Source = Schema.Literals(["personal-general", "standardized-workload-prior"])
export type Source = Schema.Schema.Type<typeof Source>

export const Workload = Schema.Struct({
  inputTokens: Schema.Finite,
  cacheReadTokens: Schema.Finite,
  cacheWriteTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  reasoningTokens: Schema.Finite,
  contextTokens: Schema.Finite,
  generationTokens: Schema.Finite,
  totalTokens: Schema.Finite,
})
export type Workload = Schema.Schema.Type<typeof Workload>

export const Evidence = Schema.Struct({
  observations: Schema.Finite,
  requestEffectiveSamples: Schema.Finite,
  sessionEffectiveSamples: Schema.Finite,
})
export type Evidence = Schema.Schema.Type<typeof Evidence>

export const ModelEstimate = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  source: Schema.Literal("personal-model"),
  personalized: Schema.Literal(true),
  workload: Workload,
  evidence: Evidence,
})
export type ModelEstimate = Schema.Schema.Type<typeof ModelEstimate>

export const ScopeBand = Schema.Struct({
  scopeCount: Schema.Finite,
  lowerContextTokens: Schema.Finite,
  upperContextTokens: Schema.Finite,
  lowerGenerationTokens: Schema.Finite,
  upperGenerationTokens: Schema.Finite,
})
export type ScopeBand = Schema.Schema.Type<typeof ScopeBand>

export const RequestBand = Schema.Struct({
  requests: Schema.Finite,
  lowerContextTokens: Schema.Finite,
  upperContextTokens: Schema.Finite,
  lowerGenerationTokens: Schema.Finite,
  upperGenerationTokens: Schema.Finite,
})
export type RequestBand = Schema.Schema.Type<typeof RequestBand>

export const Snapshot = Schema.Struct({
  source: Source,
  fingerprint: Schema.String,
  fallback: Workload,
  typical: Workload,
  corpus: Schema.Array(Workload),
  evidence: Evidence,
  observedModelScopes: Schema.Finite,
  models: Schema.Array(ModelEstimate),
  observedRequestBand: Schema.optional(RequestBand),
  observedScopeBand: Schema.optional(ScopeBand),
})
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

function finiteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function workload(input: {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}): Workload {
  const inputTokens = finiteNonNegative(input.input)
  const cacheReadTokens = finiteNonNegative(input.cacheRead)
  const cacheWriteTokens = finiteNonNegative(input.cacheWrite)
  const outputTokens = finiteNonNegative(input.output)
  const reasoningTokens = finiteNonNegative(input.reasoning)
  const contextTokens = inputTokens + cacheReadTokens + cacheWriteTokens
  const generationTokens = outputTokens + reasoningTokens
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    contextTokens,
    generationTokens,
    totalTokens: contextTokens + generationTokens,
  }
}

function fallbackWorkload(value: (typeof FALLBACK_WORKLOAD_CORPUS)[number]): Workload {
  return workload({
    input: value.freshInputTokens,
    cacheRead: value.cachedReadTokens,
    cacheWrite: 0,
    output: value.outputTokens,
    reasoning: 0,
  })
}

function componentMedian(values: readonly Workload[]): Workload {
  if (values.length === 0)
    return workload({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 })
  const median = (select: (value: Workload) => number) => {
    const sorted = values.map(select).sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
  }
  return workload({
    input: median((value) => value.inputTokens),
    cacheRead: median((value) => value.cacheReadTokens),
    cacheWrite: median((value) => value.cacheWriteTokens),
    output: median((value) => value.outputTokens),
    reasoning: median((value) => value.reasoningTokens),
  })
}

function quantile(sorted: readonly number[], q: number) {
  if (sorted.length === 0) return undefined
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * Math.max(0, Math.min(1, q))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  const mix = pos - lo
  return sorted[lo]! * (1 - mix) + sorted[hi]! * mix
}

export const STANDARDIZED_CORPUS = FALLBACK_WORKLOAD_CORPUS.map(fallbackWorkload)
export const STANDARDIZED_WORKLOAD = componentMedian(STANDARDIZED_CORPUS)

type RecentCandidate = {
  readonly providerID: string
  readonly modelID: string
  readonly sessionID: string
  readonly completedAt: number
  readonly index: number
  readonly workload: Workload
}

type WeightedCandidate = RecentCandidate & { readonly weight: number }

function candidateOrder(a: RecentCandidate, b: RecentCandidate) {
  return (
    a.providerID.localeCompare(b.providerID) ||
    a.modelID.localeCompare(b.modelID) ||
    a.sessionID.localeCompare(b.sessionID) ||
    a.completedAt - b.completedAt ||
    a.index - b.index
  )
}

function newestOrder(a: RecentCandidate, b: RecentCandidate) {
  return b.completedAt - a.completedAt || candidateOrder(a, b)
}

function worseRecent(a: RecentCandidate, b: RecentCandidate) {
  return newestOrder(a, b) > 0
}

/** Keep only the globally newest exact requests while scanning sparse states. */
function offerRecent(heap: RecentCandidate[], candidate: RecentCandidate) {
  if (heap.length < RECENT_LIMIT) {
    heap.push(candidate)
    let index = heap.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!worseRecent(heap[index]!, heap[parent]!)) break
      const value = heap[index]!
      heap[index] = heap[parent]!
      heap[parent] = value
      index = parent
    }
    return
  }
  // Root is the least desirable (oldest) retained request.
  if (newestOrder(candidate, heap[0]!) >= 0) return
  heap[0] = candidate
  let index = 0
  for (;;) {
    const left = index * 2 + 1
    if (left >= heap.length) return
    const right = left + 1
    let child = left
    if (right < heap.length && worseRecent(heap[right]!, heap[left]!)) child = right
    if (!worseRecent(heap[child]!, heap[index]!)) return
    const value = heap[index]!
    heap[index] = heap[child]!
    heap[child] = value
    index = child
  }
}

function newest(values: RecentCandidate[]) {
  values.sort(newestOrder)
  return values
}

function weightedRecent(values: readonly RecentCandidate[]) {
  return values.map(
    (value, index): WeightedCandidate => ({
      ...value,
      weight: RHO ** index,
    }),
  )
}

function recentEvidence(values: readonly WeightedCandidate[]): Evidence {
  let weight = 0
  let squaredWeight = 0
  const sessions = new Map<string, number>()
  for (const value of values) {
    weight += value.weight
    squaredWeight += value.weight * value.weight
    sessions.set(value.sessionID, (sessions.get(value.sessionID) ?? 0) + value.weight)
  }
  let sessionSquaredWeight = 0
  for (const value of sessions.values()) sessionSquaredWeight += value * value
  return {
    // Evidence describes the bounded corpus that is actually being transferred,
    // not lifetime traffic that no longer participates in this estimate.
    observations: values.length,
    requestEffectiveSamples: weight > 0 && squaredWeight > 0 ? (weight * weight) / squaredWeight : 0,
    sessionEffectiveSamples:
      weight > 0 && sessionSquaredWeight > 0 ? (weight * weight) / sessionSquaredWeight : 0,
  }
}

function weightedQuantile(
  values: readonly WeightedCandidate[],
  select: (value: WeightedCandidate) => number,
  q: number,
) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => {
    const delta = select(a) - select(b)
    return delta || candidateOrder(a, b)
  })
  const total = sorted.reduce((sum, value) => sum + value.weight, 0)
  if (!(total > 0)) return undefined
  const target = Math.max(0, Math.min(1, q)) * total
  let cumulative = 0
  for (const value of sorted) {
    cumulative += value.weight
    if (cumulative >= target) return select(value)
  }
  return select(sorted.at(-1)!)
}

function representativeCorpus(values: readonly WeightedCandidate[]): Workload[] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => {
    const context = a.workload.contextTokens - b.workload.contextTokens
    if (context !== 0) return context
    const generation = a.workload.generationTokens - b.workload.generationTokens
    return generation || candidateOrder(a, b)
  })
  const count = Math.min(CORPUS_SIZE, sorted.length)
  const total = sorted.reduce((sum, value) => sum + value.weight, 0)
  const result: Workload[] = []
  for (let index = 0; index < count; index++) {
    const target = ((index + 0.5) / count) * total
    let cumulative = 0
    let selected = sorted.at(-1)!
    for (const value of sorted) {
      cumulative += value.weight
      if (cumulative < target) continue
      selected = value
      break
    }
    result.push(selected.workload)
  }
  return result
}

function typicalWorkload(values: readonly WeightedCandidate[], fallback: Workload) {
  const target = weightedQuantile(values, (value) => value.workload.totalTokens, 0.5)
  if (target === undefined) return fallback
  let selected = fallback
  let distance = Number.POSITIVE_INFINITY
  for (const value of values) {
    const next = Math.abs(value.workload.totalTokens - target)
    if (next >= distance) continue
    distance = next
    selected = value.workload
  }
  return selected
}

function fingerprint(source: Source, corpus: readonly Workload[], evidence: Evidence) {
  let hash = 0x811c9dc5
  const mix = (value: string) => {
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  mix(source)
  mix(
    String(evidence.observations) +
      "|" +
      evidence.requestEffectiveSamples.toPrecision(8) +
      "|" +
      evidence.sessionEffectiveSamples.toPrecision(8),
  )
  for (const value of corpus)
    mix(
      [
        value.inputTokens,
        value.cacheReadTokens,
        value.cacheWriteTokens,
        value.outputTokens,
        value.reasoningTokens,
      ].join("|"),
    )
  return "general-v1:" + (hash >>> 0).toString(16).padStart(8, "0")
}

/**
 * Build the compact process-global usage profile consumed by dense model UI.
 *
 * Direct per-model estimates remain exact-provider/model observations. For an
 * unseen model the shared corpus is instead a counterfactual description of the
 * user's *overall recent requests*: "what would this target cost / how much of
 * its context would it use if it handled my current workload?" It is not
 * interpreted as evidence that switching models changes user behavior.
 *
 * Chronological model-disjoint replay rejected donor-model/provider means as a
 * stable target-specific point predictor, so no donor mean is promoted into a
 * different model. The overall corpus uses exact recent physical requests,
 * recency weighting, and session-cluster ESS; immature history fails closed to
 * the standardized coding-agent corpus.
 */
export function build(entries: readonly UsageYield.Entry[]): Snapshot {
  const modelCandidates: Array<{ updatedAt: number; estimate: ModelEstimate }> = []
  const contexts: number[] = []
  const generations: number[] = []
  const recent: RecentCandidate[] = []

  for (const entry of entries) {
    // Account overlays repeat the same physical requests. They refine routing,
    // but are not independent model scopes and must never enter the global pool.
    if (entry.key.accountID) continue

    const state = snapshotYieldStatistic(entry.state)
    state.recent.forEach((value, index) => {
      const current = workload({
        input: value.tokens[0] ?? 0,
        cacheRead: value.tokens[1] ?? 0,
        cacheWrite: value.tokens[2] ?? 0,
        output: value.tokens[3] ?? 0,
        reasoning: value.tokens[4] ?? 0,
      })
      if (!(current.totalTokens > 0)) return
      offerRecent(recent, {
        providerID: entry.key.providerID,
        modelID: entry.key.baseModelID,
        sessionID: value.sessionID,
        completedAt: value.completedAt,
        index,
        workload: current,
      })
    })

    const request = momentsFor(state, HALF_LIFE)
    const sessions = sessionMomentsFor(state, HALF_LIFE)
    if (!request || !sessions) continue
    const mean = meanVector(request)
    if (!mean) continue

    const current = workload({
      input: mean[0] ?? 0,
      cacheRead: mean[1] ?? 0,
      cacheWrite: mean[2] ?? 0,
      output: mean[3] ?? 0,
      reasoning: mean[4] ?? 0,
    })
    const requestEffectiveSamples = effectiveSamples(request)
    const sessionEffectiveSamples = effectiveSamples(sessions)
    const independentEffectiveSamples = Math.min(requestEffectiveSamples, sessionEffectiveSamples)
    if (
      !(current.totalTokens > 0) ||
      state.observations < MIN_PERSONAL_REQUESTS ||
      independentEffectiveSamples < MIN_PERSONAL_EFFECTIVE_SAMPLES
    )
      continue

    modelCandidates.push({
      updatedAt: entry.updatedAt,
      estimate: {
        providerID: entry.key.providerID,
        modelID: entry.key.baseModelID,
        source: "personal-model",
        personalized: true,
        workload: current,
        evidence: {
          observations: state.observations,
          requestEffectiveSamples,
          sessionEffectiveSamples,
        },
      },
    })
    if (current.contextTokens > 0) contexts.push(current.contextTokens)
    if (current.generationTokens > 0) generations.push(current.generationTokens)
  }

  // Stable wire order makes snapshots deterministic and cheaper to diff/test.
  const observedModelScopes = modelCandidates.length
  const models = modelCandidates
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        a.estimate.providerID.localeCompare(b.estimate.providerID) ||
        a.estimate.modelID.localeCompare(b.estimate.modelID),
    )
    .slice(0, MAX_DIRECT_MODELS)
    .map((value) => value.estimate)
    .sort((a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID))
  contexts.sort((a, b) => a - b)
  generations.sort((a, b) => a - b)

  const weighted = weightedRecent(newest(recent))
  const evidence = recentEvidence(weighted)
  const mature =
    weighted.length >= MIN_PERSONAL_REQUESTS &&
    Math.min(evidence.requestEffectiveSamples, evidence.sessionEffectiveSamples) >= MIN_PERSONAL_EFFECTIVE_SAMPLES
  const personalCorpus = mature ? representativeCorpus(weighted) : []
  const source: Source = personalCorpus.length > 0 ? "personal-general" : "standardized-workload-prior"
  const corpus = personalCorpus.length > 0 ? personalCorpus : [...STANDARDIZED_CORPUS]
  const typical = source === "personal-general" ? typicalWorkload(weighted, STANDARDIZED_WORKLOAD) : STANDARDIZED_WORKLOAD

  const lowerRequestContext = mature
    ? weightedQuantile(weighted, (value) => value.workload.contextTokens, 0.1)
    : undefined
  const upperRequestContext = mature
    ? weightedQuantile(weighted, (value) => value.workload.contextTokens, 0.9)
    : undefined
  const lowerRequestGeneration = mature
    ? weightedQuantile(weighted, (value) => value.workload.generationTokens, 0.1)
    : undefined
  const upperRequestGeneration = mature
    ? weightedQuantile(weighted, (value) => value.workload.generationTokens, 0.9)
    : undefined
  const observedRequestBand =
    lowerRequestContext !== undefined &&
    upperRequestContext !== undefined &&
    lowerRequestGeneration !== undefined &&
    upperRequestGeneration !== undefined
      ? {
          requests: weighted.length,
          lowerContextTokens: lowerRequestContext,
          upperContextTokens: upperRequestContext,
          lowerGenerationTokens: lowerRequestGeneration,
          upperGenerationTokens: upperRequestGeneration,
        }
      : undefined

  const lowerContextTokens = quantile(contexts, 0.1)
  const upperContextTokens = quantile(contexts, 0.9)
  const lowerGenerationTokens = quantile(generations, 0.1)
  const upperGenerationTokens = quantile(generations, 0.9)
  const observedScopeBand =
    lowerContextTokens !== undefined &&
    upperContextTokens !== undefined &&
    lowerGenerationTokens !== undefined &&
    upperGenerationTokens !== undefined
      ? {
          scopeCount: observedModelScopes,
          lowerContextTokens,
          upperContextTokens,
          lowerGenerationTokens,
          upperGenerationTokens,
        }
      : undefined

  return {
    source,
    fingerprint: fingerprint(source, corpus, evidence),
    fallback: STANDARDIZED_WORKLOAD,
    typical,
    corpus,
    evidence,
    observedModelScopes,
    models,
    ...(observedRequestBand ? { observedRequestBand } : {}),
    ...(observedScopeBand ? { observedScopeBand } : {}),
  }
}
