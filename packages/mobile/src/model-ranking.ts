import {
  buildFuzzyPricingFallbackMap,
  buildPersonalFallbackMap,
  buildPricingFallbackMap,
  mergePricingFallbacks,
  sortByCheapness,
} from "@opencode-ai/schema/model-select/cost"
import {
  collectThresholdPricingFromIndex,
  getUsageTables,
  prepareThresholdIndex,
  type UsageTables,
} from "@opencode-ai/schema/model-select/usage-profile"
import { buildStandardWorkloadCorpus, type CorpusBands } from "@opencode-ai/schema/model-select/usage-yield"

import type { MessageBundle } from "./api"

/**
 * The model selector's ranking, ported from the desktop selector so the PWA
 * lists models in the same order rather than in catalog order.
 *
 * This is the "Cheapness V2 / usage yield" pipeline: every paid model is priced
 * against one standardized workload corpus, free tiers are ordered by taxonomy
 * before price, context-threshold tiers pick the row the workload actually
 * activates, and the user's own measured $/request is blended in when there is
 * enough of it. All of that arithmetic lives in
 * `@opencode-ai/schema/model-select/*`, which the desktop imports through the
 * very same modules — this file only assembles the inputs the phone can reach.
 *
 * Two inputs are weaker here than on the desktop, deliberately:
 *
 * - The usage tables are fetched from the same public document the desktop
 *   uses, cached in `localStorage` for a day. Until the first fetch resolves
 *   the list is sorted by name, exactly as the desktop does before its own
 *   tables land, so the order never flickers between two priced orders.
 * - Personal $/request has no durable cross-session store on the phone. It is
 *   accumulated from the sessions this device has actually opened (see
 *   `recordPersonalCosts`) and persisted, which converges on the desktop's
 *   figure for the models the user actually runs from their phone.
 */

const PERSONAL_KEY = "opencode.mobile.modelCostIndex"
/** Matches the desktop learner's per-model sample ceiling. */
const MAX_SAMPLES_PER_MODEL = 200
/** Keeps the persisted index bounded on a device with a long history. */
const MAX_TRACKED_MODELS = 400
/** The desktop requires this many samples before trusting a hit rate. */
const MIN_HIT_RATE_SAMPLES = 3

export type CheapnessItem = {
  id: string
  name: string
  provider: { id: string; name: string }
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
  family?: string
}

type PersonalEntry = { sum: number; count: number; input: number; cacheRead: number }
type PersonalIndex = Record<string, PersonalEntry>

