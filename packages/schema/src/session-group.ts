export * as SessionGroup from "./session-group"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, optional } from "./schema"
import { SessionGroupID } from "./session-group-id"
import { define } from "./event"

export const ID = SessionGroupID
export type ID = SessionGroupID

export const Kind = Schema.Literals(["user", "subagent", "plugin"])
export type Kind = typeof Kind.Type

export const MemberOrigin = Schema.Literals(["user", "auto_subagent", "plugin"])
export type MemberOrigin = typeof MemberOrigin.Type

export interface Policy extends Schema.Schema.Type<typeof Policy> {}
export const Policy = Schema.Struct({
  autoAddDescendants: Schema.Boolean,
  lockAdded: Schema.Boolean,
  autoDeleteWhenEmpty: Schema.Boolean,
}).annotate({ identifier: "SessionGroup.Policy" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  position: Schema.Number,
  kind: Kind,
  ownerPlugin: optional(Schema.String),
  anchorSessionID: optional(Schema.String),
  policy: optional(Policy),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    archived: optional(DateTimeUtcFromMillis),
  }),
}).annotate({ identifier: "SessionGroup.Info" })

export interface Member extends Schema.Schema.Type<typeof Member> {}
export const Member = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  locked: Schema.Boolean,
  origin: MemberOrigin,
  originPlugin: optional(Schema.String),
  originRef: optional(Schema.String),
  position: Schema.Number,
  timeAdded: DateTimeUtcFromMillis,
}).annotate({ identifier: "SessionGroup.Member" })

export interface Detail extends Schema.Schema.Type<typeof Detail> {}
export const Detail = Schema.Struct({
  group: Info,
  sessions: Schema.Array(Member),
}).annotate({ identifier: "SessionGroup.Detail" })

const Created = define({ type: "session_group.created", schema: { groupID: ID, info: Info } })
const Updated = define({ type: "session_group.updated", schema: { groupID: ID, info: Info } })
const Deleted = define({ type: "session_group.deleted", schema: { groupID: ID } })
const SessionAdded = define({
  type: "session_group.session.added",
  schema: { groupID: ID, sessionID: Schema.String },
})
const SessionRemoved = define({
  type: "session_group.session.removed",
  schema: { groupID: ID, sessionID: Schema.String },
})

export const Event = {
  Created,
  Updated,
  Deleted,
  SessionAdded,
  SessionRemoved,
  Definitions: [Created, Updated, Deleted, SessionAdded, SessionRemoved],
} as const
