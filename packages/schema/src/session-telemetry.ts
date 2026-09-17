export * as SessionTelemetry from "./session-telemetry"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

export const Phase = Schema.Literals([
  "idle",
  "requesting",
  "reasoning",
  "generating",
  "tool",
  "retrying",
])
export type Phase = typeof Phase.Type

export const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})
export type Tokens = typeof Tokens.Type

export const Model = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  name: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  contextLimit: Schema.optional(Schema.Finite),
})
export type Model = typeof Model.Type

export const Step = Schema.Struct({
  assistantMessageID: Schema.optional(Schema.String),
  requestSentAt: Schema.optional(Schema.Finite),
  firstTokenAt: Schema.optional(Schema.Finite),
  streamedAt: Schema.optional(Schema.Finite),
  completedAt: Schema.optional(Schema.Finite),
  visibleChars: Schema.Finite,
  reasoningChars: Schema.Finite,
  generatedMs: Schema.Finite,
  toolMs: Schema.Finite,
  cost: Schema.optional(Schema.Finite),
  tokens: Schema.optional(Tokens),
})
export type Step = typeof Step.Type

export const Context = Schema.Struct({
  model: Model,
  tokens: Tokens,
})
export type Context = typeof Context.Type

export const Info = Schema.Struct({
  sessionID: SessionID,
  phase: Phase,
  phaseStartedAt: Schema.optional(Schema.Finite),
  updatedAt: Schema.Finite,
  model: Schema.optional(Model),
  /** Latest settled provider turn; remains stable while the next turn streams. */
  context: Schema.optional(Context),
  step: Schema.optional(Step),
  /** Full-session accumulated active generation/tool time. */
  generatedMs: Schema.Finite,
  toolMs: Schema.Finite,
})
export type Info = typeof Info.Type

/**
 * Bounded, coalesced UI projection. This is intentionally non-durable: the
 * durable settled snapshot lives in session_telemetry while this event carries
 * only the latest live overlay. A single event may update many sessions so N
 * concurrent streams do not imply N independent transport tickers.
 */
export const Updated = Event.define({
  type: "session.telemetry.updated",
  schema: {
    items: Schema.Array(Info),
  },
})
export type Updated = typeof Updated.Type
