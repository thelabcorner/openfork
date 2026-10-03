import type { ModelsDev } from "@opencode-ai/core/models-dev"
import type { UsageYield } from "@opencode-ai/core/usage/yield"
import {
  effectiveSamples,
  momentsFor,
  sessionMomentsFor,
  snapshotYieldStatistic,
  statisticalKeyID,
  type YieldStatisticState,
} from "@opencode-ai/core/usage/yield-statistics"
import { Schema } from "effect"
import {
  FALLBACK_WORKLOAD_CORPUS,
  nativePricingFromCatalogCost,
  selectNativePrices,
  type NativePricing,
} from "@opencode-ai/schema/model-select/usage-yield"
import type { ProviderResult, ProviderSummary, UsageWindow, WorkBuddyModelLimit } from "@/quota/schema"
import type { BurnEstimate } from "./resource-learning"
import { MIN_PERSONAL_EFFECTIVE_SAMPLES } from "./general-usage"

/**
 * Session-aware effective samples required before a generic monetary estimate
 * may be labelled personalized. Re-exported so the gate has one definition
 * that callers and tests read rather than re-deriving a magic number.
 */
export { MIN_PERSONAL_EFFECTIVE_SAMPLES }

/**
 * Hard cap for dense cross-provider model projections. The picker can contain
 * thousands of catalog models; request-count capacity is useful only for a
 * bounded shortlist because each monetary estimate reprices a representative
 * workload under the target model's current economics.
 *
 * Personally observed model scopes are admitted first, then the remaining
 * catalog models in deterministic provider/id order.
 */
export const MAX_PROVIDER_MODEL_ESTIMATES = 64

export const Status = Schema.Literals(["ready", "learning", "unavailable", "unlimited"])
export type Status = Schema.Schema.Type<typeof Status>

export const Source = Schema.Literals([
  "direct-request-budget",
  "published-request-rate",
  "published-model-capacity",
  "standardized-workload-prior",
  "personal-current-price",
  "provider-observed-burn",
  "unmetered",
  "insufficient-evidence",
])
export type Source = Schema.Schema.Type<typeof Source>

/**
 * Semantic meaning of one window's request number.
 *
 * `observed-remaining` divides an entitlement OBSERVED IN THAT WINDOW by the
 * divisor that produced it, so it answers "how many requests are left in this
 * window". `personalized-total-capacity` divides the window's published total
 * limit by the same divisor and applies no observed consumption at all, so it
 * answers "how many requests could this window hold at my workload".
 *
 * The two are not interchangeable. A window with no observed consumption has
 * unknown consumption, not zero consumption, so it must be published as
 * capacity rather than silently labelled as remaining.
 */
export const WindowBasis = Schema.Literals(["observed-remaining", "personalized-total-capacity"])
export type WindowBasis = Schema.Schema.Type<typeof WindowBasis>

/**
 * One independent resource window of a provider's usage envelope.
 *
 * Windows are projected per window instead of collapsed into a single number:
 * a provider that meters a 5h window and a weekly window has two separate
 * entitlements, and reporting only the binding one hides the other entirely.
 *
 * `remainingPercent` and `resetAt` are real provider facts about THIS window or
 * they are null. They are never borrowed from another window and never derived
 * from an assumed denominator.
 */
export const Window = Schema.Struct({
  /** Stable provider window key; joins to the provider's own usage windows. */
  id: Schema.String,
  /** Short display label derived from a real window duration, else the id. */
  label: Schema.String,
  basis: WindowBasis,
  status: Status,
  source: Source,
  personalized: Schema.Boolean,
  estimatedRequests: Schema.NullOr(Schema.Finite),
  /** Predictive bounds, present only where a range was actually calibrated. */
  lowerRequests: Schema.optional(Schema.Finite),
  upperRequests: Schema.optional(Schema.Finite),
  remainingPercent: Schema.NullOr(Schema.Finite),
  resetAt: Schema.NullOr(Schema.Finite),
})
export type Window = Schema.Schema.Type<typeof Window>

/**
 * Hard bound on independent window projections carried per estimate.
 *
 * Providers publish a handful of usage windows, so this bound is never the
 * reason a real window is dropped; it exists so a misbehaving adapter cannot
 * turn one estimate into an unbounded payload. The binding window is always
 * retained (see `boundedCapacityWindows`).
 */
export const MAX_CAPACITY_WINDOWS = 8

/**
 * Short display label for a provider window.
 *
 * Uses a real observed `windowSeconds` when the provider reported one and falls
 * back to the provider's own key otherwise. It never guesses a duration and
 * never asserts a window the provider did not report.
 */
