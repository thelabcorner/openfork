export * as OxpAttributionCalibration from "./calibration"

import { createHash } from "node:crypto"
import profile from "./calibration-v1.json" with { type: "json" }

type Donor = {
  readonly reqArgsMean: number
  readonly reqArgsCount: number
  readonly canonicalResultMean: number
  readonly canonicalResultCount: number
}

type ToolValidation = {
  readonly tool: string
  readonly observations: number
  readonly exposureAggregateBiasRMSE: number | null
  readonly exposureMaxAbsFoldBias: number | null
  readonly exposureWAPE: number | null
  readonly foldsWithExposureEvidence: number
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]),
  )
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
}

function assertProfile() {
  if (profile.version !== 1) throw new Error(`Unsupported OXP attribution calibration v${profile.version}`)
  if (
    profile.units.rawLength !== "sqlite-text-unicode-codepoints" ||
    profile.units.canonicalLength !== "sqlite-text-unicode-codepoints"
  ) {
    throw new Error("OXP attribution calibration uses incompatible length units")
  }
  if (!(profile.rho >= 0 && profile.rho <= 1)) throw new Error("OXP attribution calibration rho is outside [0,1]")
  if (!(profile.gapThresholdMs >= 0)) throw new Error("OXP attribution calibration gap threshold is invalid")
  const { integrity, ...body } = profile
  const actual = digest(body)
  if (integrity.algorithm !== "sha256" || actual !== integrity.digest)
    throw new Error("OXP attribution calibration integrity check failed")
}

assertProfile()

const donors = profile.donors.groups as Record<string, Donor>
const globalDonor = profile.donors.global as Donor
const temporal = profile.validation.temporal.byTool as Record<
  string,
  { readonly observations: number; readonly exposureRelativeError: number | null }
>
const validation = new Map((profile.validation.byTool as readonly ToolValidation[]).map((row) => [row.tool, row]))

export const artifact = profile
export const id = profile.integrity.digest
export const rho = profile.rho
export const gapThresholdMs = profile.gapThresholdMs

export const requestCharsPerToken = profile.tokenizer.canonicalRequestCharsPerToken
export const resultCharsPerToken = profile.tokenizer.canonicalResultCharsPerToken

export const donor = (tool: string, status: string) => donors[`${tool}\0${status}`]

export const requestDonorChars = (tool: string, status: string) => {
  const local = donor(tool, status)
  if (local && local.reqArgsCount > 0) return local.reqArgsMean
  return undefined
}

export const resultDonorChars = (tool: string, status: string) => {
  const local = donor(tool, status)
  if (local && local.canonicalResultCount > 0) return local.canonicalResultMean
  return undefined
}

export const globalDonorReference = globalDonor

/**
 * The research surrogate is eligible only when both activity-disjoint folds
 * and the strict future holdout support it. Core does not need this for exact
 * persisted scalars, but exposes the gate for cold historical fallback/audit.
 */
export const surrogateEligible = (tool: string) => {
  const row = validation.get(tool)
  const future = temporal[tool]
  if (!row || !future) return false
  if (row.foldsWithExposureEvidence < 3 || future.observations < 20) return false
  const rmse = row.exposureAggregateBiasRMSE
  const futureError = future.exposureRelativeError
  if (rmse === null || futureError === null) return false
  return Math.max(Math.abs(rmse), Math.abs(futureError)) <= 0.05
}

export const status = {
  productionDigest: profile.integrity.digest,
  sourceDigest: profile.sourceArtifact.digest,
  calibratedAt: profile.calibratedAt,
  observations: profile.observations,
  corpus: profile.corpus,
  validation: profile.validation.best,
} as const
