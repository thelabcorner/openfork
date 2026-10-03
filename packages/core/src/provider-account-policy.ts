export * as ProviderAccountPolicy from "./provider-account-policy"

import { Schema } from "effect"
import type { ProviderRoute } from "./provider-route"

const MAX_HEALTH_RANK = 1_000_000

export const IneligibilityReason = Schema.Literals([
  "account-forbidden",
  "provider-forbidden",
  "auth-invalid",
  "disabled",
  "model-unsupported",
  "quota-exhausted",
  "cooldown",
  "unknown-entitlement",
  "other",
])
export type IneligibilityReason = typeof IneligibilityReason.Type

/**
 * Secret-free provider/account policy input.
 *
 * Provider adapters/governors own entitlement semantics. Generic policy only
 * consumes the already-decided admissible bit plus a bounded health rank.
 */
export interface Candidate {
  readonly providerID: string
  readonly accountID: string
  readonly credentialHandle: string
  readonly admissible: boolean
  /** Lower is healthier. Provider adapters define the meaning. */
  readonly healthRank: number
  readonly ineligibleReason?: IneligibilityReason
  readonly usedPercent?: number
  readonly resetAt?: number
  readonly maxSessionBindings?: number
}

export interface CandidateStats {
  readonly activeBindings: number
  readonly assignmentCount: number
  readonly lastAssignedAt?: number
}

export interface Cursor {
  /** Durable affinity-domain assignment epoch. */
  readonly epoch: number
  /** Last account selected by session-round-robin, if any. */
  readonly lastAssignedHandle?: string
}

export interface SelectInput {
  readonly providerID: string
  readonly affinityDomain: string
  readonly mode: ProviderRoute.RoutingMode
  readonly candidates: readonly Candidate[]
  readonly stats?: ReadonlyMap<string, CandidateStats>
  readonly cursor?: Cursor
  readonly excludedCredentialHandles?: ReadonlySet<string>
  /**
   * For failover, advance round-robin from the failed handle even when it is no
   * longer eligible. Otherwise the durable cursor owns the start position.
   */
  readonly afterCredentialHandle?: string
}

export interface SelectedAccount {
  readonly providerID: string
  readonly accountID: string
  readonly credentialHandle: string
}

export type RejectionReason =
  | "provider-mismatch"
  | "excluded"
  | "provider-ineligible"
  | "capacity"

export interface Rejection {
  readonly providerID: string
  readonly accountID: string
  readonly credentialHandle: string
  readonly reason: RejectionReason
  /** Preserved provider/governor cause; generic policy never reinterprets it. */
  readonly ineligibleReason?: IneligibilityReason
}

export interface Selection {
  readonly selected?: SelectedAccount
  readonly rejected: readonly Rejection[]
  /**
   * Proposed state only. Caller must commit this with the binding/cursor CAS
   * before dispatch; this pure module mutates nothing.
   */
  readonly assignmentEpoch?: number
  readonly nextCursor?: Cursor
}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "ProviderAccountPolicy.InvalidInput",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export type Result =
  | { readonly ok: true; readonly selection: Selection }
  | { readonly ok: false; readonly error: InvalidInputError }

function canonical(value: string) {
  const result = value.trim()
  return result.length > 0 ? result : undefined
}

function invalid(field: string, message: string): Result {
  return { ok: false, error: new InvalidInputError({ field, message }) }
}

function safeInteger(value: number, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0
}

function finitePercent(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, value))
}

function candidateIdentity(candidate: Candidate): SelectedAccount {
  return {
    providerID: candidate.providerID,
    accountID: candidate.accountID,
    credentialHandle: candidate.credentialHandle,
  }
}

function rejection(
  candidate: Candidate,
  reason: RejectionReason,
  ineligibleReason?: IneligibilityReason,
): Rejection {
  return {
    ...candidateIdentity(candidate),
    reason,
    ...(ineligibleReason ? { ineligibleReason } : {}),
  }
}

function compareIdentity(left: Candidate, right: Candidate) {
  return (
    left.providerID.localeCompare(right.providerID) ||
    left.credentialHandle.localeCompare(right.credentialHandle) ||
    left.accountID.localeCompare(right.accountID)
  )
}

interface PreparedCandidate {
  readonly candidate: Candidate
  readonly stats: CandidateStats
  readonly usedPercent?: number
}