export function windowLabel(id: string, window: UsageWindow) {
  const seconds = window.windowSeconds
  if (seconds === null || !Number.isFinite(seconds) || !(seconds > 0)) return id
  if (seconds % 604800 === 0) return `${seconds / 604800}w`
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${Math.round(seconds)}s`
}

/**
 * Bound one estimate's window list, always retaining the binding window.
 *
 * Deterministic id order keeps the surviving set stable across reads, and the
 * binding window is pinned first so truncation can never silently drop the
 * window the top-level estimate was actually derived from.
 */
export function boundedCapacityWindows(
  windows: readonly Window[],
  bindingID?: string,
  limit: number = MAX_CAPACITY_WINDOWS,
): Window[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : MAX_CAPACITY_WINDOWS
  if (windows.length <= max) return [...windows]
  const ordered = [...windows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const binding = bindingID === undefined ? undefined : ordered.find((window) => window.id === bindingID)
  const kept: Window[] = binding ? [binding] : []
  for (const window of ordered) {
    if (kept.length >= max) break
    if (binding && window.id === binding.id) continue
    kept.push(window)
  }
  return kept
}

/** One convertible provider window reduced to what the projection needs. */
type ResourceWindow = {
  readonly id: string
  readonly label: string
  readonly remaining: number
  readonly remainingPercent: number | null
  readonly resetAt: number | null
}

function windowInput(key: string, window: UsageWindow, remaining: number): ResourceWindow {
  return {
    id: key,
    label: windowLabel(key, window),
    remaining,
    remainingPercent: window.remainingPercent,
    resetAt: window.resetAt,
  }
}

export const Evidence = Schema.Struct({
  observations: Schema.Finite,
  requestEffectiveSamples: Schema.Finite,
  sessionEffectiveSamples: Schema.Finite,
})
export type Evidence = Schema.Schema.Type<typeof Evidence>

export const Estimate = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.optional(Schema.String),
  accountID: Schema.optional(Schema.String),
  accountLabel: Schema.optional(Schema.String),
  status: Status,
  source: Source,
  estimatedRequests: Schema.NullOr(Schema.Finite),
  remainingPercent: Schema.NullOr(Schema.Finite),
  resetAt: Schema.NullOr(Schema.Finite),
  personalized: Schema.Boolean,
  limitingWindow: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  windows: Schema.optional(Schema.Array(Window)),
  evidence: Evidence,
})
export type Estimate = Schema.Schema.Type<typeof Estimate>

export const Account = Schema.Struct({
  accountID: Schema.String,
  accountLabel: Schema.optional(Schema.String),
  defaultEstimate: Schema.optional(Estimate),
  estimates: Schema.Array(Estimate),
})
export type Account = Schema.Schema.Type<typeof Account>

export const Provider = Schema.Struct({
  quotaProviderID: Schema.String,
  providerName: Schema.String,
  modelProviderIDs: Schema.Array(Schema.String),
  status: Schema.Literals(["ok", "error", "not-configured"]),
  reason: Schema.optional(Schema.String),
  defaultEstimates: Schema.Array(Estimate),
  estimates: Schema.Array(Estimate),
  accounts: Schema.Array(Account),
})
export type Provider = Schema.Schema.Type<typeof Provider>

export const EMPTY_EVIDENCE: Evidence = {
  observations: 0,
  requestEffectiveSamples: 0,
  sessionEffectiveSamples: 0,
}

const MONEY_HALF_LIFE = 8 as const

export function floorRequestCount(value: number) {
  if (!(value > 0) || !Number.isFinite(value)) return 0
  return Math.floor(value + Math.max(1e-9, value * Number.EPSILON * 8))
}

function stateEvidence(state: YieldStatisticState | undefined): Evidence {
  if (!state) return EMPTY_EVIDENCE
  const snapshot = snapshotYieldStatistic(state)
  const request = momentsFor(snapshot, MONEY_HALF_LIFE)
  const sessions = sessionMomentsFor(snapshot, MONEY_HALF_LIFE)
  return {
    observations: snapshot.observations,
    requestEffectiveSamples: request ? effectiveSamples(request) : 0,
    sessionEffectiveSamples: sessions ? effectiveSamples(sessions) : 0,
  }
}

/**
 * Price one settled request's token vector under a model's CURRENT catalog
 * pricing.
 *
 * The context-tier rule itself is NOT implemented here. It is the single shared
 * `selectNativePrices` rule used by the selector's `priceWorkload`, so a model
 * can never be priced one way in the picker and another way in Capacity. This
 * function is the workload->dollars half of that shared contract.
 *
 * Exported for the parity/tier-selection regression tests: the tier choice must
 * stay byte-for-byte identical to the shared pricing machinery.
 */
export function costForTokens(model: ModelsDev.Model, tokens: readonly number[]) {
  const pricing = modelPricing(model)
  if (!pricing) return undefined
  return costForNativeTokens(pricing, tokens)
}

/**
 * Compile one model into native pricing rows, once per model.
 *
 * Hoisting this out of the per-observation loop is what keeps the personal
 * price path allocation-light: the hot path then only selects a borrowed row
 * and does the token arithmetic.
 */
export function modelPricing(model: ModelsDev.Model): NativePricing | undefined {
  return model.cost ? nativePricingFromCatalogCost(model.cost) : undefined
}

/** Token dollars for an already-compiled row set. Reasoning bills as output. */
export function costForNativeTokens(pricing: NativePricing, tokens: readonly number[]) {
  const input = Math.max(0, tokens[0] ?? 0)
  const cacheRead = Math.max(0, tokens[1] ?? 0)
  const cacheWrite = Math.max(0, tokens[2] ?? 0)
  const output = Math.max(0, tokens[3] ?? 0)
  const reasoning = Math.max(0, tokens[4] ?? 0)
  const context = input + cacheRead + cacheWrite
  const row = selectNativePrices(pricing, context).prices
  const value =
    (input * row.input +
      output * row.output +
      cacheRead * row.cache.read +
      cacheWrite * row.cache.write +
      reasoning * row.output) /
    1_000_000
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function personalCurrentPrice(pricing: NativePricing | undefined, state: YieldStatisticState | undefined) {
  if (!pricing || !state) return undefined
  const snapshot = snapshotYieldStatistic(state)
  if (snapshot.recent.length === 0) return undefined
  const rho = 0.5 ** (1 / MONEY_HALF_LIFE)
  let weight = 0
  let sum = 0
  for (let index = 0; index < snapshot.recent.length; index++) {
    const observation = snapshot.recent[index]!
    const price = costForNativeTokens(pricing, observation.tokens)
    if (!(price !== undefined && price > 0)) continue
    const currentWeight = rho ** (snapshot.recent.length - 1 - index)
    weight += currentWeight
    sum += currentWeight * price
  }
  return weight > 0 ? sum / weight : undefined
}

function median(values: readonly number[]) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

/**
 * Cross-provider cold-start prior. This is the same standardized coding-agent
 * corpus used by the selector's usage-yield ranking, priced under the target
 * model's CURRENT pricing (including native context tiers). It is not a
 * universal dollar budget and it never reuses historical dollar cost.
 */
function standardizedPriorPrice(pricing: NativePricing | undefined) {
  if (!pricing) return undefined
  return median(
    FALLBACK_WORKLOAD_CORPUS.flatMap((workload) => {
      const price = costForNativeTokens(pricing, [
        workload.freshInputTokens,
        workload.cachedReadTokens,
        0,
        workload.outputTokens,
        0,
      ])
      return price !== undefined && price > 0 ? [price] : []
    }),
  )
}

function requestPrice(pricing: NativePricing | undefined, state: YieldStatisticState | undefined) {
  const prior = standardizedPriorPrice(pricing)
  const personal = personalCurrentPrice(pricing, state)
  const evidence = stateEvidence(state)
  const independentSamples = Math.min(
    evidence.requestEffectiveSamples,
    evidence.sessionEffectiveSamples,
  )

  // Generic monetary providers gate the `personalized` LABEL on session-aware
  // effective samples, not on a raw observation count. Labelling a $/request
  // number "personalized" after one request (or after 32 requests from one
  // session) would be a provenance claim the evidence does not support, and
  // that number is inverted into requests remaining.
  //
  // This is deliberately NOT the OpenCode Go policy. Go's hierarchical
  // estimator moves continuously on its first usable account observation and
  // is regularized hard toward the already-personalized base-model posterior
  // (kappa = 32 prior-equivalents, ledger 24.6-24.7). The two differ on
  // purpose: Go's overlay is a *shrinkage* step on top of a mature personal
  // base posterior, so moving early is sound; here the prior itself is the
  // population corpus, and claiming personalization before any independent
  // evidence exists would misrepresent where the number came from. Do not
  // "simplify" this into a first-observation switch.
  if (
    prior !== undefined &&
    prior > 0 &&
    personal !== undefined &&
    personal > 0 &&
    independentSamples >= MIN_PERSONAL_EFFECTIVE_SAMPLES
  ) {
    return {
      price: (prior + independentSamples * personal) / (1 + independentSamples),
      source: "personal-current-price" as const,
      personalized: true,
      evidence,
    }
  }
  if (prior !== undefined && prior > 0) {
    return {
      price: prior,
      source: "standardized-workload-prior" as const,
      personalized: false,
      evidence,
    }
  }
  if (personal !== undefined && personal > 0 && independentSamples >= MIN_PERSONAL_EFFECTIVE_SAMPLES) {
    return {
      price: personal,
      source: "personal-current-price" as const,
      personalized: true,
      evidence,
    }
  }
  return {
    price: undefined,
    source: "insufficient-evidence" as const,
    personalized: false,
    evidence,
  }
}

type CapacityModelCandidate = {
  readonly providerID: string
  readonly model: ModelsDev.Model
  readonly observed: boolean
}

/**
 * Fixed-size "keep the K smallest" max-heap, one record per retained scope.
 *
 * The heap is offered every model in the catalog and almost all of them lose to
 * the root, so a record is only ever constructed for a scope that actually wins
 * a slot — `offerScope` compares raw values against the root and returns before
 * allocating anything. Retained space is therefore O(K) regardless of catalog
 * size, which is the whole point: the previous implementation allocated one
 * candidate per catalog model on every call.
 *
 * `seq` is a private catalog-iteration ordinal carried on each record. It is
 * only ever the final tiebreak, so repeated provider/model pairs keep exactly
 * the relative order the previous stable sort over a materialized catalog gave
 * them. It never reaches a returned candidate.
 */
type RankedScope = CapacityModelCandidate & { readonly seq: number }

/**
 * One collator for the whole process instead of a `localeCompare` per sort
 * comparison. `Intl.Collator#compare` with default options is the specified
 * equivalent of `String.prototype.localeCompare`, so the admitted order is
 * unchanged — only the comparison cost is. The `!==` guards skip the collator
 * only for byte-identical strings, which it necessarily reports as equal.
 */
const ADMISSION_COLLATOR = new Intl.Collator()

/**
 * Scope ordering, comparable from raw values so the root comparison needs no
 * record to exist yet.
 */
function compareScope(
  aProviderID: string,
  aModelID: string,
  aSeq: number,
  bProviderID: string,
  bModelID: string,
  bSeq: number,
) {
  if (aProviderID !== bProviderID) return ADMISSION_COLLATOR.compare(aProviderID, bProviderID)
  if (aModelID !== bModelID) return ADMISSION_COLLATOR.compare(aModelID, bModelID)
  return aSeq - bSeq
}

function compareRanked(a: RankedScope, b: RankedScope) {
  return compareScope(a.providerID, a.model.id, a.seq, b.providerID, b.model.id, b.seq)
}

function scopeSiftUp(heap: RankedScope[], index: number) {
  const scope = heap[index]!
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (compareRanked(heap[parent]!, scope) >= 0) break
    heap[index] = heap[parent]!
    index = parent
  }
  heap[index] = scope
}

