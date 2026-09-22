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
import { FALLBACK_WORKLOAD_CORPUS } from "@opencode-ai/schema/model-select/usage-yield"
import type { ProviderResult, ProviderSummary, UsageWindow, WorkBuddyModelLimit } from "@/quota/schema"
import type { BurnEstimate } from "./resource-learning"

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

function costForTokens(model: ModelsDev.Model, tokens: readonly number[]) {
  const input = Math.max(0, tokens[0] ?? 0)
  const cacheRead = Math.max(0, tokens[1] ?? 0)
  const cacheWrite = Math.max(0, tokens[2] ?? 0)
  const output = Math.max(0, tokens[3] ?? 0)
  const reasoning = Math.max(0, tokens[4] ?? 0)
  const context = input + cacheRead + cacheWrite
  const base = model.cost
  if (!base) return undefined
  const tier =
    base.tiers
      ?.filter((candidate) => candidate.tier.type === "context" && context > candidate.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (base.context_over_200k && context > 200_000 ? base.context_over_200k : base)
  const value =
    (input * tier.input +
      output * tier.output +
      cacheRead * (tier.cache_read ?? 0) +
      cacheWrite * (tier.cache_write ?? 0) +
      reasoning * tier.output) /
    1_000_000
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function personalCurrentPrice(model: ModelsDev.Model, state: YieldStatisticState | undefined) {
  if (!state) return undefined
  const snapshot = snapshotYieldStatistic(state)
  if (snapshot.recent.length === 0) return undefined
  const rho = 0.5 ** (1 / MONEY_HALF_LIFE)
  let weight = 0
  let sum = 0
  for (let index = 0; index < snapshot.recent.length; index++) {
    const observation = snapshot.recent[index]!
    const price = costForTokens(model, observation.tokens)
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
 * model's CURRENT pricing (including context tiers). It is not a universal
 * dollar budget and it never reuses historical dollar cost.
 */
function standardizedPriorPrice(model: ModelsDev.Model) {
  return median(
    FALLBACK_WORKLOAD_CORPUS.flatMap((workload) => {
      const price = costForTokens(model, [
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

function requestPrice(model: ModelsDev.Model, state: YieldStatisticState | undefined) {
  const prior = standardizedPriorPrice(model)
  const personal = personalCurrentPrice(model, state)
  const evidence = stateEvidence(state)
  const independentSamples = Math.min(
    evidence.requestEffectiveSamples,
    evidence.sessionEffectiveSamples,
  )

  if (prior !== undefined && prior > 0 && personal !== undefined && personal > 0 && independentSamples > 0) {
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
  if (personal !== undefined && personal > 0) {
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

export function modelProviderIDs(summary: ProviderSummary, catalog: Record<string, ModelsDev.Provider>) {
  if (summary.providerId === "opencode-go") return ["opencode-go"]
  if (summary.providerId === "opencode-zen") return ["opencode"]
  const candidates = [...new Set([summary.providerId, ...summary.aliases])]
  const existing = candidates.filter((id) => catalog[id] !== undefined)
  return existing.length > 0 ? existing : [summary.providerId]
}

function requestBudget(windows: Record<string, UsageWindow>, at: number) {
  return Object.entries(windows)
    .flatMap(([key, window]) => {
      const resource = window.resource
      if (resource?.kind !== "requests" || resource.remaining === null) return []
      if (window.resetAt !== null && window.resetAt <= at) return []
      return [{
        key,
        remaining: Math.max(0, resource.remaining),
        remainingPercent: window.remainingPercent,
        resetAt: window.resetAt,
      }]
    })
    .sort((a, b) => a.remaining - b.remaining)[0]
}

export function directRequestDefaults(input: {
  providerIDs: readonly string[]
  result: ProviderResult
  at: number
}): Estimate[] {
  const usage = input.result.usage
  if (!usage) return []
  const budget = requestBudget(usage.windows, input.at)
  if (!budget) return []
  return input.providerIDs.map((providerID) => ({
    providerID,
    status: "ready",
    source: "direct-request-budget",
    estimatedRequests: floorRequestCount(budget.remaining),
    remainingPercent: budget.remainingPercent,
    resetAt: budget.resetAt,
    personalized: false,
    limitingWindow: budget.key,
    evidence: EMPTY_EVIDENCE,
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
          .filter((value): value is number => value !== null && value > Date.now())
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
  catalog: Record<string, ModelsDev.Provider>
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
    )
  }

  const [limitingKey, limitingWindow] = moneyWindows
    .slice()
    .sort((a, b) => a[1].resource!.remaining! - b[1].resource!.remaining!)[0]!

  const remaining = Math.max(0, limitingWindow.resource!.remaining!)
  const stateMap = new Map(
    input.entries.map((entry) => [statisticalKeyID(entry.key), entry.state] as const),
  )
  const estimates: Estimate[] = []

  for (const providerID of input.providerIDs) {
    const provider = input.catalog[providerID]
    if (!provider) continue

    for (const model of Object.values(provider.models)) {
      const state = stateMap.get(statisticalKeyID({ providerID, baseModelID: model.id }))
      const priced = requestPrice(model, state)
      const { price, evidence } = priced

      if (!(price !== undefined && price > 0)) {
        estimates.push({
          providerID,
          modelID: model.id,
          status: "learning",
          source: "insufficient-evidence",
          estimatedRequests: null,
          remainingPercent: limitingWindow.remainingPercent,
          resetAt: limitingWindow.resetAt,
          personalized: false,
          limitingWindow: limitingKey,
          reason: model.cost
            ? "A settled request is needed to learn this model's personal request size under current pricing."
            : "Current per-token pricing is unavailable for this model.",
          evidence,
        })
        continue
      }

      estimates.push({
        providerID,
        modelID: model.id,
        status: "ready",
        source: priced.source,
        estimatedRequests: floorRequestCount(remaining / price),
        remainingPercent: limitingWindow.remainingPercent,
        resetAt: limitingWindow.resetAt,
        personalized: priced.personalized,
        limitingWindow: limitingKey,
        evidence,
      })
    }
  }

  if (estimates.length === 0) {
    return learningProvider(
      input.summary,
      input.providerIDs,
      input.result,
      "The provider balance is available, but no current priced model catalog is available for request conversion.",
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

function verdentProvider(input: {
  summary: ProviderSummary
  result: ProviderResult
  providerIDs: readonly string[]
  at: number
}): Provider {
  const usage = input.result.usage
  if (!usage) return emptyProvider(input.summary, input.providerIDs, input.result)

  const providerID = input.providerIDs[0] ?? "verdent"
  const defaults = directRequestDefaults({
    providerIDs: input.providerIDs,
    result: input.result,
    at: input.at,
  })

  const estimates: Estimate[] = []
  const accounts: Account[] = []

  for (const account of usage.verdentAccounts ?? []) {
    const accountEstimates: Estimate[] = []
    for (const report of account.models) {
      const modelID = report.canonical ?? report.model
      const estimate = reportEstimate({
        providerID,
        modelID,
        accountID: account.accountId,
        accountLabel: account.label,
        report,
      })
      if (estimate) accountEstimates.push(estimate)
    }
    if (accountEstimates.length > 0) {
      accounts.push({
        accountID: account.accountId,
        accountLabel: account.label,
        estimates: accountEstimates,
      })
    }
  }

  const modelIDs = new Set(
    accounts.flatMap((account) =>
      account.estimates.flatMap((estimate) => (estimate.modelID ? [estimate.modelID] : [])),
    ),
  )

  for (const modelID of modelIDs) {
    const choices = accounts.flatMap((account) =>
      account.estimates.filter((estimate) => estimate.modelID === modelID),
    )
    const best = choices
      .slice()
      .sort((a, b) => (b.estimatedRequests ?? -1) - (a.estimatedRequests ?? -1))[0]
    if (best) estimates.push({ ...best, accountID: undefined, accountLabel: undefined })
  }

  return {
    quotaProviderID: input.summary.providerId,
    providerName: input.result.providerName,
    modelProviderIDs: [...input.providerIDs],
    status: "ok",
    defaultEstimates: defaults,
    estimates,
    accounts,
  }
}


function creditMoneyProvider(input: {
  summary: ProviderSummary
  result: ProviderResult
  providerIDs: readonly string[]
  catalog: Record<string, ModelsDev.Provider>
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
    .sort(
      (a, b) =>
        a[1].resource!.remaining! * a[1].resource!.usdPerUnit! -
        b[1].resource!.remaining! * b[1].resource!.usdPerUnit!,
    )

  const selected = convertible[0]
  if (!selected) return undefined

  const [limitingKey, limitingWindow] = selected
  const resource = limitingWindow.resource!
  const remainingUSD = Math.max(0, resource.remaining! * resource.usdPerUnit!)
  const stateMap = new Map(
    input.entries.map((entry) => [statisticalKeyID(entry.key), entry.state] as const),
  )
  const estimates: Estimate[] = []

  for (const providerID of input.providerIDs) {
    const provider = input.catalog[providerID]
    if (!provider) continue

    for (const model of Object.values(provider.models)) {
      const state = stateMap.get(statisticalKeyID({ providerID, baseModelID: model.id }))
      const priced = requestPrice(model, state)
      const { price, evidence } = priced

      if (!(price !== undefined && price > 0)) {
        estimates.push({
          providerID,
          modelID: model.id,
          status: "learning",
          source: "insufficient-evidence",
          estimatedRequests: null,
          remainingPercent: limitingWindow.remainingPercent,
          resetAt: limitingWindow.resetAt,
          personalized: false,
          limitingWindow: limitingKey,
          reason: model.cost
            ? "A settled request is needed to learn this model's personal request size under current pricing."
            : "Current per-token pricing is unavailable for this model.",
          evidence,
        })
        continue
      }

      estimates.push({
        providerID,
        modelID: model.id,
        status: "ready",
        source: priced.source,
        estimatedRequests: floorRequestCount(remainingUSD / price),
        remainingPercent: limitingWindow.remainingPercent,
        resetAt: limitingWindow.resetAt,
        personalized: priced.personalized,
        limitingWindow: limitingKey,
        evidence,
      })
    }
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
  catalog: Record<string, ModelsDev.Provider>
  burns: readonly BurnEstimate[]
  at: number
}): Provider | undefined {
  const usage = input.result.usage
  if (!usage || input.burns.length === 0) return undefined

  const estimates: Estimate[] = []
  for (const providerID of input.providerIDs) {
    const provider = input.catalog[providerID]
    if (!provider) continue

    for (const model of Object.values(provider.models)) {
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

      const binding = candidates
        .filter((candidate) => Number.isFinite(candidate.count) && candidate.count >= 0)
        .sort((a, b) => a.count - b.count)[0]
      if (!binding) continue

      estimates.push({
        providerID,
        modelID: model.id,
        status: "ready",
        source: "provider-observed-burn",
        estimatedRequests: floorRequestCount(binding.count),
        remainingPercent: binding.window.remainingPercent,
        resetAt: binding.window.resetAt,
        personalized: true,
        limitingWindow: binding.windowKey,
        evidence: {
          observations: binding.burn.observations,
          requestEffectiveSamples: binding.burn.effectiveSamples,
          sessionEffectiveSamples: binding.burn.effectiveSamples,
        },
      })
    }
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

  if (input.summary.providerId === "verdent") {
    return verdentProvider({
      summary: input.summary,
      result: input.result,
      providerIDs,
      at,
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

  const learned = learnedBurnProvider({
    summary: input.summary,
    result: input.result,
    providerIDs,
    catalog: input.catalog,
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
      catalog: input.catalog,
      entries: input.entries,
      at,
    })
  }

  const creditMoney = creditMoneyProvider({
    summary: input.summary,
    result: input.result,
    providerIDs,
    catalog: input.catalog,
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
    )
  }

  return learningProvider(
    input.summary,
    providerIDs,
    input.result,
    "The provider exposes quota telemetry but not enough machine-readable resource semantics for a request projection yet.",
  )
}
