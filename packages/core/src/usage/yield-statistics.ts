import { UsageClassification } from "./classification"

export const YieldHalfLives = [8, 16, 32, 128, 512] as const
export type YieldHalfLife = (typeof YieldHalfLives)[number]

export const TokenDimensions = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const
export type TokenDimension = (typeof TokenDimensions)[number]

export type TokenVector = readonly [number, number, number, number, number]
export type LinearCoefficients = TokenVector
export const RECENT_VECTOR_LIMIT = 128

const DIMENSIONS = TokenDimensions.length
const CROSS_DIMENSIONS = (DIMENSIONS * (DIMENSIONS + 1)) / 2

export interface DecayedMoments {
  readonly halfLife: YieldHalfLife
  /** Sum of current observation weights. */
  readonly weight: number
  /** Sum of squared current observation weights, for Kish effective sample size. */
  readonly squaredWeight: number
  /** Weighted first moment for each token component. */
  readonly sum: readonly number[]
  /** Packed upper-triangle weighted second moment E[x_i x_j]. */
  readonly cross: readonly number[]
}

export interface SessionBlockState {
  readonly activeSessionID?: string
  readonly activeCount: number
  readonly activeSum: readonly number[]
  /** Completed contiguous session/model blocks. */
  readonly completedBlocks: number
  /** Request counts for completed blocks, used to estimate clustering exposure. */
  readonly completedRequests: number
  /** Moments over completed block means; current open block is intentionally excluded. */
  readonly moments: readonly DecayedMoments[]
}

export interface RecentVectorObservation {
  readonly sessionID: string
  readonly completedAt: number
  readonly tokens: TokenVector
}

export interface YieldStatisticState {
  readonly version: 3
  readonly observations: number
  readonly lastCompletedAt?: number
  readonly moments: readonly DecayedMoments[]
  readonly sessions: SessionBlockState
  /**
   * Bounded exact recent workload vectors for nonlinear pricing projections.
   * At the calibrated 16-observation half-life, mass older than 128 observations is <0.4%.
   */
  readonly recent: readonly RecentVectorObservation[]
}

export interface YieldObservation {
  readonly sessionID: string
  readonly completedAt: number
  readonly tokens: {
    readonly input: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly output: number
    readonly reasoning: number
  }
}

export function isUserFacingYieldObservation(input: {
  readonly agent?: string | null
  readonly mode?: string | null
}) {
  return UsageClassification.isUserFacing(input)
}

export interface LinearProjection {
  readonly mean: number
  readonly variance: number
  readonly standardDeviation: number
  readonly effectiveSamples: number
  readonly exposure: number
}

export interface YieldStatisticalKey {
  readonly providerID: string
  readonly baseModelID: string
  readonly accountID?: string
}

export function statisticalKeyID(key: YieldStatisticalKey) {
  return JSON.stringify([key.providerID, key.baseModelID, key.accountID ?? null])
}

const zeros = (length: number) => Array.from({ length }, () => 0)

function emptyMoments(halfLife: YieldHalfLife): DecayedMoments {
  return {
    halfLife,
    weight: 0,
    squaredWeight: 0,
    sum: zeros(DIMENSIONS),
    cross: zeros(CROSS_DIMENSIONS),
  }
}

export function emptyYieldStatistic(): YieldStatisticState {
  return {
    version: 3,
    observations: 0,
    moments: YieldHalfLives.map(emptyMoments),
    sessions: {
      activeCount: 0,
      activeSum: zeros(DIMENSIONS),
      completedBlocks: 0,
      completedRequests: 0,
      moments: YieldHalfLives.map(emptyMoments),
    },
    recent: [],
  }
}

export function tokenVector(tokens: YieldObservation["tokens"]): TokenVector {
  return [
    validTokenCount(tokens.input),
    validTokenCount(tokens.cacheRead),
    validTokenCount(tokens.cacheWrite),
    validTokenCount(tokens.output),
    validTokenCount(tokens.reasoning),
  ]
}