function scopeSiftDown(heap: RankedScope[], index: number) {
  const size = heap.length
  const scope = heap[index]!
  for (;;) {
    const left = index * 2 + 1
    if (left >= size) break
    const right = left + 1
    const larger = right < size && compareRanked(heap[right]!, heap[left]!) > 0 ? right : left
    if (compareRanked(heap[larger]!, scope) <= 0) break
    heap[index] = heap[larger]!
    index = larger
  }
  heap[index] = scope
}

/**
 * Offer one catalog model to the bounded ranker.
 *
 * The root is the largest retained scope, so a newcomer is admitted only when
 * it beats that root, and it is otherwise dropped without ever being stored.
 * That makes admission one comparison per catalog model in steady state, and
 * O(log K) only while the retained set is still filling or when a smaller scope
 * genuinely displaces the root.
 *
 * Precondition: `capacity` is a normalized non-negative integer cap (see
 * `normalizedCapacityModelLimit`). Every value that normalization can produce is
 * either 0 — which the caller turns into an early empty return before any model
 * is offered — or at least 1, so the heap is always filled from slot 0 and the
 * root below is always a written slot. No separate empty-heap guard is needed
 * once the limit is normalized rather than merely coerced.
 */
function offerScope(
  heap: RankedScope[],
  capacity: number,
  providerID: string,
  model: ModelsDev.Model,
  observed: boolean,
  seq: number,
) {
  const size = heap.length
  if (size < capacity) {
    heap.push({ providerID, model, observed, seq })
    scopeSiftUp(heap, size)
    return
  }
  const root = heap[0]!
  if (compareScope(providerID, model.id, seq, root.providerID, root.model.id, root.seq) >= 0) return
  heap[0] = { providerID, model, observed, seq }
  scopeSiftDown(heap, 0)
}