function concentrateCompare(left: PreparedCandidate, right: PreparedCandidate) {
  const leftUsed = left.stats.assignmentCount > 0
  const rightUsed = right.stats.assignmentCount > 0
  if (leftUsed !== rightUsed) return leftUsed ? -1 : 1

  const health = left.candidate.healthRank - right.candidate.healthRank
  if (health !== 0) return health

  if (left.usedPercent !== undefined || right.usedPercent !== undefined) {
    if (left.usedPercent === undefined) return 1
    if (right.usedPercent === undefined) return -1
    if (left.usedPercent !== right.usedPercent) return right.usedPercent - left.usedPercent
  }

  const assignments = right.stats.assignmentCount - left.stats.assignmentCount
  if (assignments !== 0) return assignments

  const leftReset = left.candidate.resetAt ?? Infinity
  const rightReset = right.candidate.resetAt ?? Infinity
  if (leftReset !== rightReset) return leftReset - rightReset

  const active = right.stats.activeBindings - left.stats.activeBindings
  if (active !== 0) return active

  const leftLast = left.stats.lastAssignedAt ?? 0
  const rightLast = right.stats.lastAssignedAt ?? 0
  if (leftLast !== rightLast) return rightLast - leftLast

  return (
    left.candidate.credentialHandle.localeCompare(right.candidate.credentialHandle) ||
    left.candidate.accountID.localeCompare(right.candidate.accountID)
  )
}

/**
 * Pure provider-account policy.
 *
 * No process-local binding/cursor/counter state lives here. Selection is a
 * deterministic function of the caller-supplied durable snapshot. The result
 * proposes the next assignment epoch/cursor but never mutates the input.
 */
