export * as SessionInput from "./session-input"

import { Schema } from "effect"
import { optional } from "./schema"
import { Prompt } from "./prompt"
import { Model } from "./model"
import { ProviderRouteIntent } from "./model-select/provider-route-intent"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { SessionDelivery } from "./session-delivery"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"
import { SessionSynthetic } from "./session-synthetic"

export const Delivery = SessionDelivery.Delivery
export type Delivery = SessionDelivery.Delivery

export const Kind = Schema.Literals(["user", "synthetic"]).annotate({ identifier: "SessionInput.Kind" })
export type Kind = typeof Kind.Type

export const AdmissionClass = Schema.Literals(["user", "host", "automatic"]).annotate({
  identifier: "SessionInput.AdmissionClass",
})
export type AdmissionClass = typeof AdmissionClass.Type

export const SyntheticAdmissionClass = Schema.Literals(["host", "automatic"]).annotate({
  identifier: "SessionInput.SyntheticAdmissionClass",
})
export type SyntheticAdmissionClass = typeof SyntheticAdmissionClass.Type

export const RevocationReason = Schema.Literals([
  "cancelled",
  "superseded",
  "user_superseded",
  "expired",
  "policy",
]).annotate({ identifier: "SessionInput.RevocationReason" })
export type RevocationReason = typeof RevocationReason.Type

export const SyntheticContent = SessionSynthetic.Content
export type SyntheticContent = SessionSynthetic.Content
export const SyntheticOrigin = SessionSynthetic.Origin
export type SyntheticOrigin = SessionSynthetic.Origin
export const DelegatedTurnAuthority = SessionSynthetic.DelegatedTurnAuthority
export type DelegatedTurnAuthority = SessionSynthetic.DelegatedTurnAuthority

export interface SyntheticExecution extends Schema.Schema.Type<typeof SyntheticExecution> {}
export const SyntheticExecution = Schema.Struct({
  agent: Schema.String,
  model: Model.Ref,
  /** Durable execution-route intent. Binding/resolution remains a Core runtime concern. */
  routeIntent: ProviderRouteIntent.Info.pipe(optional),
}).annotate({ identifier: "SessionInput.SyntheticExecution" })

export interface UserItem extends Schema.Schema.Type<typeof UserItem> {}
export const UserItem = Schema.Struct({
  type: Schema.Literal("user"),
  prompt: Prompt,
}).annotate({ identifier: "SessionInput.User" })

export interface SyntheticItem extends Schema.Schema.Type<typeof SyntheticItem> {}
export const SyntheticItem = Schema.Struct({
  type: Schema.Literal("synthetic"),
  content: SyntheticContent,
  origin: SyntheticOrigin,
  delegated: DelegatedTurnAuthority.pipe(optional),
  execution: SyntheticExecution.pipe(optional),
}).annotate({ identifier: "SessionInput.Synthetic" })

export const Item = Schema.Union([UserItem, SyntheticItem])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SessionInput.Item" })
export type Item = UserItem | SyntheticItem

export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  kind: Kind,
  admissionClass: AdmissionClass,
  userPreemptible: Schema.Boolean,
  item: Item,
  delivery: Delivery,
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
  revokedSeq: NonNegativeInt.pipe(optional),
  revokedReason: RevocationReason.pipe(optional),
  /**
   * Session aggregate sequence of the InputCompleted event that proved this
   * exact input reached a successful provider cycle. Absent means never proven
   * complete; it is never inferred from Session ownership, a later cycle, or a
   * newer execution generation.
   */
  completedSeq: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionInput.Entry" })

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  prompt: Prompt,
  delivery: Delivery,
  provenance: SessionMessage.Provenance.pipe(optional),
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionInput.Admitted" })