/**
 * Normalize a caller-requested candidate limit into an integer slot count in
 * `[0, MAX_PROVIDER_MODEL_ESTIMATES]`.
 *
 * The optional limit exists to NARROW the production cap for a test or a caller
 * that wants a smaller projection. It can never raise it: `limit: 1000` and
 * `limit: Infinity` used to hand back an unbounded working set and payload,
 * which is exactly the regression the hard cap exists to prevent. Every branch is
 * total and explicit rather than left to the accident of how a non-finite
 * number compares:
 *
 *   omitted       -> the hard cap
 *   NaN           -> 0 (no meaningful number was requested; matches the `[]`
 *                    the previous `slice(0, NaN)` produced)
 *   +Infinity     -> the hard cap (never more than the cap, never unbounded)
 *   <= 0, -Infinity -> 0
 *   otherwise     -> floored, then clamped down to the hard cap
 *
 * Exported so the reference admission semantics in the benchmark and the
 * boundary tests read this one definition rather than re-deriving the rule.
 */
export function normalizedCapacityModelLimit(requested?: number) {
  const raw = requested ?? MAX_PROVIDER_MODEL_ESTIMATES
  if (Number.isNaN(raw)) return 0
  if (raw === Number.POSITIVE_INFINITY) return MAX_PROVIDER_MODEL_ESTIMATES
  if (raw <= 0) return 0
  return Math.min(MAX_PROVIDER_MODEL_ESTIMATES, Math.floor(raw))
}

/**
 * Flatten the admitted ranks back into the public candidate shape.
 *
 * Each rank is sorted on its own and the ranks are emitted observed-first. That
 * ordering is load-bearing: the admission rule is "observed scopes first, THEN
 * the provider/id remainder", so an observed scope outranks an unobserved one no
 * matter how its id sorts. Sorting one merged array by scope would interleave
 * them and push an observed tail id (say `model-190`) behind an unobserved head
 * id (say `model-000`), which is exactly the property the bound exists to keep.
 *
 * The remainder rank is deliberately left at full `limit` width rather than
 * trimmed to `limit - observed`: the first `limit - observed` entries of its
 * sorted form are the globally smallest unobserved scopes either way, so the
 * extra retained entries are simply never read.
 */
function rankedCandidates(limit: number, ranks: readonly RankedScope[][]) {
  const candidates: CapacityModelCandidate[] = []
  for (const rank of ranks) {
    rank.sort(compareRanked)
    for (const scope of rank) {
      if (candidates.length >= limit) break
      candidates.push({ providerID: scope.providerID, model: scope.model, observed: scope.observed })
    }
  }
  return candidates
}

/**
 * Deterministic bounded candidate set for cross-provider projections.
 *
 * A catalog can contain thousands of models, but only a small fraction has
 * direct personal evidence. Admit observed scopes first (up to the hard bound),
 * then fill remaining slots from deterministic catalog order. This preserves
 * useful direct estimates while making the *result* bounded as the catalog
 * grows.
 *
 * What bounding buys, precisely. The admitted list and the returned payload are
 * capped at `limit` regardless of catalog size, and the admission working set is
 * O(limit) — before this change each call materialized one candidate object per
 * catalog model and locale-sorted the whole thing. CPU is NOT flat in catalog
 * size and must not be described that way: the catalog still has to be walked to
 * know which scopes are the smallest, so admission is O(N log limit) time,
 * versus the O(N log N) time and O(N) space it replaced. What is eliminated is
 * the O(N) allocation, the O(N log N) comparison count, and the unbounded
 * transient array.
 *
 * The admitted list is the same ordered, bounded list the previous
 * "materialize every catalog model, sort them all, slice" implementation
 * produced: observed scopes first, then the provider/id remainder, hard capped.
 * The one intentional behavior change is the cap itself — a requested limit may
 * now only narrow the bound, never raise it; see
 * `normalizedCapacityModelLimit`.
 */
export function capacityModelCandidates(input: {
  providerIDs: readonly string[]
  catalog: Record<string, ModelsDev.Provider>
  entries: readonly UsageYield.Entry[]
  limit?: number
}): CapacityModelCandidate[] {
  const limit = normalizedCapacityModelLimit(input.limit)
  if (limit === 0) return []

  // Group the personally observed scopes by provider so the catalog walk is a
  // plain map/set membership test. Joining `providerID:modelID` into one key
  // was equivalent except that a colon inside either opaque id could alias two
  // distinct scopes onto one entry.
  const observedScopes = new Map<string, Set<string>>()
  for (const entry of input.entries) {
    if (entry.key.accountID) continue
    const scopes = observedScopes.get(entry.key.providerID)
    if (scopes) scopes.add(entry.key.baseModelID)
    else observedScopes.set(entry.key.providerID, new Set([entry.key.baseModelID]))
  }

  const observedRank: RankedScope[] = []
  const remainderRank: RankedScope[] = []
  let seq = 0
  for (const providerID of input.providerIDs) {
    const provider = input.catalog[providerID]
    if (!provider) continue
    const scopes = observedScopes.get(providerID)
    for (const model of Object.values(provider.models)) {
      const observed = scopes !== undefined && scopes.has(model.id)
      offerScope(observed ? observedRank : remainderRank, limit, providerID, model, observed, seq++)
    }
  }

  return rankedCandidates(limit, [observedRank, remainderRank])
}

/**
 * One bounded candidate resolved to a $/request price under current economics.
 *
 * Every catalog-driven estimate in this module is produced here so the bound,
 * the provenance tier, and the evidence block cannot drift apart per provider.
 */
type PricedCandidate = {
  readonly providerID: string
  readonly model: ModelsDev.Model
  readonly observed: boolean
  readonly price: number | undefined
  readonly source: Source
  readonly personalized: boolean
  readonly evidence: Evidence
}

