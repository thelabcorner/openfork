export * as SessionGroup from "./session-group"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, optional } from "./schema"
import { SessionGroupID } from "./session-group-id"
import { SwarmID } from "./swarm-id"
import { define } from "./event"

export const ID = SessionGroupID
export type ID = SessionGroupID

/** Persisted/generic SessionGroup kinds writable through the group domain. */
export const MutableKind = Schema.Literals(["user", "subagent", "plugin", "delegation"]).annotate({
  identifier: "SessionGroup.MutableKind",
})
export type MutableKind = typeof MutableKind.Type

/** Read-model kinds. Swarm is virtual and owned by the Swarm domain. */
export const Kind = Schema.Literals(["user", "subagent", "plugin", "delegation", "swarm"]).annotate({
  identifier: "SessionGroup.Kind",
})
export type Kind = typeof Kind.Type

/** Origins that may be materialized in session_group_member. */
export const MutableMemberOrigin = Schema.Literals([
  "user",
  "auto_subagent",
  "goal_auditor",
  "special_agent",
  "plugin",
  "delegation",
]).annotate({ identifier: "SessionGroup.MutableMemberOrigin" })
export type MutableMemberOrigin = typeof MutableMemberOrigin.Type

/** Read-model member origins. Swarm never implies a persisted group edge. */
export const MemberOrigin = Schema.Literals([
  "user",
  "auto_subagent",
  "goal_auditor",
  "special_agent",
  "plugin",
  "delegation",
  "swarm",
]).annotate({ identifier: "SessionGroup.MemberOrigin" })
export type MemberOrigin = typeof MemberOrigin.Type

const SWARM_GROUP_PREFIX = "grp_swarm_"
const SWARM_ID_PREFIX = "swr_"

/**
 * Collision-free virtual SessionGroup identity for one first-party Swarm.
 * No session_group row is required or implied.
 */
export function groupIDForSwarm(swarmID: SwarmID): ID {
  return ID.make(SWARM_GROUP_PREFIX + swarmID.slice(SWARM_ID_PREFIX.length))
}

/** Reverse the canonical virtual group mapping without consulting storage. */
export function swarmIDFromGroupID(groupID: ID): SwarmID | undefined {
  if (!groupID.startsWith(SWARM_GROUP_PREFIX)) return undefined
  const suffix = groupID.slice(SWARM_GROUP_PREFIX.length)
  if (!suffix) return undefined
  return SwarmID.make(SWARM_ID_PREFIX + suffix)
}

export function isSwarmGroupID(groupID: ID) {
  return swarmIDFromGroupID(groupID) !== undefined
}

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
  /** Stable producer identity for one logical group. Plugin groups pair this
   * with ownerPlugin; first-party delegation groups use it directly. Unlike
   * the anchor session, this survives coordinator/session re-rooting. */
  ownerRef: optional(Schema.String),
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
  /** Lightweight session projection used by navigation/sidebar surfaces.
   * Optional for wire compatibility with servers that predate this projection. */
  slug: optional(Schema.String),
  projectID: optional(Schema.String),
  directory: optional(Schema.String),
  parentID: optional(Schema.String),
  version: optional(Schema.String),
  time: optional(
    Schema.Struct({
      created: DateTimeUtcFromMillis,
      updated: DateTimeUtcFromMillis,
      archived: optional(DateTimeUtcFromMillis),
    }),
  ),
  locked: Schema.Boolean,
  origin: MemberOrigin,
  originPlugin: optional(Schema.String),
  originRef: optional(Schema.String),
  /** Producer-owned special-agent kind (e.g. "goal_auditor", "prompt_revisor"),
   * projected from the member Session's protected metadata. Optional for wire
   * compatibility with servers that predate this projection; UI classification
   * must fall back to `origin` rather than inferring from title/originRef. */
  specialAgent: optional(Schema.String),
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
