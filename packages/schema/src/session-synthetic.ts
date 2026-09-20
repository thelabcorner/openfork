export * as SessionSynthetic from "./session-synthetic"

import { Schema } from "effect"
import { Agent } from "./agent"
import { FileAttachment } from "./prompt"
import { optional } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

/**
 * Typed provenance carried by host-owned Session input.
 *
 * This is deliberately separate from provider role and presentation metadata.
 * Correlation references explain causality; they never grant authority.
 */
export interface TurnRef extends Schema.Schema.Type<typeof TurnRef> {}
export const TurnRef = Schema.Struct({
  sessionID: SessionID,
  messageID: SessionMessage.ID,
}).annotate({ identifier: "Session.Synthetic.TurnRef" })

export const Actor = Schema.Union([
  Schema.Struct({ type: Schema.Literal("host") }),
  Schema.Struct({
    type: Schema.Literal("session"),
    sessionID: SessionID,
    messageID: SessionMessage.ID.pipe(optional),
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Synthetic.Actor" })
export type Actor = typeof Actor.Type

export interface Origin extends Schema.Schema.Type<typeof Origin> {}
export const Origin = Schema.Struct({
  producer: Schema.String,
  actor: Actor,
  ref: Schema.String.pipe(optional),
  cause: TurnRef.pipe(optional),
}).annotate({ identifier: "Session.Synthetic.Origin" })

export interface Content extends Schema.Schema.Type<typeof Content> {}
export const Content = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
}).annotate({ identifier: "Session.Synthetic.Content" })

/**
 * Explicit authority delegated by a trusted producer. Never derive this from
 * synthetic text, file names, mentions, or arbitrary metadata.
 */
export interface DelegatedTurnAuthority extends Schema.Schema.Type<typeof DelegatedTurnAuthority> {}
export const DelegatedTurnAuthority = Schema.Struct({
  authorizedAgentNames: Schema.Array(Agent.ID).pipe(optional),
}).annotate({ identifier: "Session.Synthetic.DelegatedTurnAuthority" })
