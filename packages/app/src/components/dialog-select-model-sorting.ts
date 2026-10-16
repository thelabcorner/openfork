import {
  buildFuzzyPricingFallbackMap,
  buildPricingFallbackMap,
  classifyMonetaryClass,
  mergePricingFallbacks,
  type CheapnessModel,
  type ModelCost,
} from "@opencode-ai/schema/model-select/cost"
import { hasPublishedPricing } from "@opencode-ai/schema/model-select/badges"

type CatalogRate = {
  input?: number
  output?: number
  cache?: { read?: number; write?: number }
}
type CatalogRankItem = {
  id: string
  name: string
  family?: string
  provider: { id: string; name?: string }
  limit?: { context?: number }
  cost?: CatalogRate & {
    tiers?: readonly (CatalogRate & { tier: { type: string; size: number } })[]
    experimentalOver200K?: CatalogRate
  }
}

/** All fields affecting ranking and model-search identity, including native context tiers. */
export function fingerprintModelCatalog(models: readonly CatalogRankItem[]): string {
  if (models.length === 0) return ""
  let h = 0x811c9dc5
  const mix = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    h = Math.imul(h ^ 0x9e3779b9, 0x01000193)
  }
  const mixRate = (rate: CatalogRate | undefined) => {
    mix(rate ? `${rate.input ?? "-"}|${rate.output ?? "-"}|${rate.cache?.read ?? "-"}|${rate.cache?.write ?? "-"}` : "-")
  }
  for (const item of models) {
    mix(`${item.provider.id}\0${item.provider.name ?? ""}\0${item.id}\0${item.name}\0${item.family ?? ""}`)
    mix(String(item.limit?.context ?? "-"))
    mixRate(item.cost)
    const tiers = item.cost?.tiers
    if (tiers?.length) {
      mix(`tiers:${tiers.length}`)
      for (const tier of tiers) {
        mix(`${tier.tier.type}|${tier.tier.size}`)
        mixRate(tier)
      }
    }
    if (item.cost?.experimentalOver200K) {
      mix("over200K")
      mixRate(item.cost.experimentalOver200K)
    }
  }
  return `${models.length}:${(h >>> 0).toString(16).padStart(8, "0")}`
}

/**
 * Preserve projected model identities when only visibility/provider filters
 * change. Catalog snapshots come from ModelState.list(); a genuinely changed
 * model gets a new source identity. Weak keys avoid retaining old snapshots.
 */
export function createDisplayModelProjector<T extends { provider: { name?: string } }>() {
  const cache = new WeakMap<T, { label: string; model: T }>()
  return (model: T, label: string): T => {
    const previous = cache.get(model)
    if (previous?.label === label) return previous.model
    const projected = { ...model, provider: { ...model.provider, name: label } } as T
    cache.set(model, { label, model: projected })
    return projected
  }
}

// All model selectors consume the same immutable catalog snapshots. Reuse
// expensive fuzzy/exact fallback preparation across concurrently mounted
// pickers, not merely across opens of one instance. Weak keys allow obsolete
// catalog snapshots and the retained maps to be collected together.
const catalogPricing = new WeakMap<readonly CheapnessModel[], {
  fingerprint?: string
  merged: Map<string, ModelCost> | undefined
}>()

/** Caller supplies a new catalog array or its structural fingerprint on change. */
export function pricingFallbackForCatalog(
  models: readonly CheapnessModel[],
  fingerprint?: string,
): Map<string, ModelCost> | undefined {
  if (models.length === 0) return undefined
  const cached = catalogPricing.get(models)
  // A caller without a structural revision cannot prove a mutable catalog
  // array is unchanged. Avoid retaining stale inferred prices after in-place
  // provider repricing. Controllers supply a structural fingerprint and reuse
  // the expensive result safely; standalone callers without one recompute.
  if (cached && fingerprint !== undefined && cached.fingerprint === fingerprint) return cached.merged
  const exact = buildPricingFallbackMap(models as CheapnessModel[])
  // When every unpriced model already has an exact-id published donor, fuzzy
  // prices cannot change the merged map. Skip the donor-name normalization,
  // inverted-index allocation, and search altogether.
  let needsFuzzy = false
  for (const model of models) {
    if (exact.has(model.id) || hasPublishedPricing(model.cost)) continue
    needsFuzzy = true
    break
  }
  const fuzzy = needsFuzzy ? buildFuzzyPricingFallbackMap(models as CheapnessModel[], 0.75, exact) : undefined
  const merged = mergePricingFallbacks(exact.size > 0 ? exact : undefined, fuzzy?.size ? fuzzy : undefined)
  catalogPricing.set(models, { fingerprint, merged })
  return merged
}

type SortableModel = {
  id: string
  name: string
  provider: { id: string }
  cost?: { input?: number; output?: number }
}

const monetaryTier = {
  "quota-exempt": 0,
  "free-limited-known": 1,
  "free-limited-unknown": 2,
  paid: 3,
} as const

/** Cheap comparator for the legacy list that still owns its own sortBy. */
export function compareModelsForFirstPaint<T extends SortableModel>(a: T, b: T): number {
  return (
    monetaryTier[classifyMonetaryClass(a)] - monetaryTier[classifyMonetaryClass(b)] ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id) ||
    a.provider.id.localeCompare(b.provider.id)
  )
}

