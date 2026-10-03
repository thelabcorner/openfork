import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { UsageYield } from "@opencode-ai/core/usage/yield"
import { UsageHistoryWatermark } from "@opencode-ai/core/usage/history-watermark"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import {
  effectiveSamples,
  momentsFor,
  sessionMomentsFor,
  snapshotYieldStatistic,
  statisticalKeyID,
  type YieldStatisticState,
} from "@opencode-ai/core/usage/yield-statistics"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import { GoCapacityPrior } from "./go-prior"
import * as ProviderCapacity from "./provider-capacity"
import * as ResourceLearning from "./resource-learning"
import * as GeneralUsage from "./general-usage"
import type { ProviderResult, ProviderSummary } from "@/quota/schema"

export const GoEvidence = Schema.Struct({
  observations: Schema.Finite,
  requestEffectiveSamples: Schema.Finite,
  sessionEffectiveSamples: Schema.Finite,
  personalWeight: Schema.Finite,
  baseObservations: Schema.Finite,
  baseRequestEffectiveSamples: Schema.Finite,
  baseSessionEffectiveSamples: Schema.Finite,
  basePersonalWeight: Schema.Finite,
  accountObservations: Schema.Finite,
  accountRequestEffectiveSamples: Schema.Finite,
  accountSessionEffectiveSamples: Schema.Finite,
  accountPersonalWeight: Schema.Finite,
  localRequestsApplied: Schema.Finite,
  localFractionConsumed: Schema.Finite,
  localUnnormalizedRequests: Schema.Finite,
})

export const GoPredictiveRange = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("learning"),
    effectiveSamples: Schema.Finite,
    matureAt: Schema.Finite,
  }),
  Schema.Struct({
    status: Schema.Literal("calibrated"),
    effectiveSamples: Schema.Finite,
    matureAt: Schema.Finite,
    targetCoverage: Schema.Finite,
    heldOutCoverage: Schema.Finite,
    calibrationBudget: Schema.Union([Schema.Literal(5), Schema.Literal(20), Schema.Literal(100)]),
    lowerRequests: Schema.Finite,
    upperRequests: Schema.Finite,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    effectiveSamples: Schema.Finite,
    matureAt: Schema.Finite,
    reason: Schema.Literal("incomplete-local-accounting"),
  }),
])
export type GoPredictiveRange = Schema.Schema.Type<typeof GoPredictiveRange>

/**
 * Full-window request capacity for one published quota window.
 *
 * This is a DIFFERENT quantity from `estimatedRequests` on the same estimate:
 * that one is requests remaining in the current 5h window, while this one is
 * how many requests of THIS model's typical published size the whole window
 * affords. Capacity divides the published window limit by the same workload
 * posterior as the remaining line, so the two stay consistent
 * (`estimatedRequests ≈ remainingFraction x windowCapacity["5h"].pointRequests`)
 * without the client ever recomputing either.
 *
 * A window appears only when the provider published a real limit for it. There
 * is no synthesized or cross-provider fallback value, so an absent window means
 * "no authoritative support", never "zero requests".
 *
 * `remaining` carries the OTHER half of the answer, and only where it is
 * actually known: requests still available in THIS window when the official
 * snapshot really reported that window's consumption. An absent `remaining`
 * means the window's consumption is unknown, never zero, and never borrowed
 * from the 5h window.
 *
 * There is deliberately NO predictive range on these rows. The deployed
 * `GoPredictiveRange` is a 5h renewal/stopping-time calibration validated
 * against realized counts of requests until the next 5h reset; it was never
 * validated for full-window totals or for weekly/monthly stopping behaviour, so
 * attaching it to a window total would claim coverage that was not measured. A
 * consumer that wants a sensitivity band for a full-window total must derive
 * one from its own representative request corpus, and must not call it a
 * confidence interval.
 */
export const GoWindowRemaining = Schema.Struct({
  /** Real official remaining percentage for this window, 0-100. */
  remainingPercent: Schema.Finite,
  /** Requests still available in this window; null when the read fails closed. */
  remainingRequests: Schema.NullOr(Schema.Finite),
 /** Real reset boundary of this window; absent when the provider reported none. */
  resetAt: Schema.optional(Schema.Finite),
  status: Schema.Literals(["ready", "unavailable"]),
})
export type GoWindowRemaining = Schema.Schema.Type<typeof GoWindowRemaining>

export const GoWindowCapacity = Schema.Struct({
  window: Schema.Literals(["5h", "week", "month"]),
  /** Published full-window limit, in typical request-equivalents. */
  baselineRequests: Schema.Finite,
  /** Full-window capacity under the same workload posterior as the remaining line. */
  pointRequests: Schema.Finite,
  /** Observed remaining capacity for this window; absent when not observed. */
  remaining: Schema.optional(GoWindowRemaining),
})
export type GoWindowCapacity = Schema.Schema.Type<typeof GoWindowCapacity>

export const GoEstimate = Schema.Struct({
  modelID: Schema.String,
  accountID: Schema.optional(Schema.String),
  baselineRequests: Schema.Finite,
  estimatedRequests: Schema.Finite,
  remainingFraction: Schema.Finite,
  remainingPercent: Schema.Finite,
  workloadMultiplier: Schema.Finite,
  workloadSource: Schema.Literals(["published-prior", "personal-base", "account-hierarchical"]),
  personalized: Schema.Boolean,
  resetAt: Schema.Finite,
  quotaStatus: Schema.Literals(["ok", "stale"]),
  projectionStatus: Schema.Literals(["ok", "incomplete-local-accounting"]),
  predictiveRange: GoPredictiveRange,
  /**
   * Full-window request capacity per published window, in window order. Additive
   * relative to the remaining-5h fields above; absent on older servers.
   */
  windowCapacity: Schema.Array(GoWindowCapacity),
  evidence: GoEvidence,
})
export type GoEstimate = Schema.Schema.Type<typeof GoEstimate>