function priceCandidates(
  candidates: readonly CapacityModelCandidate[],
  stateMap: ReadonlyMap<string, YieldStatisticState>,
): PricedCandidate[] {
  return candidates.map((candidate) => {
    const state = stateMap.get(statisticalKeyID({ providerID: candidate.providerID, baseModelID: candidate.model.id }))
    const priced = requestPrice(modelPricing(candidate.model), state)
    return {
      providerID: candidate.providerID,
      model: candidate.model,
      observed: candidate.observed,
      price: priced.price,
      source: priced.source,
      personalized: priced.personalized,
      evidence: priced.evidence,
    }
  })
}

function stateMapFor(entries: readonly UsageYield.Entry[]) {
  return new Map(entries.map((entry) => [statisticalKeyID(entry.key), entry.state] as const))
}

/**
 * Shared per-window "remaining / current price" projection over the bounded
 * candidate set.
 *
 * A candidate with no usable price is a `learning` row with a real reason, not
 * a dropped model and never an invented request count.
 *
 * Every convertible window becomes its own independent projection, while the
 * top-level fields keep describing the binding window so existing consumers
 * read exactly what they read today. `bindingID` names that binding window; it
 * must be one of `windows`, because it is the window whose remaining fraction
 * and reset boundary the top-level fields reproduce.
 */
function moneyEstimates(
  priced: readonly PricedCandidate[],
  windows: readonly ResourceWindow[],
  bindingID: string,
): Estimate[] {
  const bound = windows.find((window) => window.id === bindingID) ?? windows[0]!
  return priced.map((candidate) => {
    const { model } = candidate
    const price = candidate.price !== undefined && candidate.price > 0 ? candidate.price : undefined
    const projections: Window[] = windows.map((window) => ({
      id: window.id,
      label: window.label,
      basis: "observed-remaining",
      status: price === undefined ? "learning" : "ready",
      source: price === undefined ? "insufficient-evidence" : candidate.source,
      personalized: price !== undefined && candidate.personalized,
      estimatedRequests: price === undefined ? null : floorRequestCount(window.remaining / price),
      remainingPercent: window.remainingPercent,
      resetAt: window.resetAt,
    }))

    if (price === undefined) {
      return {
        providerID: candidate.providerID,
        modelID: model.id,
        status: "learning",
        source: "insufficient-evidence",
        estimatedRequests: null,
        remainingPercent: bound.remainingPercent,
        resetAt: bound.resetAt,
        personalized: false,
        limitingWindow: bound.id,
        reason: model.cost
          ? "A settled request is needed to learn this model's personal request size under current pricing."
          : "Current per-token pricing is unavailable for this model.",
        evidence: candidate.evidence,
        windows: boundedCapacityWindows(projections, bound.id),
      }
    }

    const binding = projections.reduce((best, window) =>
      (window.estimatedRequests ?? Number.POSITIVE_INFINITY) <
      (best.estimatedRequests ?? Number.POSITIVE_INFINITY)
        ? window
        : best,
    )
    return {
      providerID: candidate.providerID,
      modelID: model.id,
      status: "ready",
      source: candidate.source,
      estimatedRequests: binding.estimatedRequests,
      remainingPercent: bound.remainingPercent,
      resetAt: bound.resetAt,
      personalized: candidate.personalized,
      limitingWindow: binding.id,
      evidence: candidate.evidence,
      windows: boundedCapacityWindows(projections, binding.id),
    }
  })
}

export function modelProviderIDs(summary: ProviderSummary, catalog: Record<string, ModelsDev.Provider>) {
  if (summary.providerId === "opencode-go") return ["opencode-go"]
  if (summary.providerId === "opencode-zen") return ["opencode"]
  const candidates = [...new Set([summary.providerId, ...summary.aliases])]
  const existing = candidates.filter((id) => catalog[id] !== undefined)
  return existing.length > 0 ? existing : [summary.providerId]
}

function requestWindows(windows: Record<string, UsageWindow>, at: number): ResourceWindow[] {
  return Object.entries(windows)
    .flatMap(([key, window]) => {
      const resource = window.resource
      if (resource?.kind !== "requests" || resource.remaining === null) return []
      if (window.resetAt !== null && window.resetAt <= at) return []
      return [windowInput(key, window, Math.max(0, resource.remaining))]
    })
}

export function directRequestDefaults(input: {
  providerIDs: readonly string[]
  result: ProviderResult
  at: number
}): Estimate[] {
  const usage = input.result.usage
  if (!usage) return []
  const available = requestWindows(usage.windows, input.at)
  const budget = available.slice().sort((a, b) => a.remaining - b.remaining)[0]
  if (!budget) return []
  // A provider request budget is already expressed in requests, so every
  // supported window is independently observable with no divisor at all.
  const windows: Window[] = available.map((window) => ({
    id: window.id,
    label: window.label,
    basis: "observed-remaining",
    status: "ready",
    source: "direct-request-budget",
    personalized: false,
    estimatedRequests: floorRequestCount(window.remaining),
    remainingPercent: window.remainingPercent,
    resetAt: window.resetAt,
  }))
  const bounded = boundedCapacityWindows(windows, budget.id)
  return input.providerIDs.map((providerID) => ({
    providerID,
    status: "ready",
    source: "direct-request-budget",
    estimatedRequests: floorRequestCount(budget.remaining),
    remainingPercent: budget.remainingPercent,
    resetAt: budget.resetAt,
    personalized: false,
    limitingWindow: budget.id,
    evidence: EMPTY_EVIDENCE,
    windows: bounded,
  }))
}


export function emptyProvider(
  summary: ProviderSummary,
  providerIDs: readonly string[],
  result: ProviderResult,
): Provider {
  return {
    quotaProviderID: summary.providerId,
    providerName: result.providerName,
    modelProviderIDs: [...providerIDs],
    status: result.configured ? "error" : "not-configured",
    ...(result.error ? { reason: result.error } : {}),
    defaultEstimates: [],
    estimates: [],
    accounts: [],
  }
}

