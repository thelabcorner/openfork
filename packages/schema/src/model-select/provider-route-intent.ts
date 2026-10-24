export * as ProviderRouteIntent from "./provider-route-intent"

import { Schema, SchemaGetter } from "effect"
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

/** Exactly two hosted account-routing strategies exist; omitted strategy means Adaptive. */
export const DEFAULT_STRATEGY: Strategy = "adaptive"

/**
 * Serializable route preference only. Runtime compatibility normalization from
 * legacy Model.Ref.accountID belongs to the Core provider-route owner.
 */
const CanonicalInfo = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("strategy"), strategy: optional(Strategy) }),
  Schema.Struct({ kind: Schema.Literal("public") }),
  Schema.Struct({
    kind: Schema.Literal("account"),
    accountID: AccountID,
    pin: optional(Pin),
  }),
])

// Decode pre-refactor saved Session/API records once, then expose only the new
// canonical strategy intent to consumers and encoders. This is a data migration
// adapter, not a third supported mode or a routable runtime variant.
const StoredInfo = Schema.Union([
  CanonicalInfo,
  Schema.Struct({ kind: Schema.Literal("auto"), strategy: optional(Strategy) }),
])

export const Info = StoredInfo.pipe(
  Schema.decodeTo(CanonicalInfo, {
    decode: SchemaGetter.transform((input) =>
      input.kind === "auto"
        ? { kind: "strategy" as const, ...(input.strategy === undefined ? {} : { strategy: input.strategy }) }
        : input,
    ),
    encode: SchemaGetter.transform((input) => input),
  }),
).annotate({ identifier: "ProviderRouteIntent" })
export type Info = typeof Info.Type

/**
 * Resolve a user-facing account-routing strategy. A strategy route is not an
 * account pin or the upstream Public transport.
 * Explicit account pins and Public transport selection are not strategies.
 */
export function effectiveStrategy(intent: Info | undefined): Strategy | undefined {
  if (intent && intent.kind !== "strategy") return undefined
  return intent?.strategy ?? DEFAULT_STRATEGY
}