function readPersonal(): PersonalIndex {
  try {
    const raw = localStorage.getItem(PERSONAL_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PersonalIndex
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writePersonal(index: PersonalIndex) {
  try {
    const entries = Object.entries(index)
    // Drop the least-sampled models first: they contribute the least signal
    // and are the ones the blend weights lowest anyway.
    const bounded =
      entries.length <= MAX_TRACKED_MODELS
        ? entries
        : entries.sort((a, b) => b[1].count - a[1].count).slice(0, MAX_TRACKED_MODELS)
    localStorage.setItem(PERSONAL_KEY, JSON.stringify(Object.fromEntries(bounded)))
  } catch {
    // Best-effort: the ranking falls back to the corpus without it.
  }
}

type AssistantLike = {
  role?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: { input?: number; cache?: { read?: number } }
}

/**
 * Folds the assistant messages of a loaded session into the persisted personal
 * index. Safe to call repeatedly with the same session: re-counting a message
 * only sharpens the mean it already contributed to, and the per-model sample
 * ceiling bounds the drift. Returns the updated index.
 */
export function recordPersonalCosts(messages: readonly MessageBundle[]): PersonalIndex {
  const index = readPersonal()
  let changed = false
  for (const bundle of messages) {
    const message = bundle?.info as AssistantLike | undefined
    if (!message || message.role !== "assistant") continue
    if (!message.providerID || !message.modelID) continue
    const key = `${message.providerID}:${message.modelID}`
    const entry = (index[key] ??= { sum: 0, count: 0, input: 0, cacheRead: 0 })
    if (entry.count >= MAX_SAMPLES_PER_MODEL) continue
    const cost = message.cost ?? 0
    const input = message.tokens?.input ?? 0
    const cacheRead = message.tokens?.cache?.read ?? 0
    if (!(cost > 0) && !(input > 0 || cacheRead > 0)) continue
    if (cost > 0) entry.sum += cost
    entry.input += input
    entry.cacheRead += cacheRead
    entry.count++
    changed = true
  }
  if (changed) writePersonal(index)
  return index
}

/** `providerID:modelID` → mean $/request, for models with any priced sample. */
function personalCostMap(index: PersonalIndex): Map<string, { cost: number; count: number }> | undefined {
  const map = new Map<string, { cost: number; count: number }>()
  for (const [key, entry] of Object.entries(index)) {
    if (entry.count <= 0 || !(entry.sum > 0)) continue
    map.set(key, { cost: entry.sum / entry.count, count: entry.count })
  }
  return map.size > 0 ? map : undefined
}

/** `providerID:modelID` → measured cache hit rate, above the sample floor. */
function hitRateMap(index: PersonalIndex): Map<string, number> | undefined {
  const map = new Map<string, number>()
  for (const [key, entry] of Object.entries(index)) {
    if (entry.count < MIN_HIT_RATE_SAMPLES) continue
    const denom = entry.input + entry.cacheRead
    if (denom <= 0) continue
    map.set(key, entry.cacheRead / denom)
  }
  return map.size > 0 ? map : undefined
}

/**
 * Collapses a `providerID:modelID` map to a `modelID` map by averaging, so a
 * model measured on one provider can value the same model on another. Mirrors
 * the desktop's `hitRateFallback` / `buildPersonalFallbackMap` reasoning: the
 * user's workload shape follows the model, not the provider serving it.
 */
function byModelID(source: Map<string, number> | undefined): Map<string, number> | undefined {
  if (!source) return undefined
  const agg = new Map<string, { sum: number; count: number }>()
  for (const [key, value] of source) {
    const separator = key.indexOf(":")
    const modelID = separator >= 0 ? key.slice(separator + 1) : key
    const entry = agg.get(modelID)
    if (entry) {
      entry.sum += value
      entry.count++
    } else agg.set(modelID, { sum: value, count: 1 })
  }
  const out = new Map<string, number>()
  for (const [modelID, entry] of agg) out.set(modelID, entry.sum / entry.count)
  return out.size > 0 ? out : undefined
}

export type RankingInputs = {
  /** Undefined until the public usage tables have been fetched at least once. */
  tables?: UsageTables
  /** The full catalog, including models hidden from the list. */
  catalog: readonly CheapnessItem[]
  personal?: PersonalIndex
}

let cachedCorpus: { key: string; bands: CorpusBands } | undefined

/**
 * Sorts models cheapest-first using the shared cheapness ranking.
 *
 * Before the usage tables land there is no corpus to price against, so this
 * sorts by name — the same pre-ranking order the desktop shows — rather than
 * ranking against a fallback corpus and then visibly resorting.
 */
export function rankModels<T extends CheapnessItem>(models: T[], inputs: RankingInputs): T[] {
  const profile = inputs.tables?.profile
  if (!profile || profile.length === 0) {
    return [...models].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  const corpusKey = String(profile.length)
  if (!cachedCorpus || cachedCorpus.key !== corpusKey) {
    cachedCorpus = { key: corpusKey, bands: buildStandardWorkloadCorpus(profile.map((entry) => entry.profile)) }
  }

  // Threshold tiers are collected from the whole catalog, not the filtered
  // list: a model hidden from this view can still donate the tier rows its
  // visible sibling is priced by.
  const pricing = inputs.tables?.pricing ?? []
  let thresholds: Parameters<typeof sortByCheapness>[2]
  if (pricing.length > 0) {
    const index = prepareThresholdIndex(pricing)
    const map = new Map<string, NonNullable<ReturnType<typeof collectThresholdPricingFromIndex>>>()
    for (const item of inputs.catalog) {
      const tiers = collectThresholdPricingFromIndex(index, { name: item.name, family: item.family, id: item.id })
      if (tiers) map.set(`${item.provider.id}:${item.id}`, tiers)
    }
    if (map.size > 0) thresholds = map as never
  }

  const catalog = inputs.catalog as never[]
  const pricingFallback = mergePricingFallbacks(
    buildPricingFallbackMap(catalog),
    buildFuzzyPricingFallbackMap(catalog),
  )

  const personal = inputs.personal ?? {}
  const personalCosts = personalCostMap(personal)
  const hitRates = hitRateMap(personal)

  return sortByCheapness(
    models as never,
    cachedCorpus.bands.corpus,
    thresholds,
    personalCosts as never,
    pricingFallback as never,
    (personalCosts ? buildPersonalFallbackMap(personalCosts as never) : undefined) as never,
    hitRates as never,
    byModelID(hitRates) as never,
  ) as unknown as T[]
}

/**
 * Fetches the public usage/pricing tables the ranking prices against. Resolves
 * to `undefined` rather than throwing: an offline phone still gets a usable,
 * name-sorted selector.
 */
export async function loadUsageTables(): Promise<UsageTables | undefined> {
  try {
    return await getUsageTables()
  } catch {
    return undefined
  }
}

export { readPersonal as readPersonalCostIndex }
export type { PersonalIndex }