export const GoAccountEstimate = Schema.Struct({
  accountID: Schema.String,
  estimates: Schema.Array(GoEstimate),
})
export type GoAccountEstimate = Schema.Schema.Type<typeof GoAccountEstimate>

export const GoSnapshot = Schema.Struct({
  providerID: Schema.Literal("opencode-go"),
  priorStatus: Schema.Literals(["ok", "stale", "error"]),
  priorFetchedAt: Schema.Finite,
  routedAccountID: Schema.optional(Schema.String),
  routed: Schema.Array(GoEstimate),
  accounts: Schema.Array(GoAccountEstimate),
})
export type GoSnapshot = Schema.Schema.Type<typeof GoSnapshot>

/**
 * Additive generalized Capacity envelope.
 *
 * The historical top-level Go fields remain intact for rolling compatibility.
 * The providers field is the canonical cross-provider projection consumed by new UI.
 */
export const Snapshot = Schema.Struct({
  providerID: Schema.Literal("opencode-go"),
  priorStatus: Schema.Literals(["ok", "stale", "error"]),
  priorFetchedAt: Schema.Finite,
  routedAccountID: Schema.optional(Schema.String),
  routed: Schema.Array(GoEstimate),
  accounts: Schema.Array(GoAccountEstimate),
  providers: Schema.Array(ProviderCapacity.Provider),
  generalUsage: GeneralUsage.Snapshot,
})
export type Snapshot = Schema.Schema.Type<typeof Snapshot>

export interface GoResource {
  readonly accountID: string
  readonly credentialID?: string
  readonly remainingFraction: number
  readonly resetAt: number
  readonly snapshotAt: number
  readonly status: "ok" | "stale"
  readonly localRequestsApplied?: number
  readonly localFractionConsumed?: number
  readonly localUnnormalizedRequests?: number
  /**
   * Observed non-primary windows (week/month) carried by the SAME official
   * snapshot that produced the primary 5h resource above. No extra provider
   * read is involved; this is the already-merged weekly/monthly telemetry.
   */
  readonly observedWindows?: readonly GoObservedWindow[]
}

/**
 * One non-primary Go window whose consumption the official snapshot really
 * reported. `5h` is the primary resource and is deliberately not repeated
 * here.
 */
export interface GoObservedWindow {
  readonly window: "week" | "month"
  readonly remainingFraction: number
  readonly resetAt?: number
  /** Local post-snapshot burn that could not be normalized into this window. */
  readonly unnormalizedRequests?: number
}

export interface LocalSettlement {
  readonly messageID?: string
  readonly credentialID?: string
  readonly accountID?: string
  readonly modelID: string
  /** Materialized canonical id from usage_record; legacy rows may not have it. */
  readonly baseModelID?: string
  readonly completedAt: number
  readonly tokens: {
    readonly input: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly output: number
    readonly reasoning: number
  }
}

export interface GoInput {
  readonly routedAccountID?: string
  readonly accounts: readonly GoResource[]
  readonly at?: number
}

export interface ProvidersInput {
  readonly summaries: readonly ProviderSummary[]
  readonly results: readonly ProviderResult[]
  readonly at?: number
}