export function learningProvider(
  summary: ProviderSummary,
  providerIDs: readonly string[],
  result: ProviderResult,
  reason: string,
  at = Date.now(),
): Provider {
  const windows = Object.values(result.usage?.windows ?? {})
  return {
    quotaProviderID: summary.providerId,
    providerName: result.providerName,
    modelProviderIDs: [...providerIDs],
    status: "ok",
    reason,
    defaultEstimates: providerIDs.map((providerID) => ({
      providerID,
      status: "learning",
      source: "insufficient-evidence",
      estimatedRequests: null,
      remainingPercent:
        windows
          .map((window) => window.remainingPercent)
          .filter((value): value is number => value !== null)
          .sort((a, b) => a - b)[0] ?? null,
      resetAt:
        windows
          .map((window) => window.resetAt)
          .filter((value): value is number => value !== null && value > at)
          .sort((a, b) => a - b)[0] ?? null,
      personalized: false,
      reason,
      evidence: EMPTY_EVIDENCE,
    })),
    estimates: [],
    accounts: [],
  }
}

export function moneyProvider(input: {
  summary: ProviderSummary
  result: ProviderResult
  providerIDs: readonly string[]
  candidates: readonly CapacityModelCandidate[]
  entries: readonly UsageYield.Entry[]
  at: number
}): Provider {
  const usage = input.result.usage
  if (!usage) return emptyProvider(input.summary, input.providerIDs, input.result)

  const moneyWindows = Object.entries(usage.windows).filter(([, window]) => {
    if (window.resetAt !== null && window.resetAt <= input.at) return false
    return (
      window.resource?.kind === "money" &&
      window.resource.currency === "USD" &&
      window.resource.remaining !== null
    )
  })

  if (moneyWindows.length === 0) {
    return learningProvider(
      input.summary,
      input.providerIDs,
      input.result,
      "No compatible USD resource is available for request conversion.",
      input.at,
    )
  }

  // Every convertible USD window is projected independently; the binding one
  // still drives the top-level fields, so the existing single-window reading
  // is unchanged.
  const available = moneyWindows.map(([key, window]) =>
    windowInput(key, window, Math.max(0, window.resource!.remaining!)),
  )
  const binding = available.slice().sort((a, b) => a.remaining - b.remaining)[0]!
  const estimates = moneyEstimates(
    priceCandidates(input.candidates, stateMapFor(input.entries)),
    available,
    binding.id,
  )

  if (estimates.length === 0) {
    return learningProvider(
      input.summary,
      input.providerIDs,
      input.result,
      "The provider balance is available, but no current priced model catalog is available for request conversion.",
      input.at,
    )
  }

  return {
    quotaProviderID: input.summary.providerId,
    providerName: input.result.providerName,
    modelProviderIDs: [...input.providerIDs],
    status: "ok",
    defaultEstimates: [],
    estimates,
    accounts: [],
  }
}


function accountWindow(
  windows: Record<string, UsageWindow>,
  label: string,
  kind: "Basic" | "Combined" = "Basic",
) {
  return windows["account:" + label + ":" + kind]
}

function modelReport(reports: readonly WorkBuddyModelLimit[], modelID: string) {
  return reports.find((report) => report.model === modelID || report.canonical === modelID)
}

function reportEstimate(input: {
  providerID: string
  modelID: string
  accountID: string
  accountLabel: string
  report: WorkBuddyModelLimit
  source?: Source
}): Estimate | undefined {
  const remaining = input.report.exhaustedObserved ? 0 : input.report.remainingEstimate
  if (remaining === null) return undefined
  return {
    providerID: input.providerID,
    modelID: input.modelID,
    accountID: input.accountID,
    accountLabel: input.accountLabel,
    status: "ready",
    source: input.source ?? "direct-request-budget",
    estimatedRequests: floorRequestCount(remaining),
    remainingPercent: input.report.exhaustedObserved ? 0 : input.report.remainingPercent,
    resetAt: input.report.resetAt,
    personalized: input.report.accuracy === "server-confirmed",
    evidence: {
      observations: input.report.usedObserved,
      requestEffectiveSamples: input.report.usedObserved,
      sessionEffectiveSamples: input.report.usedObserved,
    },
  }
}

