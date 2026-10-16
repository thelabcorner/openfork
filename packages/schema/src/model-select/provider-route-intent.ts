export * as ProviderRouteIntent from "./provider-route-intent"

import { Schema } from "effect"
import { optional } from "../schema"

export const AccountID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
  identifier: "ProviderRouteIntent.AccountID",
})
export type AccountID = typeof AccountID.Type

export const Pin = Schema.Literals(["hard", "soft"]).annotate({
  identifier: "ProviderRouteIntent.Pin",
})
export type Pin = typeof Pin.Type

/** Policy for choosing among eligible subscription accounts. */
export const Strategy = Schema.Literals(["adaptive", "round-robin"]).annotate({
  identifier: "ProviderRouteIntent.Strategy",
})
export type Strategy = typeof Strategy.Type

/** Only two hosted account-routing strategies exist. Legacy unqualified intents mean Adaptive. */
export const DEFAULT_STRATEGY: Strategy = "adaptive"

/**
 * Serializable route preference only. Runtime compatibility normalization from
 * legacy Model.Ref.accountID belongs to the Core provider-route owner.
 */
export const Info = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("auto"), strategy: optional(Strategy) }),
  Schema.Struct({ kind: Schema.Literal("public") }),
  Schema.Struct({
    kind: Schema.Literal("account"),
    accountID: AccountID,
    pin: optional(Pin),
  }),
]).annotate({ identifier: "ProviderRouteIntent" })
export type Info = typeof Info.Type

/**
 * Resolve a user-facing account-routing strategy without mistaking the
 * historical wire discriminant `kind: "auto"` for a third strategy.
 * Explicit account pins and Public transport selection are not strategies.
 */
export function effectiveStrategy(intent: Info | undefined): Strategy | undefined {
  if (intent && intent.kind !== "auto") return undefined
  return intent?.strategy ?? DEFAULT_STRATEGY
}
