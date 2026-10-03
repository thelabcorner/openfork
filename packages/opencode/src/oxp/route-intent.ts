export * as OxpRouteIntent from "./route-intent"

import { ProviderRouteIntentRuntime } from "@opencode-ai/core/provider-route-intent"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { Effect } from "effect"
import { OxpError } from "./error"
import type { OxpSchema } from "./schema"

/**
 * Migration-window OXP selection: the legacy first-class `accountID` contract
 * plus an optional explicit route intent.
 *
 * Route state is additive and stays out of model identity, and Public never
 * acquires an account identity. The shape is declared here rather than in
 * `oxp/schema.ts` because that module's `ModelSelection` contract is owned by
 * another lane: the OXP wire schema gains the optional field there, or the
 * connector never carries route intent at all. This type is not a second
 * schema identity and is not decoded from the wire.
 */
export type RouteSelection = OxpSchema.ModelSelection & {
  readonly routeIntent?: ProviderRouteIntent.Info
}

export type AccountMode = "automatic" | "explicit" | "public"

const ACCOUNT_MODES = {
  auto: "automatic",
  public: "public",
  account: "explicit",
} as const satisfies Record<ProviderRouteIntent.Info["kind"], AccountMode>

export interface NormalizeInput {
  readonly routeIntent?: ProviderRouteIntent.Info
  /** Backward-compatible `ModelSelection.accountID`. */
  readonly legacyAccountID?: string
}

/**
 * The single OXP ingress authority for migration-window route intent.
 *
 * The compatibility rules are not restated here: the Core P6-N normalizer owns
 * them, and this adapter only projects its typed failure into the OXP error
 * contract. Callers therefore fail closed instead of degrading an explicit
 * route choice into automatic routing or into a different account.
 */
export function normalize(input: NormalizeInput): ProviderRouteIntent.Info {
  const outcome = Effect.runSync(
    ProviderRouteIntentRuntime.normalize({
      routeIntent: input.routeIntent,
      legacyAccountID: input.legacyAccountID,
    }).pipe(
      Effect.map((routeIntent) => ({ ok: true as const, routeIntent })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (outcome.ok) return outcome.routeIntent
  throw oxpError(outcome.error)
}

/** OXP-facing account mode, derived from route intent rather than a missing account. */
export function accountMode(routeIntent: ProviderRouteIntent.Info): AccountMode {
  return ACCOUNT_MODES[routeIntent.kind]
}

/** The account a provider lowering may use. Auto and Public resolve no account. */
export function accountRouteID(routeIntent: ProviderRouteIntent.Info): string | undefined {
  return routeIntent.kind === "account" ? routeIntent.accountID : undefined
}

function oxpError(error: ProviderRouteIntentRuntime.Error): OxpError.Error {
  if (error._tag === "ProviderRouteIntent.InvalidLegacyAccount") {
    return new OxpError.InvalidArgument({
      detail: `accountID is not a valid route account identity: ${JSON.stringify(error.accountID)}`,
    })
  }
  const legacy = JSON.stringify(error.legacyAccountID)
  if (error.routeKind === "account") {
    return new OxpError.Conflict({
      detail: `accountID ${legacy} conflicts with explicit account route ${JSON.stringify(error.routeAccountID)}`,
    })
  }
  return new OxpError.Conflict({
    detail: `accountID ${legacy} conflicts with explicit ${error.routeKind} route intent, which is account-free`,
  })
}
