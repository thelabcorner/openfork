export * as ProviderRouteIntentRuntime from "./provider-route-intent"

import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { Effect, Schema } from "effect"

export interface NormalizeInput {
  readonly routeIntent?: ProviderRouteIntent.Info
  /** Backward-compatible Model.Ref.accountID during the route-intent migration window. */
  readonly legacyAccountID?: string
}

export class InvalidLegacyAccountError extends Schema.TaggedErrorClass<InvalidLegacyAccountError>()(
  "ProviderRouteIntent.InvalidLegacyAccount",
  {
    accountID: Schema.String,
  },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
  "ProviderRouteIntent.Conflict",
  {
    legacyAccountID: Schema.String,
    routeKind: Schema.Literals(["auto", "public", "account"]),
    routeAccountID: Schema.optional(Schema.String),
  },
) {}

export type Error = InvalidLegacyAccountError | ConflictError

/**
 * Normalize migration-window route selection without turning route state into
 * model identity.
 *
 * Legacy account selection is intentionally treated as a hard pin because the
 * caller explicitly named that account before ProviderRouteIntent existed.
 * Explicit routeIntent, when present, is authoritative and may only coexist
 * with a legacy accountID when it selects that exact same account.
 */
export const normalize = Effect.fn("ProviderRouteIntent.normalize")(function* (input: NormalizeInput) {
  const legacyAccountID = input.legacyAccountID

  if (legacyAccountID !== undefined && !Schema.is(ProviderRouteIntent.AccountID)(legacyAccountID)) {
    return yield* new InvalidLegacyAccountError({ accountID: legacyAccountID })
  }

  const intent = input.routeIntent
  if (!intent) {
    if (legacyAccountID === undefined) {
      return { kind: "auto" } satisfies ProviderRouteIntent.Info
    }
    return {
      kind: "account",
      accountID: legacyAccountID,
      pin: "hard",
    } satisfies ProviderRouteIntent.Info
  }

  if (legacyAccountID === undefined) return intent

  if (intent.kind !== "account" || intent.accountID !== legacyAccountID) {
    return yield* new ConflictError({
      legacyAccountID,
      routeKind: intent.kind,
      ...(intent.kind === "account" ? { routeAccountID: intent.accountID } : {}),
    })
  }

  return intent
})