/**
 * First-paint fallback while full workload-normalized pricing is idle-gated.
 * Preserve the authoritative free taxonomy even when the expensive ranking
 * hasn't run yet. Never treat arbitrary missing/zero pricing as free.
 */
export function sortModelsForFirstPaint<T extends SortableModel>(models: readonly T[]): T[] {
  const ranked = models.map((item) => ({
    item,
    tier: monetaryTier[classifyMonetaryClass(item)],
  }))
  ranked.sort((a, b) =>
    a.tier - b.tier ||
    a.item.name.localeCompare(b.item.name) ||
    a.item.id.localeCompare(b.item.id) ||
    a.item.provider.id.localeCompare(b.item.provider.id),
  )
  return ranked.map(({ item }) => item)
}

/**
 * Search may expose per-account variants instead of canonical rows. Order by
 * the canonical model's live rank while preserving the exact variants (and
 * match order within one group) selected by the search matcher.
 *
 * Runs in O(models + matches) and never repeats the expensive yield ranking.
 */
export function orderModelSearchMatches<T>(
  rankedCanonical: readonly T[],
  matches: readonly T[],
  groupKeyOf: (item: T) => string,
): T[] {
  if (matches.length < 2) return [...matches]
  const matched = new Map<string, T[]>()
  for (const item of matches) {
    const groupKey = groupKeyOf(item)
    const group = matched.get(groupKey)
    if (group) group.push(item)
    else matched.set(groupKey, [item])
  }
  const result: T[] = []
  for (const item of rankedCanonical) {
    const groupKey = groupKeyOf(item)
    const group = matched.get(groupKey)
    if (!group) continue
    for (const match of group) result.push(match)
    matched.delete(groupKey)
  }
  // Defensive against index/catalog transitions: do not drop search matches.
  for (const group of matched.values()) for (const item of group) result.push(item)
  return result
}

/** Construct once per ranked catalog, instead of scanning all ranked models on each keystroke. */
export function indexModelSearchOrder<T>(
  rankedCanonical: readonly T[],
  groupKeyOf: (item: T) => string,
): ReadonlyMap<string, number> {
  const rank = new Map<string, number>()
  for (let i = 0; i < rankedCanonical.length; i++) {
    const key = groupKeyOf(rankedCanonical[i]!)
    if (!rank.has(key)) rank.set(key, i)
  }
  return rank
}

/**
 * Build a canonical search-rank index on the first selective query, not when a
 * hidden/model-selector controller is created. Reuse it for subsequent typing
 * until either the ranked catalog or canonical group mapping changes.
 */
export function createModelSearchOrderIndexCache<T, G>(
  groupKeyOf: (groups: G, item: T) => string,
): (ranked: readonly T[], groups: G) => ReadonlyMap<string, number> {
  let previousRanked: readonly T[] | undefined
  let previousGroups: G | undefined
  let previousIndex: ReadonlyMap<string, number> | undefined
  return (ranked, groups) => {
    if (previousIndex && previousRanked === ranked && previousGroups === groups) return previousIndex
    const next = indexModelSearchOrder(ranked, (item) => groupKeyOf(groups, item))
    previousRanked = ranked
    previousGroups = groups
    previousIndex = next
    return next
  }
}

/** Sort sparse search hits by their preindexed canonical rank; preserve variants and unknown groups. */
export function orderModelSearchMatchesIndexed<T>(
  rank: ReadonlyMap<string, number>,
  matches: readonly T[],
  groupKeyOf: (item: T) => string,
): T[] {
  if (matches.length <= 1) return [...matches]
  const groups = new Map<string, { order: number; first: number; items: T[] }>()
  for (const item of matches) {
    const key = groupKeyOf(item)
    const existing = groups.get(key)
    if (existing) existing.items.push(item)
    else groups.set(key, { order: rank.get(key) ?? Number.POSITIVE_INFINITY, first: groups.size, items: [item] })
  }
  const ordered = [...groups.values()]
  ordered.sort((a, b) => a.order - b.order || a.first - b.first)
  const result: T[] = []
  for (const group of ordered) for (const item of group.items) result.push(item)
  return result
}

/** Rates are the provider's own per-request credits, not synthetic $/token. */
export type WorkBuddySortRate = { free: boolean; rate: number }

/** Free promotions first, then known credit rates ascending; unknown last.
 * Stable ties retain the existing canonical model/search order. */
export function sortWorkBuddyCreditModels<T extends { id: string }>(
  models: readonly T[],
  rates: ReadonlyMap<string, WorkBuddySortRate>,
): T[] {
  const ranked = models.map((item, index) => {
    const value = rates.get(item.id)
    const tier = value?.free ? 0 : value && Number.isFinite(value.rate) && value.rate > 0 ? 1 : 2
    return { item, index, tier, rate: tier === 1 ? value!.rate : 0 }
  })
  ranked.sort((a, b) => a.tier - b.tier || (a.tier === 1 ? a.rate - b.rate : 0) || a.index - b.index)
  return ranked.map(({ item }) => item)
}
