import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { UsageYield } from "@opencode-ai/core/usage/yield"
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
  readonly providers: (input: ProvidersInput) => Effect.Effect<ProviderCapacity.Provider[]>
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

function predictiveBudgetFor(remainingTypicalRequests: number): PredictiveBudget {
  if (!(remainingTypicalRequests > 0)) return 5
  if (remainingTypicalRequests <= Math.sqrt(5 * 20)) return 5
  if (remainingTypicalRequests <= Math.sqrt(20 * 100)) return 20
  return 100
}

function predictiveRange(input: {
  readonly pointRequests: number
  readonly remainingTypicalRequests: number
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

  const calibrationBudget = predictiveBudgetFor(input.remainingTypicalRequests)
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
    remainingTypicalRequests,
    effectiveSamples: predictiveEffectiveSamples,
    projectionStatus,
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
  const consumed = new Map<string, { fraction: number; requests: number; unnormalized: number }>()
  const seenMessageIDs = new Set<string>()

  const currentFor = (resource: GoResource) => {
    const current = consumed.get(resource.accountID) ?? { fraction: 0, requests: 0, unnormalized: 0 }
    consumed.set(resource.accountID, current)
    return current
  }
  const belongsToSnapshotWindow = (resource: GoResource, completedAt: number) =>
    completedAt > resource.snapshotAt && completedAt < resource.resetAt && resource.resetAt > at

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
        if (belongsToSnapshotWindow(candidate, settlement.completedAt)) currentFor(candidate).unnormalized += 1
      }
      continue
    }

    // An explicit account that is not represented by this quota snapshot belongs
    // to some other account. Never fall back from an authoritative account_id to
    // a credential UUID and accidentally debit a different resource.
    if (!resource || !belongsToSnapshotWindow(resource, settlement.completedAt)) continue

    const modelID = settlement.baseModelID ?? splitAccountModelID(settlement.modelID).baseModelID
    const prior = priorByModel.get(modelID)
    if (!prior) {
      currentFor(resource).unnormalized += 1
      continue
    }

    const requests = GoCapacityPrior.requestsAt(prior, "5h", settlement.completedAt)
    const typicalCost = GoCapacityPrior.priceTypical(prior)
    const actualCost = GoCapacityPrior.priceTokens(prior, settlement.tokens)
    if (
      !(requests > 0) ||
      !(typicalCost !== undefined && typicalCost > 0) ||
      !(actualCost !== undefined && actualCost > 0)
    ) {
      currentFor(resource).unnormalized += 1
      continue
    }

    const multiplier = actualCost / typicalCost
    if (!(Number.isFinite(multiplier) && multiplier > 0)) {
      currentFor(resource).unnormalized += 1
      continue
    }

    const current = currentFor(resource)
    current.fraction += multiplier / requests
    current.requests += 1
  }

  return input.resources.map((resource) => {
    const local = consumed.get(resource.accountID)
    const fraction = Math.max(0, local?.fraction ?? 0)
    return {
      ...resource,
      remainingFraction: clampFraction(resource.remainingFraction - fraction),
      localRequestsApplied: local?.requests ?? 0,
      localFractionConsumed: fraction,
      localUnnormalizedRequests: local?.unnormalized ?? 0,
    }
  })
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
      resources.set(resource.accountID, {
        ...resource,
        remainingFraction: clampFraction(resource.remainingFraction),
      })
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

    const go = Effect.fn("Capacity.go")(function* (input: GoInput) {
      const [prior, entries] = yield* Effect.all(
        [GoCapacityPrior.cache.get(), usageYield.list()],
        { concurrency: 2 },
      )
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

    const providers = Effect.fn("Capacity.providers")(function* (input: ProvidersInput) {
      const at = input.at ?? Date.now()
      const [catalog, entries] = yield* Effect.all(
        [modelsDev.get(), usageYield.list()],
        { concurrency: 2 },
      )
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

      return resolved.map(({ summary, result }) =>
        ProviderCapacity.buildProvider({
          summary,
          result,
          catalog,
          entries,
          burns,
          at,
        }),
      )
    })

    return Service.of({ go, providers })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, UsageYield.node, ModelsDev.node],
})

export * as Capacity from "./capacity"
