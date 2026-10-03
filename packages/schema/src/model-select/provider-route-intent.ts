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

/**
 * Serializable route preference only. Runtime compatibility normalization from
 * legacy Model.Ref.accountID belongs to the Core provider-route owner.
 */
export const Info = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("auto") }),
  Schema.Struct({ kind: Schema.Literal("public") }),
  Schema.Struct({
    kind: Schema.Literal("account"),
    accountID: AccountID,
    pin: optional(Pin),
  }),
]).annotate({ identifier: "ProviderRouteIntent" })
export type Info = typeof Info.Type
