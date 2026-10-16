export * as OxpAttributionCalibration from "./calibration"

import { createHash } from "node:crypto"
import payload from "./payload-calibration-v1.json" with { type: "json" }
import upstreamProfile from "./calibration-v2.json" with { type: "json" }

type Donor = {
  readonly reqArgsMean: number
  readonly reqArgsCount: number
  readonly canonicalResultMean: number
  readonly canonicalResultCount: number
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
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
}

function assertPayload() {
  if (payload.version !== 1) throw new Error(`Unsupported OXP payload calibration v${payload.version}`)
  if (!(payload.tokenizer.canonicalRequestCharsPerToken > 0) || !(payload.tokenizer.canonicalResultCharsPerToken > 0))
    throw new Error("OXP payload calibration has invalid tokenizer ratios")
  if (!Number.isFinite(payload.corpus.maxStartedAt)) throw new Error("OXP payload calibration has invalid corpus window")
}

function assertUpstream() {
  if (upstreamProfile.version !== 2) throw new Error(`Unsupported OXP usage calibration v${upstreamProfile.version}`)
  if (
    !(upstreamProfile.tokenizer.requestCharsPerToken > 0) ||
    !(upstreamProfile.tokenizer.resultCharsPerToken > 0)
  )
    throw new Error("OXP usage calibration has invalid tokenizer ratios")
  if (!(upstreamProfile.upstream.turnGapThresholdMs >= 0))
    throw new Error("OXP usage calibration has invalid turn threshold")
  const width = upstreamProfile.upstream.features.length
  if (
    upstreamProfile.upstream.coefficients.length !== width ||
    upstreamProfile.upstream.means.length !== width ||
    upstreamProfile.upstream.stds.length !== width
  ) {
    throw new Error("OXP usage calibration feature dimensions do not match")
  }
  if (upstreamProfile.upstream.stds.some((value) => !(value > 0)))
    throw new Error("OXP usage calibration has invalid scaling")
}

assertPayload()
assertUpstream()

const donors = payload.donors.groups as unknown as Record<string, Donor>

// The payload artifact's `canonicalSchema` names the historical detail shape the
// tokenizer ratios were measured against; live boundary scalars reuse the same
// ratios because both are Unicode-code-point text at the boundary. `payload` only
// supplies donor statistics and the legacy corpus window now -- it no longer
// carries `rho`/geometric residency semantics.
export const canonicalSchema = payload.canonicalSchema
export const requestCharsPerToken = upstreamProfile.tokenizer.requestCharsPerToken
export const resultCharsPerToken = upstreamProfile.tokenizer.resultCharsPerToken
export const turnGapThresholdMs = upstreamProfile.upstream.turnGapThresholdMs
export const upstream = upstreamProfile.upstream

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

export const id = digest(upstreamProfile)
export const artifact = upstreamProfile

export const status = {
  productionDigest: id,
  payloadDigest: digest(payload),
  sourceDigest: payload.sourceArtifact.digest,
  calibratedAt: upstreamProfile.calibratedAt,
  observations: upstreamProfile.source.pairedMessages,
  corpus: {
    pairedMessages: upstreamProfile.source.pairedMessages,
    sessions: upstreamProfile.source.sessions,
    usageRows: upstreamProfile.source.usageRows,
    toolRows: upstreamProfile.source.toolRows,
    maxStartedAt: payload.corpus.maxStartedAt,
  },
  tokenizer: {
    encoding: upstreamProfile.tokenizer.encoding,
    sampledInvocations: upstreamProfile.tokenizer.sampledInvocations,
  },
  validation: upstreamProfile.upstream.validation,
} as const