function workbuddyProvider(input: {
  summary: ProviderSummary
  result: ProviderResult
  providerIDs: readonly string[]
}): Provider {
  const usage = input.result.usage
  const providerID = input.providerIDs[0] ?? "workbuddy"
  if (!usage) return emptyProvider(input.summary, input.providerIDs, input.result)

  const estimates: Estimate[] = []
  const accountMap = new Map<
    string,
    { accountID: string; accountLabel?: string; estimates: Estimate[] }
  >()
  const accounts = usage.workbuddyAccounts ?? []
  const labels = usage.accountLabels ?? {}

  const ensureAccount = (accountID: string, accountLabel?: string) => {
    let current = accountMap.get(accountID)
    if (!current) {
      current = { accountID, ...(accountLabel ? { accountLabel } : {}), estimates: [] }
      accountMap.set(accountID, current)
    }
    return current
  }

  for (const [modelID, metadata] of Object.entries(usage.models ?? {})) {
    const rate = metadata.rate

    if (metadata.rateFree === true) {
      const candidates: Estimate[] = []
      for (const account of accounts) {
        const report = modelReport(account.models, modelID)
        if (!report) continue
        const estimate = reportEstimate({
          providerID,
          modelID,
          accountID: account.accountId,
          accountLabel: account.label,
          report,
        })
        if (!estimate) continue
        candidates.push(estimate)
        ensureAccount(account.accountId, account.label).estimates.push(estimate)
      }
      const best = candidates
        .slice()
        .sort((a, b) => (b.estimatedRequests ?? -1) - (a.estimatedRequests ?? -1))[0]
      if (best) estimates.push({ ...best, accountID: undefined, accountLabel: undefined })
      continue
    }

    if (!(rate !== undefined && rate > 0)) continue

    const aggregate = usage.windows["aggregate:basic"]
    const remaining =
      aggregate?.resource?.kind === "credits" ? aggregate.resource.remaining : null

    if (remaining !== null && remaining !== undefined) {
      estimates.push({
        providerID,
        modelID,
        status: "ready",
        source: "published-request-rate",
        estimatedRequests: floorRequestCount(remaining / rate),
        remainingPercent: aggregate?.remainingPercent ?? null,
        resetAt: aggregate?.resetAt ?? null,
        personalized: false,
        evidence: EMPTY_EVIDENCE,
      })
    }

    for (const [accountID, label] of Object.entries(labels)) {
      const window = accountWindow(usage.windows, label)
      const credits =
        window?.resource?.kind === "credits" ? window.resource.remaining : null
      if (credits === null || credits === undefined) continue

      const observed = accounts.find((account) => account.accountId === accountID)
      const report = observed ? modelReport(observed.models, modelID) : undefined
      const observedRate =
        report && report.creditsObserved > 0 && report.usedObserved > 0
          ? report.creditsObserved / report.usedObserved
          : undefined
      const effectiveRate = observedRate && observedRate > 0 ? observedRate : rate

      const estimate: Estimate = {
        providerID,
        modelID,
        accountID,
        accountLabel: label,
        status: "ready",
        source: observedRate ? "provider-observed-burn" : "published-request-rate",
        estimatedRequests: floorRequestCount(credits / effectiveRate),
        remainingPercent: window?.remainingPercent ?? null,
        resetAt: window?.resetAt ?? null,
        personalized: observedRate !== undefined,
        evidence: {
          observations: report?.usedObserved ?? 0,
          requestEffectiveSamples: report?.usedObserved ?? 0,
          sessionEffectiveSamples: report?.usedObserved ?? 0,
        },
      }
      ensureAccount(accountID, label).estimates.push(estimate)
    }
  }

  return {
    quotaProviderID: input.summary.providerId,
    providerName: input.result.providerName,
    modelProviderIDs: [...input.providerIDs],
    status: "ok",
    defaultEstimates: [],
    estimates,
    accounts: [...accountMap.values()],
  }
}

function creditMoneyProvider(input: {
  summary: ProviderSummary
  result: ProviderResult
  providerIDs: readonly string[]
  candidates: readonly CapacityModelCandidate[]
  entries: readonly UsageYield.Entry[]
  at: number
}): Provider | undefined {
  const usage = input.result.usage
  if (!usage) return undefined

  const convertible = Object.entries(usage.windows)
    .filter(([, window]) => {
      if (window.resetAt !== null && window.resetAt <= input.at) return false
      const resource = window.resource
      return (
        resource?.kind === "credits" &&
        resource.remaining !== null &&
        resource.usdPerUnit !== undefined &&
        resource.usdPerUnit > 0
      )
    })
    .map(([key, window]) => {
      const resource = window.resource!
      return windowInput(key, window, Math.max(0, resource.remaining! * resource.usdPerUnit!))
    })

  const binding = convertible.slice().sort((a, b) => a.remaining - b.remaining)[0]
  if (!binding) return undefined

  return {
    quotaProviderID: input.summary.providerId,
    providerName: input.result.providerName,
    modelProviderIDs: [...input.providerIDs],
    status: "ok",
    defaultEstimates: [],
    estimates: moneyEstimates(
      priceCandidates(input.candidates, stateMapFor(input.entries)),
      convertible,
      binding.id,
    ),
    accounts: [],
  }
}

function zenProvider(input: {
  summary: ProviderSummary
  result: ProviderResult
  providerIDs: readonly string[]
  at: number
}): Provider {
  const usage = input.result.usage
  if (!usage) return emptyProvider(input.summary, input.providerIDs, input.result)

  const providerID = input.providerIDs[0] ?? "opencode"
  const defaults = directRequestDefaults({
    providerIDs: input.providerIDs,
    result: input.result,
    at: input.at,
  })
  const accounts: Account[] = []

  for (const key of usage.zenAccounts ?? []) {
    const remaining =
      key.exhausted
        ? 0
        : key.limitEstimate !== null && key.usedObserved !== null
          ? Math.max(0, key.limitEstimate - key.usedObserved)
          : null

    const estimate: Estimate = {
      providerID,
      accountID: key.keyId,
      accountLabel: key.label,
      status: remaining === null ? "learning" : "ready",
      source: remaining === null ? "insufficient-evidence" : "direct-request-budget",
      estimatedRequests: remaining === null ? null : floorRequestCount(remaining),
      remainingPercent: key.exhausted ? 0 : key.remainingPercent,
      resetAt: key.resetAt,
      personalized: key.estimateSource === "learned",
      ...(remaining === null
        ? { reason: "Provider request cap is still being learned from observed limit hits." }
        : {}),
      evidence: {
        observations: key.usedObserved ?? 0,
        requestEffectiveSamples: key.usedObserved ?? 0,
        sessionEffectiveSamples: key.usedObserved ?? 0,
      },
    }

    accounts.push({
      accountID: key.keyId,
      accountLabel: key.label,
      defaultEstimate: estimate,
      estimates: [],
    })
  }

  return {
    quotaProviderID: input.summary.providerId,
    providerName: input.result.providerName,
    modelProviderIDs: [...input.providerIDs],
    status: "ok",
    defaultEstimates: defaults,
    estimates: [],
    accounts,
  }
}


function remainingResource(window: UsageWindow) {
  const resource = window.resource
  if (!resource) return undefined
  if (resource.remaining !== null && Number.isFinite(resource.remaining)) {
    return Math.max(0, resource.remaining)
  }
  if (
    resource.limit !== null &&
    resource.used !== null &&
    Number.isFinite(resource.limit) &&
    Number.isFinite(resource.used)
  ) {
    return Math.max(0, resource.limit - resource.used)
  }
  return undefined
}