function validTokenCount(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function crossIndex(i: number, j: number) {
  if (i > j) [i, j] = [j, i]
  return i * DIMENSIONS - (i * (i - 1)) / 2 + (j - i)
}

function observeMoments(state: DecayedMoments, value: readonly number[]): DecayedMoments {
  const rho = 0.5 ** (1 / state.halfLife)
  const sum = state.sum.map((current, index) => rho * current + (value[index] ?? 0))
  const cross = state.cross.map((current) => rho * current)

  for (let i = 0; i < DIMENSIONS; i++) {
    const left = value[i] ?? 0
    for (let j = i; j < DIMENSIONS; j++) {
      cross[crossIndex(i, j)]! += left * (value[j] ?? 0)
    }
  }

  return {
    halfLife: state.halfLife,
    weight: rho * state.weight + 1,
    squaredWeight: rho * rho * state.squaredWeight + 1,
    sum,
    cross,
  }
}

function finalizeSessionBlock(state: SessionBlockState): SessionBlockState {
  if (state.activeCount <= 0) return state
  const mean = state.activeSum.map((value) => value / state.activeCount)
  return {
    activeCount: 0,
    activeSum: zeros(DIMENSIONS),
    completedBlocks: state.completedBlocks + 1,
    completedRequests: state.completedRequests + state.activeCount,
    moments: state.moments.map((moments) => observeMoments(moments, mean)),
  }
}

function observeSession(state: SessionBlockState, sessionID: string, value: TokenVector): SessionBlockState {
  if (state.activeSessionID === sessionID) {
    return {
      ...state,
      activeCount: state.activeCount + 1,
      activeSum: state.activeSum.map((current, index) => current + value[index]!),
    }
  }

  const finalized = finalizeSessionBlock(state)
  return {
    ...finalized,
    activeSessionID: sessionID,
    activeCount: 1,
    activeSum: [...value],
  }
}

export function observeYieldStatistic(
  state: YieldStatisticState | undefined,
  observation: YieldObservation,
): YieldStatisticState {
  const current = state ?? emptyYieldStatistic()
  const value = tokenVector(observation.tokens)
  const recent = [
    ...current.recent,
    {
      sessionID: observation.sessionID,
      completedAt: observation.completedAt,
      tokens: value,
    },
  ]
  if (recent.length > RECENT_VECTOR_LIMIT) recent.splice(0, recent.length - RECENT_VECTOR_LIMIT)

  return {
    version: 3,
    observations: current.observations + 1,
    lastCompletedAt: Math.max(current.lastCompletedAt ?? observation.completedAt, observation.completedAt),
    moments: current.moments.map((moments) => observeMoments(moments, value)),
    sessions: observeSession(current.sessions, observation.sessionID, value),
    recent,
  }
}

/**
 * Finalize the currently-open session block for snapshots/rebuilds. Normal
 * settlement updates intentionally keep it open so requests from the same
 * session are aggregated into one cluster-level observation.
 */
export function snapshotYieldStatistic(state: YieldStatisticState): YieldStatisticState {
  return {
    ...state,
    sessions: finalizeSessionBlock(state.sessions),
  }
}

export function effectiveSamples(moments: DecayedMoments) {
  if (!(moments.weight > 0) || !(moments.squaredWeight > 0)) return 0
  return (moments.weight * moments.weight) / moments.squaredWeight
}

export function meanVector(moments: DecayedMoments): TokenVector | undefined {
  if (!(moments.weight > 0)) return undefined
  return moments.sum.map((value) => value / moments.weight) as unknown as TokenVector
}

export function covariance(moments: DecayedMoments, i: number, j: number) {
  if (i < 0 || i >= DIMENSIONS || j < 0 || j >= DIMENSIONS) return 0
  if (!(moments.weight > 0)) return 0

  const denominator = moments.weight - moments.squaredWeight / moments.weight
  if (!(denominator > 0)) return 0

  const sumI = moments.sum[i] ?? 0
  const sumJ = moments.sum[j] ?? 0
  const cross = moments.cross[crossIndex(i, j)] ?? 0
  const centered = cross - (sumI * sumJ) / moments.weight
  return Math.max(i === j ? 0 : Number.NEGATIVE_INFINITY, centered / denominator)
}

/**
 * Project a weighted token distribution through a current linear resource rule.
 * For pricing, coefficients are current USD-per-token values. This deliberately
 * does not persist historical prices: repricing is exact for the materialized
 * first/second token moments.
 */
export function projectLinear(
  moments: DecayedMoments,
  coefficients: LinearCoefficients,
): LinearProjection | undefined {
  const mean = meanVector(moments)
  if (!mean) return undefined

  let projectedMean = 0
  for (let i = 0; i < DIMENSIONS; i++) projectedMean += coefficients[i] * mean[i]

  let variance = 0
  for (let i = 0; i < DIMENSIONS; i++) {
    for (let j = 0; j < DIMENSIONS; j++) {
      variance += coefficients[i] * coefficients[j] * covariance(moments, i, j)
    }
  }
  variance = Math.max(0, variance)

  return {
    mean: projectedMean,
    variance,
    standardDeviation: Math.sqrt(variance),
    effectiveSamples: effectiveSamples(moments),
    exposure: moments.weight,
  }
}

export function momentsFor(state: YieldStatisticState, halfLife: YieldHalfLife) {
  return state.moments.find((item) => item.halfLife === halfLife)
}

export function sessionMomentsFor(state: YieldStatisticState, halfLife: YieldHalfLife) {
  return state.sessions.moments.find((item) => item.halfLife === halfLife)
}

/**
 * A settled generation always updates the account-neutral base-model state. If
 * an authoritative physical account is known it also updates one sparse account
 * overlay. Accountless observations must never be invented into an account key.
 */
export function statisticalKeys(input: YieldStatisticalKey): readonly YieldStatisticalKey[] {
  const base = { providerID: input.providerID, baseModelID: input.baseModelID }
  return input.accountID ? [base, { ...base, accountID: input.accountID }] : [base]
}