export interface Interface {
  readonly go: (input: GoInput) => Effect.Effect<GoSnapshot>
  /** Fast local-only generalized workload projection; performs no provider I/O. */
  readonly general: () => Effect.Effect<GeneralUsage.Snapshot>
  readonly providers: (input: ProvidersInput) => Effect.Effect<{
    readonly providers: ProviderCapacity.Provider[]
    readonly generalUsage: GeneralUsage.Snapshot
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Capacity") {}

// Chronological Go replay (2026-09-21): h=8 is the stable session-aware
// winner across row-weighted and account-balanced views. One base prior
// equivalent remains a robust near-tie with substantially lower bias than the
// more aggressive 0.5 candidate. Account-specific effects are weakly
// identified (only three physical account scopes in the tuning era), so the
// account overlay is deliberately regularized hard toward the already
// personalized base-model posterior. It still moves on the first account
// observation; there is no minimum-sample gate.
export const GO_CAPACITY_CALIBRATION = {
  personalHalfLife: 8,
  basePriorEquivalent: 1,
  accountPriorEquivalent: 32,
} as const

/**
 * Chronological renewal/stopping-time calibration for the deployed hierarchical
 * workload predictor. The range is only exposed after session-aware evidence is
 * mature enough for held-out coverage to remain close to the nominal target.
 *
 * Budgets are measured in "typical request-equivalents" of the remaining 5h
 * entitlement, not request counts. Runtime selection uses nearest-neighbor in
 * log-budget space because the calibrated error is multiplicative/log-residual.
 *
 * 2026-09-21 replay, held-out mature-band coverage:
 *   5   -> 0.7751
 *   20  -> 0.7995
 *   100 -> 0.8012
 *
 * These are predictive ranges, not formal confidence intervals.
 */
export const GO_CAPACITY_PREDICTIVE_RANGE = {
  matureSessionEffectiveSamples: 12,
  targetCoverage: 0.8,
  budgets: {
    5: {
      lowerMultiplier: 0.9409903567279773,
      upperMultiplier: 4.022754522132202,
      heldOutCoverage: 0.7751349527665317,
    },
    20: {
      lowerMultiplier: 0.697654881674343,
      upperMultiplier: 2.668201377119912,
      heldOutCoverage: 0.7994584532069724,
    },
    100: {
      lowerMultiplier: 0.4687364892098214,
      upperMultiplier: 2.0524832243135616,
      heldOutCoverage: 0.8011976047904191,
    },
  },
} as const

type PredictiveBudget = keyof typeof GO_CAPACITY_PREDICTIVE_RANGE.budgets

/**
 * Windows Capacity publishes a full-window request capacity for, in display
 * order. Every one of these is a window the upstream OpenCode Go table actually
 * publishes a per-model request limit for, so no window here needs a
 * synthesized value.
 */
const GO_CAPACITY_WINDOWS: readonly GoCapacityPrior.Window[] = ["5h", "week", "month"]

type WindowDebit = { fraction: number; requests: number; unnormalized: number }

/**
 * The observed remaining fraction for one window, or undefined when that
 * window's consumption was never actually observed.
 *
 * The 5h window is the primary resource. Every other window must be carried
 * explicitly by the caller, which is what stops a 5h percentage from being
 * restated as a weekly or monthly one.
 */
function goWindowObservation(
  resource: GoResource,
  window: GoCapacityPrior.Window,
): { remainingFraction: number; resetAt?: number; unnormalized: number } | undefined {
  if (window === "5h") {
    return {
      remainingFraction: clampFraction(resource.remainingFraction),
      resetAt: resource.resetAt,
      unnormalized: resource.localUnnormalizedRequests ?? 0,
    }
  }
  const observed = resource.observedWindows?.find((entry) => entry.window === window)
  if (!observed) return undefined
  return {
    remainingFraction: clampFraction(observed.remainingFraction),
    ...(observed.resetAt !== undefined ? { resetAt: observed.resetAt } : {}),
    unnormalized: observed.unnormalizedRequests ?? 0,
  }
}

function predictiveBudgetFor(budgetRequests: number): PredictiveBudget {
  if (!(budgetRequests > 0)) return 5
  if (budgetRequests <= Math.sqrt(5 * 20)) return 5
  if (budgetRequests <= Math.sqrt(20 * 100)) return 20
  return 100
}

/**
 * Calibrated multiplicative uncertainty around a point request count.
 *
 * `budgetRequests` is the typical request-equivalent scale of the window the
 * point was drawn from: the remaining 5h entitlement for the requests-left
 * line, or the whole published window limit for a full-window capacity row. The
 * calibrated error is multiplicative (log-residual), so the same budget ladder
 * and the same calibration numbers apply at either scale — only the absolute
 * size of the entitlement decides which neighbor band is selected.
 *
 * Passing the window's own baseline (rather than a near-zero remaining
 * fraction) is what keeps a nearly-exhausted window from collapsing into a
 * degenerate "0 requests, range 0-0" instead of an honest full-window capacity.
 */
function predictiveRange(input: {
  readonly pointRequests: number
  readonly budgetRequests: number
  readonly effectiveSamples: number
  readonly projectionStatus: GoEstimate["projectionStatus"]
}): GoPredictiveRange {
  const matureAt = GO_CAPACITY_PREDICTIVE_RANGE.matureSessionEffectiveSamples
  if (input.projectionStatus !== "ok") {
    return {
      status: "unavailable",
      effectiveSamples: input.effectiveSamples,
      matureAt,
      reason: "incomplete-local-accounting",
    }
  }
  if (input.effectiveSamples < matureAt) {
    return {
      status: "learning",
      effectiveSamples: input.effectiveSamples,
      matureAt,
    }
  }

  const calibrationBudget = predictiveBudgetFor(input.budgetRequests)
  const calibration = GO_CAPACITY_PREDICTIVE_RANGE.budgets[calibrationBudget]
  const point = Math.max(0, input.pointRequests)
  return {
    status: "calibrated",
    effectiveSamples: input.effectiveSamples,
    matureAt,
    targetCoverage: GO_CAPACITY_PREDICTIVE_RANGE.targetCoverage,
    heldOutCoverage: calibration.heldOutCoverage,
    calibrationBudget,
    lowerRequests: floorRequestCount(point * calibration.lowerMultiplier),
    upperRequests: ceilRequestCount(point * calibration.upperMultiplier),
  }
}

function clampFraction(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function floorRequestCount(value: number) {
  if (!(value > 0) || !Number.isFinite(value)) return 0
  return Math.floor(value + Math.max(1e-9, value * Number.EPSILON * 8))
}

function ceilRequestCount(value: number) {
  if (!(value > 0) || !Number.isFinite(value)) return 0
  return Math.ceil(value - Math.max(1e-9, value * Number.EPSILON * 8))
}

function recentPriceMean(prior: GoCapacityPrior.ModelPrior, state: YieldStatisticState) {
  if (state.recent.length === 0) return undefined
  const rho = 0.5 ** (1 / GO_CAPACITY_CALIBRATION.personalHalfLife)
  let weight = 0
  let sum = 0

  for (let index = 0; index < state.recent.length; index++) {
    const observation = state.recent[index]!
    const age = state.recent.length - 1 - index
    const currentWeight = rho ** age
    const cost = GoCapacityPrior.priceTokens(prior, {
      input: observation.tokens[0],
      cacheRead: observation.tokens[1],
      cacheWrite: observation.tokens[2],
      output: observation.tokens[3],
      reasoning: observation.tokens[4],
    })
    if (!(cost !== undefined && Number.isFinite(cost) && cost > 0)) continue
    weight += currentWeight
    sum += currentWeight * cost
  }

  return weight > 0 ? sum / weight : undefined
}

type WorkloadPosterior = {
  readonly multiplier: number
  readonly observations: number
  readonly requestEffectiveSamples: number
  readonly sessionEffectiveSamples: number
  readonly personalWeight: number
}

function workloadPosterior(input: {
  readonly prior: GoCapacityPrior.ModelPrior
  readonly state?: YieldStatisticState
  readonly priorMultiplier: number
  readonly priorEquivalent: number
  readonly publishedTypicalCost: number | undefined
}): WorkloadPosterior {
  if (!input.state || !(input.publishedTypicalCost !== undefined && input.publishedTypicalCost > 0)) {
    return {
      multiplier: input.priorMultiplier,
      observations: 0,
      requestEffectiveSamples: 0,
      sessionEffectiveSamples: 0,
      personalWeight: 0,
    }
  }

  const state = snapshotYieldStatistic(input.state)
  const requestMoments = momentsFor(state, GO_CAPACITY_CALIBRATION.personalHalfLife)
  const sessionMoments = sessionMomentsFor(state, GO_CAPACITY_CALIBRATION.personalHalfLife)
  const requestEffectiveSamples = requestMoments ? effectiveSamples(requestMoments) : 0
  const sessionEffectiveSamples = sessionMoments ? effectiveSamples(sessionMoments) : 0
  const independentSamples = Math.min(requestEffectiveSamples, sessionEffectiveSamples)
  const personalMeanCost = recentPriceMean(input.prior, state)
  const personalMeanMultiplier =
    personalMeanCost !== undefined && personalMeanCost > 0
      ? personalMeanCost / input.publishedTypicalCost
      : undefined

  if (!(personalMeanMultiplier !== undefined && personalMeanMultiplier > 0 && independentSamples > 0)) {
    return {
      multiplier: input.priorMultiplier,
      observations: state.observations,
      requestEffectiveSamples,
      sessionEffectiveSamples,
      personalWeight: 0,
    }
  }

  const denominator = input.priorEquivalent + independentSamples
  const multiplier =
    (input.priorEquivalent * input.priorMultiplier + independentSamples * personalMeanMultiplier) /
    denominator
  if (!(Number.isFinite(multiplier) && multiplier > 0)) {
    return {
      multiplier: input.priorMultiplier,
      observations: state.observations,
      requestEffectiveSamples,
      sessionEffectiveSamples,
      personalWeight: 0,
    }
  }

  return {
    multiplier,
    observations: state.observations,
    requestEffectiveSamples,
    sessionEffectiveSamples,
    personalWeight: independentSamples / denominator,
  }
}

export function estimateGoModel(input: {
  readonly prior: GoCapacityPrior.ModelPrior
  readonly resource: GoResource
  /** Account-neutral personal model history. */
  readonly state?: YieldStatisticState
  /** Sparse physical-account overlay, shrunk toward the base-model posterior. */
  readonly accountState?: YieldStatisticState
  readonly at?: number
}): GoEstimate {
  const at = input.at ?? Date.now()
  const remainingFraction = clampFraction(input.resource.remainingFraction)
  const baselineRequests = GoCapacityPrior.requestsAt(input.prior, "5h", at)
  const publishedTypicalCost = GoCapacityPrior.priceTypical(input.prior)

  // Level 1: published model prior -> durable personal base-model posterior.
  // Correlated requests are capped by contiguous-session-block ESS.
  const base = workloadPosterior({
    prior: input.prior,
    state: input.state,
    priorMultiplier: 1,
    priorEquivalent: GO_CAPACITY_CALIBRATION.basePriorEquivalent,
    publishedTypicalCost,
  })

  // Level 2: personal base-model posterior -> physical-account overlay.
  // The account prior is deliberately strong because the chronological tuning
  // prefix contains too few independent account scopes to support an aggressive
  // account effect. This is continuous shrinkage, never an n-based gate.
  const account = workloadPosterior({
    prior: input.prior,
    state: input.accountState,
    priorMultiplier: base.multiplier,
    priorEquivalent: GO_CAPACITY_CALIBRATION.accountPriorEquivalent,
    publishedTypicalCost,
  })

  const workloadMultiplier = account.multiplier
  const personalized = base.personalWeight > 0 || account.personalWeight > 0
  const workloadSource =
    account.personalWeight > 0
      ? "account-hierarchical" as const
      : base.personalWeight > 0
        ? "personal-base" as const
        : "published-prior" as const

  // Preserve the legacy aggregate evidence fields as a view of the
  // posterior level that actually contributed. Merely having an account state
  // object is not enough: an unpriceable/zero-evidence account state must not
  // hide valid base-model evidence.
  const active = account.personalWeight > 0 ? account : base
  const personalWeight =
    account.personalWeight > 0
      ? 1 - (1 - base.personalWeight) * (1 - account.personalWeight)
      : base.personalWeight

  const localUnnormalizedRequests = input.resource.localUnnormalizedRequests ?? 0
  const projectionStatus = localUnnormalizedRequests > 0 ? "incomplete-local-accounting" as const : "ok" as const
  const remainingTypicalRequests = remainingFraction * baselineRequests
  const pointRequests =
    projectionStatus === "ok" && baselineRequests > 0 && workloadMultiplier > 0
      ? Math.max(0, remainingTypicalRequests / workloadMultiplier)
      : 0
  const estimatedRequests = floorRequestCount(pointRequests)

  // The replay's uncertainty evidence follows the level whose account-specific
  // state exists, matching selectedEvidence() in go-capacity-prequential.ts.
  // This is intentionally separate from posterior weight: one sparse account
  // observation is enough to make the account overlay the uncertain quantity.
  const predictiveEffectiveSamples =
    account.observations > 0 ? account.sessionEffectiveSamples : base.sessionEffectiveSamples
  const range = predictiveRange({
    pointRequests,
    budgetRequests: remainingTypicalRequests,
    effectiveSamples: predictiveEffectiveSamples,
    projectionStatus,
  })

  // Full-window capacity: the published window limit personalized by the same
  // workload posterior. Deliberately NOT `pointRequests / remainingFraction` —
  // that would invert a near-zero remainder into an unbounded claim. The
  // multiplier is a per-request size ratio, so it applies to a whole window
  // exactly as it does to the remaining slice of one.
  //
  // `projectionStatus` is intentionally forced to "ok" here. Incomplete local
  // accounting invalidates the *remaining* fraction, never the published window
  // limit or the personal request-size posterior, so a capacity row stays
  // usable in precisely the case where the requests-left line fails closed.
  const windowCapacity = GO_CAPACITY_WINDOWS.flatMap((window): GoWindowCapacity[] => {
    const windowBaseline = GoCapacityPrior.requestsAt(input.prior, window, at)
    if (!(Number.isFinite(windowBaseline) && windowBaseline > 0 && workloadMultiplier > 0)) return []
    const windowPoint = windowBaseline / workloadMultiplier
    if (!(Number.isFinite(windowPoint) && windowPoint > 0)) return []
    // Remaining capacity is published only for a window whose consumption was
    // really observed, and it reuses the SAME published limit and the SAME
    // workload multiplier as the capacity row beside it. Ambiguous local
    // accounting fails this line closed; it never invalidates the capacity row.
    const observation = goWindowObservation(input.resource, window)
    const remaining: GoWindowRemaining | undefined = observation
      ? {
          remainingPercent: observation.remainingFraction * 100,
          remainingRequests:
            observation.unnormalized > 0
              ? null
              : floorRequestCount((windowBaseline * observation.remainingFraction) / workloadMultiplier),
          ...(observation.resetAt !== undefined ? { resetAt: observation.resetAt } : {}),
          status: observation.unnormalized > 0 ? ("unavailable" as const) : ("ready" as const),
        }
      : undefined
    return [{
      window,
      baselineRequests: windowBaseline,
      pointRequests: windowPoint,
      ...(remaining ? { remaining } : {}),
    }]
  })

  return {
    modelID: input.prior.modelID,
    accountID: input.resource.accountID,
    baselineRequests,
    estimatedRequests,
    remainingFraction,
    remainingPercent: remainingFraction * 100,
    workloadMultiplier,
    workloadSource,
    personalized,
    resetAt: input.resource.resetAt,
    quotaStatus: input.resource.status,
    projectionStatus,
    predictiveRange: range,
    windowCapacity,
    evidence: {
      observations: active.observations,
      requestEffectiveSamples: active.requestEffectiveSamples,
      sessionEffectiveSamples: active.sessionEffectiveSamples,
      personalWeight,
      baseObservations: base.observations,
      baseRequestEffectiveSamples: base.requestEffectiveSamples,
      baseSessionEffectiveSamples: base.sessionEffectiveSamples,
      basePersonalWeight: base.personalWeight,
      accountObservations: account.observations,
      accountRequestEffectiveSamples: account.requestEffectiveSamples,
      accountSessionEffectiveSamples: account.sessionEffectiveSamples,
      accountPersonalWeight: account.personalWeight,
      localRequestsApplied: input.resource.localRequestsApplied ?? 0,
      localFractionConsumed: input.resource.localFractionConsumed ?? 0,
      localUnnormalizedRequests,
    },
  }
}

export function applyLocalDepletion(input: {
  readonly prior: GoCapacityPrior.Snapshot
  readonly resources: readonly GoResource[]
  readonly settlements: readonly LocalSettlement[]
  readonly at?: number
}): GoResource[] {
  const at = input.at ?? Date.now()
  const priorByModel = new Map(input.prior.models.map((entry) => [entry.modelID, entry] as const))
  const byAccount = new Map(input.resources.map((resource) => [resource.accountID, resource] as const))
  const byCredential = new Map(
    input.resources.flatMap((resource) =>
      resource.credentialID ? [[resource.credentialID, resource] as const] : [],
    ),
  )
  // Local burn is debited per window in that window's own request-equivalent
  // units: one settled request costs a 5h window 1/requests_5h and a weekly
  // window 1/requests_week. Debiting one window with another window's
  // denominator is how a per-window projection becomes untruthful.
  const consumed = new Map<string, Map<GoCapacityPrior.Window, WindowDebit>>()
  const seenMessageIDs = new Set<string>()

  const currentFor = (resource: GoResource, window: GoCapacityPrior.Window): WindowDebit => {
    let byWindow = consumed.get(resource.accountID)
    if (!byWindow) {
      byWindow = new Map()
      consumed.set(resource.accountID, byWindow)
    }
    const current = byWindow.get(window) ?? { fraction: 0, requests: 0, unnormalized: 0 }
    byWindow.set(window, current)
    return current
  }
  const windowsFor = (resource: GoResource) => [
    ...new Set<GoCapacityPrior.Window>(["5h", ...(resource.observedWindows ?? []).map((entry) => entry.window)]),
  ]
  const windowResetAt = (resource: GoResource, window: GoCapacityPrior.Window) =>
    window === "5h"
      ? resource.resetAt
      : resource.observedWindows?.find((entry) => entry.window === window)?.resetAt
  const belongsToWindow = (resource: GoResource, window: GoCapacityPrior.Window, completedAt: number) => {
    if (completedAt <= resource.snapshotAt) return false
    const resetAt = windowResetAt(resource, window)
    // A window whose reset boundary is unknown cannot prove membership, so an
    // unverifiable debit is recorded as ambiguous instead of being skipped.
    return resetAt !== undefined && completedAt < resetAt
  }
  const belongsToSnapshotWindow = (resource: GoResource, completedAt: number) =>
    resource.resetAt > at && belongsToWindow(resource, "5h", completedAt)

  for (const settlement of input.settlements) {
    if (settlement.messageID) {
      if (seenMessageIDs.has(settlement.messageID)) continue
      seenMessageIDs.add(settlement.messageID)
    }

    // account_id is the authoritative physical account recorded by request
    // routing. A vault credential UUID is only a legacy/storage alias and may
    // be used when no routed account identity was persisted at all.
    const resource = settlement.accountID
      ? byAccount.get(settlement.accountID)
      : settlement.credentialID
        ? byCredential.get(settlement.credentialID)
        : undefined

    if (!settlement.accountID && !settlement.credentialID) {
      // We know resource was consumed after the official snapshot, but cannot
      // safely assign it to one account. Every account whose current 5h window
      // could contain the request is therefore non-projectable until a newer
      // official snapshot supersedes the ambiguity.
      for (const candidate of input.resources) {
        if (!belongsToSnapshotWindow(candidate, settlement.completedAt)) continue
        for (const window of windowsFor(candidate)) currentFor(candidate, window).unnormalized += 1
      }
      continue
    }

    // An explicit account that is not represented by this quota snapshot belongs
    // to some other account. Never fall back from an authoritative account_id to
    // a credential UUID and accidentally debit a different resource.
    if (!resource || !belongsToSnapshotWindow(resource, settlement.completedAt)) continue

    const modelID = settlement.baseModelID ?? splitAccountModelID(settlement.modelID).baseModelID
    const prior = priorByModel.get(modelID)
    const typicalCost = prior ? GoCapacityPrior.priceTypical(prior) : undefined
    const actualCost = prior ? GoCapacityPrior.priceTokens(prior, settlement.tokens) : undefined
    if (
      !(typicalCost !== undefined && typicalCost > 0) ||
      !(actualCost !== undefined && actualCost > 0)
    ) {
      for (const window of windowsFor(resource)) currentFor(resource, window).unnormalized += 1
      continue
    }

    const multiplier = actualCost / typicalCost
    if (!(Number.isFinite(multiplier) && multiplier > 0)) {
      for (const window of windowsFor(resource)) currentFor(resource, window).unnormalized += 1
      continue
    }

    for (const window of windowsFor(resource)) {
      if (!belongsToWindow(resource, window, settlement.completedAt)) continue
      const requests = prior ? GoCapacityPrior.requestsAt(prior, window, settlement.completedAt) : 0
      if (!(requests > 0)) {
        currentFor(resource, window).unnormalized += 1
        continue
      }
      const current = currentFor(resource, window)
      current.fraction += multiplier / requests
      current.requests += 1
    }
  }

  return input.resources.map((resource) => {
    const byWindow = consumed.get(resource.accountID)
    const debitFor = (window: GoCapacityPrior.Window): WindowDebit =>
      byWindow?.get(window) ?? { fraction: 0, requests: 0, unnormalized: 0 }
    const local = debitFor("5h")
    const fraction = Math.max(0, local?.fraction ?? 0)
    return {
      ...resource,
      remainingFraction: clampFraction(resource.remainingFraction - fraction),
      localRequestsApplied: local?.requests ?? 0,
      localFractionConsumed: fraction,
      localUnnormalizedRequests: local?.unnormalized ?? 0,
      ...(resource.observedWindows
        ? {
            observedWindows: resource.observedWindows.map((entry) => {
              const debit = debitFor(entry.window)
              return {
                window: entry.window,
                remainingFraction: clampFraction(entry.remainingFraction - Math.max(0, debit.fraction)),
                ...(entry.resetAt !== undefined ? { resetAt: entry.resetAt } : {}),
                ...(debit.unnormalized > 0 ? { unnormalizedRequests: debit.unnormalized } : {}),
              }
            }),
          }
        : {}),
    }
  })
}

/**
 * Clamp one resource's observed fractions and drop non-primary windows whose
 * reset boundary has already passed. An official percentage is evidence about
 * the window that produced it, so a reset week/month window is historical.
 */
function normalizeGoResource(resource: GoResource, at: number): GoResource {
  const observedWindows = resource.observedWindows?.flatMap((entry) =>
    entry.resetAt !== undefined && entry.resetAt <= at
      ? []
      : [{ ...entry, remainingFraction: clampFraction(entry.remainingFraction) }],
  )
  return {
    ...resource,
    remainingFraction: clampFraction(resource.remainingFraction),
    // Assigned unconditionally when a list existed: an emptied list must
    // REPLACE the original array, not fall back to it through the spread above.
    ...(observedWindows !== undefined ? { observedWindows } : {}),
  }
}

export function buildGoSnapshot(input: {
  readonly prior: GoCapacityPrior.Snapshot
  readonly resources: readonly GoResource[]
  readonly entries: readonly UsageYield.Entry[]
  readonly routedAccountID?: string
  readonly at?: number
}): GoSnapshot {
  const at = input.at ?? Date.now()
  const stateByKey = new Map(
    input.entries.map((entry) => [statisticalKeyID(entry.key), entry.state] as const),
  )
  const resources = new Map<string, GoResource>()
  for (const resource of input.resources) {
    // An official 5h snapshot is only evidence about the window that produced
    // it. Once that window has reset, never project its percentage into the new
    // window while waiting for the next gated official refresh.
    if (resource.resetAt <= at) continue
    const current = resources.get(resource.accountID)
    if (!current || (current.status === "stale" && resource.status === "ok")) {
      resources.set(resource.accountID, normalizeGoResource(resource, at))
    }
  }

  const baseStateFor = (modelID: string) =>
    stateByKey.get(statisticalKeyID({ providerID: "opencode-go", baseModelID: modelID }))

  const accountStateFor = (modelID: string, accountID: string) =>
    stateByKey.get(
      statisticalKeyID({ providerID: "opencode-go", baseModelID: modelID, accountID }),
    )

  const estimatesFor = (resource: GoResource) =>
    input.prior.models.map((prior) =>
      estimateGoModel({
        prior,
        resource,
        state: baseStateFor(prior.modelID),
        accountState: accountStateFor(prior.modelID, resource.accountID),
        at,
      }),
    )

  const accounts = [...resources.values()]
    .sort((a, b) => a.accountID.localeCompare(b.accountID))
    .map((resource) => ({
      accountID: resource.accountID,
      estimates: estimatesFor(resource),
    }))

  const routedResource = input.routedAccountID ? resources.get(input.routedAccountID) : undefined

  return {
    providerID: "opencode-go",
    priorStatus: input.prior.status,
    priorFetchedAt: input.prior.fetchedAt,
    ...(input.routedAccountID ? { routedAccountID: input.routedAccountID } : {}),
    routed: routedResource ? estimatesFor(routedResource) : [],
    accounts,
  }
}

export function goProviderView(snapshot: GoSnapshot): ProviderCapacity.Provider {
  // Go's published window ids are already its display labels ("5h", "week",
  // "month"), so the cross-provider view never invents a second label.
  const convertWindow = (
    estimate: GoEstimate,
    window: GoWindowCapacity,
  ): ProviderCapacity.Window => ({
    id: window.window,
    label: window.window,
    basis: window.remaining ? ("observed-remaining" as const) : ("personalized-total-capacity" as const),
    status: window.remaining?.status === "unavailable" ? ("unavailable" as const) : ("ready" as const),
    source: "published-model-capacity",
    // Personalization is a property of the workload posterior, which is shared
    // by every window of this estimate. It is never per-window.
    personalized: estimate.personalized,
    estimatedRequests: window.remaining
      ? window.remaining.remainingRequests
      : ProviderCapacity.floorRequestCount(window.pointRequests),
    remainingPercent: window.remaining ? window.remaining.remainingPercent : null,
    resetAt: window.remaining?.resetAt ?? null,
  })

  // The binding window is the observed-remaining window with the fewest
  // remaining requests. A capacity-only window is deliberately excluded: it
  // describes what a window could hold, not what is left in it.
  const bindingWindow = (estimate: GoEstimate) =>
    estimate.windowCapacity.reduce<GoWindowCapacity | undefined>((best, window) => {
      const requests = window.remaining?.remainingRequests
      if (!window.remaining || requests === null || requests === undefined) return best
      if (!best) return window
      const current = best.remaining?.remainingRequests ?? Number.POSITIVE_INFINITY
      return requests < current ? window : best
    }, undefined)

  const convert = (estimate: GoEstimate): ProviderCapacity.Estimate => ({
    providerID: "opencode-go",
    modelID: estimate.modelID,
    ...(estimate.accountID ? { accountID: estimate.accountID } : {}),
    status: estimate.projectionStatus === "ok" ? "ready" : "unavailable",
    source: "published-model-capacity",
    estimatedRequests: estimate.projectionStatus === "ok" ? estimate.estimatedRequests : null,
    remainingPercent: estimate.remainingPercent,
    resetAt: estimate.resetAt,
    personalized: estimate.personalized,
    ...(estimate.projectionStatus === "ok"
      ? {}
      : { reason: "Local post-snapshot resource consumption could not be normalized safely." }),
    ...(bindingWindow(estimate) ? { limitingWindow: bindingWindow(estimate)!.window } : {}),
    ...(estimate.windowCapacity.length
      ? {
          windows: ProviderCapacity.boundedCapacityWindows(
            estimate.windowCapacity.map((window) => convertWindow(estimate, window)),
            bindingWindow(estimate)?.window,
          ),
        }
      : {}),
    evidence: {
      observations: estimate.evidence.observations,
      requestEffectiveSamples: estimate.evidence.requestEffectiveSamples,
      sessionEffectiveSamples: estimate.evidence.sessionEffectiveSamples,
    },
  })

  return {
    quotaProviderID: "opencode-go",
    providerName: "OpenCode Go",
    modelProviderIDs: ["opencode-go"],
    status: "ok",
    defaultEstimates: snapshot.routed.map(convert),
    estimates: [],
    accounts: snapshot.accounts.map((account) => ({
      accountID: account.accountID,
      estimates: account.estimates.map(convert),
    })),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const usageYield = yield* UsageYield.Service
    const modelsDev = yield* ModelsDev.Service
    const { db, readDb } = yield* Database.Service
    yield* ResourceLearning.ensureTables(db)
    // Capacity memoizes durable usage history in process memory. Key that memo on
    // the combined in-process + cross-process watermark: a second host sharing
    // this database file commits settlements that an in-process revision alone
    // can never observe, which left this cache permanently stale. There is no TTL
    // fallback here — invalidation is driven only by the exact commit signals the
    // Database and Usage owners already expose.
    const usageWatermark = UsageHistoryWatermark.make(db)
    const usageEntries = UsageHistoryWatermark.cached(
      Effect.suspend(() => usageYield.list()),
      usageWatermark,
    )
    let generalUsageCache:
      | {
          watermark: UsageHistoryWatermark.Value
          count: number
          updatedAt: number
          value: GeneralUsage.Snapshot
        }
      | undefined

    const generalUsageFor = (
      watermark: UsageHistoryWatermark.Value,
      entries: readonly UsageYield.Entry[],
    ) => {
      let updatedAt = 0
      let count = 0
      for (const entry of entries) {
        if (entry.key.accountID) continue
        count += 1
        if (entry.updatedAt > updatedAt) updatedAt = entry.updatedAt
      }
      const cached = generalUsageCache
      if (
        cached &&
        UsageHistoryWatermark.same(cached.watermark, watermark) &&
        cached.count === count &&
        cached.updatedAt === updatedAt
      )
        return cached.value
      const value = GeneralUsage.build(entries)
      generalUsageCache = { watermark, count, updatedAt, value }
      return value
    }

    const go = Effect.fn("Capacity.go")(function* (input: GoInput) {
      const [prior, usage] = yield* Effect.all(
        [GoCapacityPrior.cache.get(), usageEntries()],
        { concurrency: 2 },
      )
      const entries = usage.value
      const earliestSnapshot = Math.min(
        ...input.accounts.map((resource) => resource.snapshotAt).filter((value) => value > 0),
      )
      const settlements =
        input.accounts.length > 0 && Number.isFinite(earliestSnapshot)
          ? yield* readDb
              .all<{
                message_id: string
                credential_id: string | null
                account_id: string | null
                model_id: string
                base_model_id: string | null
                completed_at: number
                input_tokens: number
                cache_read_tokens: number
                cache_write_tokens: number
                output_tokens: number
                reasoning_tokens: number
              }>(sql`
                SELECT
                  r.message_id,
                  f.credential_id,
                  r.account_id,
                  r.model_id,
                  r.base_model_id,
                  r.completed_at,
                  r.input_tokens,
                  r.cache_read_tokens,
                  r.cache_write_tokens,
                  r.output_tokens,
                  r.reasoning_tokens
                FROM usage_record r
                LEFT JOIN fork_message_credential f ON f.message_id = r.message_id
                WHERE r.provider_id = 'opencode-go'
                  AND r.completed_at > ${earliestSnapshot}
                ORDER BY r.completed_at ASC, r.message_id ASC
              `)
              .pipe(
                Effect.map((rows) =>
                  rows.map((row): LocalSettlement => ({
                    messageID: row.message_id,
                    ...(row.credential_id ? { credentialID: row.credential_id } : {}),
                    ...(row.account_id ? { accountID: row.account_id } : {}),
                    modelID: row.model_id,
                    ...(row.base_model_id ? { baseModelID: row.base_model_id } : {}),
                    completedAt: row.completed_at,
                    tokens: {
                      input: row.input_tokens,
                      cacheRead: row.cache_read_tokens,
                      cacheWrite: row.cache_write_tokens,
                      output: row.output_tokens,
                      reasoning: row.reasoning_tokens,
                    },
                  })),
                ),
                // A failed accounting read must not be silently interpreted as
                // zero post-snapshot consumption. Capacity exposes no recoverable
                // DB error channel, so make the route fail rather than overstate
                // requests remaining from incomplete local evidence.
                Effect.orDie,
              )
          : []

      const resources = applyLocalDepletion({
        prior,
        resources: input.accounts,
        settlements,
        at: input.at,
      })
      return buildGoSnapshot({
        prior,
        resources,
        entries,
        routedAccountID: input.routedAccountID,
        at: input.at,
      })
    })

    const general = Effect.fn("Capacity.general")(function* () {
      const usage = yield* usageEntries()
      return generalUsageFor(usage.watermark, usage.value)
    })

    const providers = Effect.fn("Capacity.providers")(function* (input: ProvidersInput) {
      const at = input.at ?? Date.now()
      const [catalog, usage] = yield* Effect.all(
        [modelsDev.get(), usageEntries()],
        { concurrency: 2 },
      )
      const entries = usage.value
      const byID = new Map(input.results.map((result) => [result.providerId, result] as const))
      const resolved = input.summaries.map((summary) => {
        const result =
          byID.get(summary.providerId) ??
          ({
            providerId: summary.providerId,
            providerName: summary.providerName,
            ok: false,
            configured: summary.configured,
            error: "Usage data unavailable",
            planLabel: null,
            usage: null,
            fetchedAt: at,
          } satisfies ProviderResult)
        return { summary, result }
      })

      // Fresh provider snapshots teach native resource burn. Cached reads share
      // fetchedAt and are therefore idempotent; the learner itself serializes
      // observation in an IMMEDIATE transaction.
      const burns = yield* ResourceLearning.observeAndList(
        db,
        resolved.map(({ summary, result }) => ({
          quotaProviderID: summary.providerId,
          modelProviderIDs: ProviderCapacity.modelProviderIDs(summary, catalog),
          result,
        })),
      )

      return {
        providers: resolved.map(({ summary, result }) =>
          ProviderCapacity.buildProvider({
            summary,
            result,
            catalog,
            entries,
            burns,
            at,
          }),
        ),
        generalUsage: generalUsageFor(usage.watermark, entries),
      }
    })

    return Service.of({ go, general, providers })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, UsageYield.node, ModelsDev.node],
})

export * as Capacity from "./capacity"
