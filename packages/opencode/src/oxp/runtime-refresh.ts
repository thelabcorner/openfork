import { Effect, Schema } from "effect"
import { OxpError } from "./error"
import { OxpResult } from "./result"

export const MIN_ACCEPT_WITHIN_MS = 15_000
export const DEFAULT_ACCEPT_WITHIN_MS = 120_000
export const MAX_ACCEPT_WITHIN_MS = 300_000
export const PROTOCOL_VERSION = 2 as const

const RuntimeID = Schema.String.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/),
)
const TrialID = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
)
const AcceptWithinMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(MIN_ACCEPT_WITHIN_MS),
  Schema.isLessThanOrEqualTo(MAX_ACCEPT_WITHIN_MS),
)

export const Parameters = Schema.Struct({
  action: Schema.Literals(["refresh", "accept", "rollback"]),
  expectedRuntimeID: Schema.optional(RuntimeID),
  trialID: Schema.optional(TrialID),
  acceptWithinMs: Schema.optional(AcceptWithinMs),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export type RuntimeTransitionOutcome =
  | "accepted"
  | "reverted"
  | "failed"
  | "unchanged"

export interface RuntimeTransition {
  readonly trialID: string
  readonly outcome: RuntimeTransitionOutcome
  readonly at: number
  readonly detail?: string
}

export interface RuntimeTrial {
  readonly id: string
  readonly previousRuntimeID: string
  readonly candidateRuntimeID: string
  readonly phase: "scheduled" | "active"
  readonly activationAt?: number
  readonly acceptBy?: number
}

export interface RuntimeStatus {
  readonly refreshable: boolean
  readonly state: "stable" | "scheduled" | "trial" | "degraded" | "disposed"
  readonly runtimeID?: string
  readonly activationGeneration?: number
  readonly activatedAt?: number
  readonly trial?: RuntimeTrial
  readonly lastTransition?: RuntimeTransition
  readonly detail?: string
}

export interface RuntimeMutationResult {
  readonly action: "refresh" | "accept" | "rollback"
  readonly changed: boolean
  readonly status: RuntimeStatus
}

export interface Control {
  readonly status: () => Promise<RuntimeStatus>
  readonly refresh: (input: {
    readonly expectedRuntimeID: string
    readonly acceptWithinMs: number
  }) => Promise<RuntimeMutationResult>
  /** Host-only response-egress barrier for changed scheduled refreshes. */
  readonly arm: (trialID: string) => Promise<void>
  readonly accept: (trialID: string) => Promise<RuntimeMutationResult>
  readonly rollback: (trialID: string) => Promise<RuntimeMutationResult>
}

let control: Control | undefined

/**
 * Host-only injection point. The Desktop sidecar owns runtime module loading and
 * installs one caller-bound control object into each loaded backend module.
 * Callers can never provide a module path through the OXP contract.
 */
export function install(next: Control | undefined) {
  control = next
}

export async function status(): Promise<RuntimeStatus> {
  const current = control
  if (!current) {
    return {
      refreshable: false,
      state: "stable",
      detail: "Transactional runtime refresh is unavailable in this host.",
    }
  }
  try {
    return await current.status()
  } catch {
    return {
      refreshable: false,
      state: "stable",
      detail: "Runtime refresh status is temporarily unavailable.",
    }
  }
}

function mappedError(error: unknown): OxpError.Error {
  if (OxpError.isError(error)) return error
  const source =
    error && typeof error === "object"
      ? (error as { readonly code?: unknown; readonly message?: unknown })
      : undefined
  const detail = OxpError.boundDetail(
    typeof source?.message === "string" ? source.message : error,
    "Runtime refresh operation failed",
  )
  switch (source?.code) {
    case "OXP_BUSY":
      return new OxpError.Busy({ detail })
    case "OXP_CONFLICT":
      return new OxpError.Conflict({ detail })
    case "OXP_HANDLE_STALE":
      return new OxpError.HandleStale({ detail })
    case "OXP_AUTH_DENIED":
      return new OxpError.AuthDenied({ detail })
    case "OXP_INVALID_ARGUMENT":
      return new OxpError.InvalidArgument({ detail })
    default:
      return new OxpError.DependencyUnavailable({ detail })
  }
}

export const execute = Effect.fn("OxpRuntimeRefresh.execute")(function* (
  input: Input,
) {
  const current = control
  if (!current) {
    return yield* new OxpError.DependencyUnavailable({
      detail:
        "Transactional runtime refresh is unavailable in this host; use the normal application restart/update path.",
    })
  }

  let operation: Promise<RuntimeMutationResult>
  if (input.action === "refresh") {
    if (!input.expectedRuntimeID) {
      return yield* new OxpError.InvalidArgument({
        detail:
          "runtime.refresh requires expectedRuntimeID from the current openfork_info status",
      })
    }
    if (input.trialID !== undefined) {
      return yield* new OxpError.InvalidArgument({
        detail: "trialID is not valid for runtime.refresh",
      })
    }
    operation = current.refresh({
      expectedRuntimeID: input.expectedRuntimeID,
      acceptWithinMs: input.acceptWithinMs ?? DEFAULT_ACCEPT_WITHIN_MS,
    })
  } else {
    if (!input.trialID) {
      return yield* new OxpError.InvalidArgument({
        detail: `runtime.${input.action} requires trialID`,
      })
    }
    if (
      input.expectedRuntimeID !== undefined ||
      input.acceptWithinMs !== undefined
    ) {
      return yield* new OxpError.InvalidArgument({
        detail:
          "expectedRuntimeID and acceptWithinMs are valid only for runtime.refresh",
      })
    }
    operation =
      input.action === "accept"
        ? current.accept(input.trialID)
        : current.rollback(input.trialID)
  }

  const result = yield* Effect.tryPromise({
    try: () => operation,
    catch: mappedError,
  })
  const scheduledTrial =
    input.action === "refresh" &&
    result.changed &&
    result.status.trial?.phase === "scheduled"
      ? result.status.trial.id
      : undefined

  return {
    title: `OXP runtime ${input.action}`,
    output: JSON.stringify(result),
    structured: result,
    mutation: {
      attempted: true,
      committed: result.changed,
    },
    ...(scheduledTrial
      ? {
          afterResponse: () => current.arm(scheduledTrial),
        }
      : {}),
  } satisfies OxpResult.CapabilityResult
})

export * as OxpRuntimeRefresh from "./runtime-refresh"
