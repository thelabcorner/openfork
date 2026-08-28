export * as PushSubscription from "./push-subscription"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

export const ID = Schema.String.pipe(
  Schema.brand("PushSubscription.ID"),
  statics((schema) => ({ create: () => schema.make("psh_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Keys = Schema.Struct({
  p256dh: Schema.String,
  auth: Schema.String,
}).annotate({ identifier: "PushSubscription.Keys" })
export interface Keys extends Schema.Schema.Type<typeof Keys> {}

export const Info = Schema.Struct({
  id: ID,
  createdAt: Schema.String,
  lastSeenAt: Schema.String,
  userAgentHint: Schema.optional(Schema.String),
}).annotate({ identifier: "PushSubscription.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

/** Sent by the client after `PushManager.subscribe()`. The endpoint/keys are
 * secret capability material — never logged, never returned back to a client. */
export const SubscribeInput = Schema.Struct({
  endpoint: Schema.String,
  keys: Keys,
  expirationTime: Schema.optional(Schema.NullOr(Schema.Number)),
  userAgentHint: Schema.optional(Schema.String),
}).annotate({ identifier: "PushSubscription.SubscribeInput" })
export interface SubscribeInput extends Schema.Schema.Type<typeof SubscribeInput> {}
