export * as SessionLimitRecovery from "./session-limit-recovery"

import { Schema } from "effect"
import { Model } from "./model"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"
import { Event } from "./event"

export const ResetSource = Schema.Literals(["retry-after", "provider", "observed", "local", "inferred"]).annotate({
  identifier: "SessionLimitRecovery.ResetSource",
})
export type ResetSource = typeof ResetSource.Type

export const FailureClass = Schema.Literals(["account-quota", "public-quota", "account-rate-limit", "rate-limit"])
  .annotate({ identifier: "SessionLimitRecovery.FailureClass" })
export type FailureClass = typeof FailureClass.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  sessionID: SessionID,
  sourceAssistantMessageID: SessionMessage.ID,
  sourceUserMessageID: SessionMessage.ID.pipe(optional),
  providerID: Schema.String,
  accountID: Schema.String.pipe(optional),
  modelID: Schema.String,
  failureClass: FailureClass,
  failureCode: Schema.String.pipe(optional),
  resetAt: DateTimeUtcFromMillis.pipe(optional),
  resetSource: ResetSource.pipe(optional),
  resetObservedAt: DateTimeUtcFromMillis.pipe(optional),
  expectedLatestUserSeq: NonNegativeInt.pipe(optional),
  generation: NonNegativeInt,
  autoResume: Schema.Boolean,
  manualResume: Schema.Boolean,
  snoozeUntil: DateTimeUtcFromMillis.pipe(optional),
  continuationID: Schema.String,
  claimOwner: Schema.String.pipe(optional),
  claimExpiresAt: DateTimeUtcFromMillis.pipe(optional),
  timeCreated: DateTimeUtcFromMillis,
  timeUpdated: DateTimeUtcFromMillis,
}).annotate({ identifier: "SessionLimitRecovery.Info" })

export const Updated = Event.define({
  type: "session.limit_recovery.updated",
  schema: { recovery: Info },
})

export const Cleared = Event.define({
  type: "session.limit_recovery.cleared",
  schema: { sessionID: SessionID, generation: NonNegativeInt },
})

export const Definitions = Event.inventory(Updated, Cleared)