export function select(input: SelectInput): Result {
  const providerID = canonical(input.providerID)
  if (!providerID) return invalid("providerID", "must be non-empty")
  const affinityDomain = canonical(input.affinityDomain)
  if (!affinityDomain) return invalid("affinityDomain", "must be non-empty")
  if (providerID !== input.providerID) {
    return invalid("providerID", "must already be canonical")
  }
  if (affinityDomain !== input.affinityDomain) {
    return invalid("affinityDomain", "must already be canonical")
  }

  const cursor = input.cursor ?? { epoch: 0 }
  if (!safeInteger(cursor.epoch)) {
    return invalid("cursor.epoch", "must be a non-negative safe integer")
  }
  if (cursor.epoch === Number.MAX_SAFE_INTEGER) {
    return invalid("cursor.epoch", "cannot advance beyond Number.MAX_SAFE_INTEGER")
  }
  if (cursor.lastAssignedHandle !== undefined) {
    const handle = canonical(cursor.lastAssignedHandle)
    if (!handle) return invalid("cursor.lastAssignedHandle", "must be non-empty when present")
    if (handle !== cursor.lastAssignedHandle) {
      return invalid("cursor.lastAssignedHandle", "must already be canonical")
    }
  }
  if (input.afterCredentialHandle !== undefined) {
    const handle = canonical(input.afterCredentialHandle)
    if (!handle) return invalid("afterCredentialHandle", "must be non-empty when present")
    if (handle !== input.afterCredentialHandle) {
      return invalid("afterCredentialHandle", "must already be canonical")
    }
  }

  const excluded = input.excludedCredentialHandles ?? new Set<string>()
  for (const handle of excluded) {
    const canonicalHandle = canonical(handle)
    if (!canonicalHandle || canonicalHandle !== handle) {
      return invalid("excludedCredentialHandles", "every handle must be non-empty and canonical")
    }
  }
  const ordered = [...input.candidates].sort(compareIdentity)
  const targetHandles = new Set<string>()

  for (const candidate of ordered) {
    const candidateProviderID = canonical(candidate.providerID)
    if (!candidateProviderID) return invalid("candidate.providerID", "must be non-empty")
    if (candidateProviderID !== candidate.providerID) {
      return invalid("candidate.providerID", "must already be canonical")
    }
    const accountID = canonical(candidate.accountID)
    if (!accountID) return invalid("candidate.accountID", "must be non-empty")
    if (accountID !== candidate.accountID) {
      return invalid("candidate.accountID", "must already be canonical")
    }
    const credentialHandle = canonical(candidate.credentialHandle)
    if (!credentialHandle) return invalid("candidate.credentialHandle", "must be non-empty")
    if (credentialHandle !== candidate.credentialHandle) {
      return invalid("candidate.credentialHandle", "must already be canonical")
    }
    if (!finiteNonNegative(candidate.healthRank) || candidate.healthRank > MAX_HEALTH_RANK) {
      return invalid("candidate.healthRank", `must be finite and between 0 and ${MAX_HEALTH_RANK}`)
    }
    if (
      candidate.maxSessionBindings !== undefined &&
      !safeInteger(candidate.maxSessionBindings)
    ) {
      return invalid("candidate.maxSessionBindings", "must be a non-negative safe integer")
    }
    if (candidate.resetAt !== undefined && !finiteNonNegative(candidate.resetAt)) {
      return invalid("candidate.resetAt", "must be finite and non-negative")
    }

    if (candidate.providerID !== input.providerID) continue
    if (targetHandles.has(candidate.credentialHandle)) {
      return invalid(
        "candidate.credentialHandle",
        "must be unique within the selected provider",
      )
    }
    targetHandles.add(candidate.credentialHandle)

    const stats = input.stats?.get(candidate.credentialHandle)
    if (stats) {
      if (!safeInteger(stats.activeBindings)) {
        return invalid("stats.activeBindings", "must be a non-negative safe integer")
      }
      if (!safeInteger(stats.assignmentCount)) {
        return invalid("stats.assignmentCount", "must be a non-negative safe integer")
      }
      if (stats.lastAssignedAt !== undefined && !finiteNonNegative(stats.lastAssignedAt)) {
        return invalid("stats.lastAssignedAt", "must be finite and non-negative")
      }
    }
  }

  const rejected: Rejection[] = []
  const eligibleByHandle = new Map<string, PreparedCandidate>()
  const targetRing: Candidate[] = []

  for (const candidate of ordered) {
    if (candidate.providerID !== input.providerID) {
      rejected.push(rejection(candidate, "provider-mismatch"))
      continue
    }
    targetRing.push(candidate)

    if (excluded.has(candidate.credentialHandle)) {
      rejected.push(rejection(candidate, "excluded"))
      continue
    }
    if (!candidate.admissible) {
      rejected.push(
        rejection(candidate, "provider-ineligible", candidate.ineligibleReason),
      )
      continue
    }

    const stats = input.stats?.get(candidate.credentialHandle) ?? {
      activeBindings: 0,
      assignmentCount: 0,
    }
    if (
      candidate.maxSessionBindings !== undefined &&
      stats.activeBindings >= candidate.maxSessionBindings
    ) {
      rejected.push(rejection(candidate, "capacity"))
      continue
    }

    eligibleByHandle.set(candidate.credentialHandle, {
      candidate,
      stats,
      usedPercent: finitePercent(candidate.usedPercent),
    })
  }

  let selected: PreparedCandidate | undefined
  if (input.mode === "concentrate") {
    selected = [...eligibleByHandle.values()].sort(concentrateCompare)[0]
  } else {
    const ring = [...targetRing].sort(
      (left, right) =>
        left.credentialHandle.localeCompare(right.credentialHandle) ||
        left.accountID.localeCompare(right.accountID),
    )
    const after = input.afterCredentialHandle ?? cursor.lastAssignedHandle
    const position =
      after === undefined
        ? -1
        : ring.findIndex((candidate) => candidate.credentialHandle === after)

    for (let offset = 1; offset <= ring.length; offset++) {
      const index = (Math.max(-1, position) + offset) % ring.length
      const candidate = ring[index]
      if (!candidate) continue
      const prepared = eligibleByHandle.get(candidate.credentialHandle)
      if (prepared) {
        selected = prepared
        break
      }
    }
  }

  if (!selected) {
    return {
      ok: true,
      selection: {
        rejected,
      },
    }
  }

  const assignmentEpoch = cursor.epoch + 1
  const nextCursor: Cursor = {
    epoch: assignmentEpoch,
    ...(input.mode === "session-round-robin"
      ? { lastAssignedHandle: selected.candidate.credentialHandle }
      : cursor.lastAssignedHandle
        ? { lastAssignedHandle: cursor.lastAssignedHandle }
        : {}),
  }

  return {
    ok: true,
    selection: {
      selected: candidateIdentity(selected.candidate),
      rejected,
      assignmentEpoch,
      nextCursor,
    },
  }
}