function learnedBurnProvider(input: {
  summary: ProviderSummary
  result: ProviderResult
  providerIDs: readonly string[]
  candidates: readonly CapacityModelCandidate[]
  burns: readonly BurnEstimate[]
  at: number
}): Provider | undefined {
  const usage = input.result.usage
  if (!usage || input.burns.length === 0) return undefined

  const estimates: Estimate[] = []
  for (const candidate of input.candidates) {
    const { providerID, model } = candidate
    const candidates = Object.entries(usage.windows).flatMap(([windowKey, window]) => {
      if (window.resetAt !== null && window.resetAt <= input.at) return []
      const resource = window.resource
      if (!resource || resource.kind === "requests") return []
      const remaining = remainingResource(window)
      if (remaining === undefined) return []

      const matching = input.burns.filter(
        (burn) =>
          burn.quotaProviderID === input.summary.providerId &&
          burn.windowKey === windowKey &&
          burn.providerID === providerID &&
          burn.resourceKind === resource.kind &&
          burn.unit === resource.unit,
      )
      const exact = matching.find((burn) => burn.modelID === model.id)
      const fallback = matching.find((burn) => burn.modelID === undefined)
      const burn = exact ?? fallback
      if (!burn || !(burn.burnPerRequest > 0)) return []

      return [{
        count: remaining / burn.burnPerRequest,
        windowKey,
        window,
        burn,
      }]
    })

    // Burn is learned per window, so each window that produced an observed
    // remaining resource is independently projectable here.
    const projected = candidates
      .filter((candidate) => Number.isFinite(candidate.count) && candidate.count >= 0)
      .sort((a, b) => a.count - b.count)
    const binding = projected[0]
    if (!binding) continue

    const windows: Window[] = projected.map((entry) => ({
      id: entry.windowKey,
      label: windowLabel(entry.windowKey, entry.window),
      basis: "observed-remaining",
      status: "ready",
      source: "provider-observed-burn",
      estimatedRequests: floorRequestCount(entry.count),
      remainingPercent: entry.window.remainingPercent,
      resetAt: entry.window.resetAt,
      // A provider-wide "*" burn is useful shrinkage/fallback evidence, but
      // it is not evidence about this exact model and must not be labelled
      // as model-personalized.
      personalized: entry.burn.modelID === model.id,
    }))

    estimates.push({
      providerID,
      modelID: model.id,
      status: "ready",
      source: "provider-observed-burn",
      estimatedRequests: floorRequestCount(binding.count),
      remainingPercent: binding.window.remainingPercent,
      resetAt: binding.window.resetAt,
      // A provider-wide "*" burn is useful shrinkage/fallback evidence, but
      // it is not evidence about this exact model and must not be labelled
      // as model-personalized.
      personalized: binding.burn.modelID === model.id,
      limitingWindow: binding.windowKey,
      evidence: {
        observations: binding.burn.observations,
        requestEffectiveSamples: binding.burn.effectiveSamples,
        sessionEffectiveSamples: binding.burn.effectiveSamples,
      },
      windows: boundedCapacityWindows(windows, binding.windowKey),
    })
  }

  if (estimates.length === 0) return undefined
  return {
    quotaProviderID: input.summary.providerId,
    providerName: input.result.providerName,
    modelProviderIDs: [...input.providerIDs],
    status: "ok",
    defaultEstimates: [],
    estimates,
    accounts: [],
  }
}

export function buildProvider(input: {
  readonly summary: ProviderSummary
  readonly result: ProviderResult
  readonly catalog: Record<string, ModelsDev.Provider>
  readonly entries: readonly UsageYield.Entry[]
  readonly burns?: readonly BurnEstimate[]
  readonly at?: number
  /** Bound on projected models per provider; defaults to MAX_PROVIDER_MODEL_ESTIMATES. */
  readonly modelLimit?: number
}): Provider {
  const at = input.at ?? Date.now()
  const providerIDs = modelProviderIDs(input.summary, input.catalog)

  if (!input.result.configured || !input.result.ok || !input.result.usage) {
    return emptyProvider(input.summary, providerIDs, input.result)
  }

  if (input.summary.providerId === "workbuddy") {
    return workbuddyProvider({
      summary: input.summary,
      result: input.result,
      providerIDs,
    })
  }

  if (input.summary.providerId === "opencode-zen") {
    return zenProvider({
      summary: input.summary,
      result: input.result,
      providerIDs,
      at,
    })
  }

  const direct = directRequestDefaults({
    providerIDs,
    result: input.result,
    at,
  })

  if (direct.length > 0) {
    return {
      quotaProviderID: input.summary.providerId,
      providerName: input.result.providerName,
      modelProviderIDs: providerIDs,
      status: "ok",
      defaultEstimates: direct,
      estimates: [],
      accounts: [],
    }
  }

  // One bounded candidate set for every catalog-driven projection below, so
  // CPU and payload stay flat as a provider's catalog grows. Observed personal
  // scopes are admitted first.
  const candidates = capacityModelCandidates({
    providerIDs,
    catalog: input.catalog,
    entries: input.entries,
    ...(input.modelLimit !== undefined ? { limit: input.modelLimit } : {}),
  })

  const learned = learnedBurnProvider({
    summary: input.summary,
    result: input.result,
    providerIDs,
    candidates,
    burns: input.burns ?? [],
    at,
  })
  if (learned) return learned

  const hasMoney = Object.values(input.result.usage.windows).some(
    (window) => window.resource?.kind === "money",
  )
  if (hasMoney) {
    return moneyProvider({
      summary: input.summary,
      result: input.result,
      providerIDs,
      candidates,
      entries: input.entries,
      at,
    })
  }

  const creditMoney = creditMoneyProvider({
    summary: input.summary,
    result: input.result,
    providerIDs,
    candidates,
    entries: input.entries,
    at,
  })
  if (creditMoney) return creditMoney

  const hasMeteredResource = Object.values(input.result.usage.windows).some(
    (window) => window.resource !== undefined,
  )

  if (hasMeteredResource) {
    return learningProvider(
      input.summary,
      providerIDs,
      input.result,
      "Quota is available, but this provider's resource-to-request burn is still being learned from observed usage.",
      at,
    )
  }

  return learningProvider(
    input.summary,
    providerIDs,
    input.result,
    "The provider exposes quota telemetry but not enough machine-readable resource semantics for a request projection yet.",
    at,
  )
}
