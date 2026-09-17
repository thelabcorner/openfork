import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionGroupMemberTable, SessionGroupTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionGroup } from "@opencode-ai/schema/session-group"
import { DateTime } from "effect"
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm"
import { Effect, Layer, Context, Schema, Types } from "effect"
import { NotFoundError } from "@/storage/storage"
import { SessionID } from "@/session/schema"

export const ID = SessionGroup.ID
export type ID = Schema.Schema.Type<typeof ID>
export const Info = SessionGroup.Info
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>
export const Member = SessionGroup.Member
export type Member = Types.DeepMutable<Schema.Schema.Type<typeof Member>>
export const Detail = SessionGroup.Detail
export type Detail = Types.DeepMutable<Schema.Schema.Type<typeof Detail>>

export class MemberLockedError extends Schema.TaggedErrorClass<MemberLockedError>()("SessionGroupMemberLockedError", {
  code: Schema.Literal("session_group.member_locked"),
  message: Schema.String,
  groupID: SessionGroup.ID,
  sessionID: Schema.String,
}) {}

export class OwnerMismatchError extends Schema.TaggedErrorClass<OwnerMismatchError>()(
  "SessionGroupOwnerMismatchError",
  {
    code: Schema.Literal("session_group.owner_mismatch"),
    message: Schema.String,
    groupID: SessionGroup.ID,
    sessionID: Schema.String,
  },
) {}

export class HasLockedMembersError extends Schema.TaggedErrorClass<HasLockedMembersError>()(
  "SessionGroupHasLockedMembersError",
  {
    code: Schema.Literal("session_group.has_locked_members"),
    message: Schema.String,
    groupID: SessionGroup.ID,
    lockedCount: Schema.Number,
  },
) {}

export const Event = SessionGroup.Event

type MembershipError = NotFoundError | MemberLockedError | OwnerMismatchError
type RemoveError = NotFoundError | HasLockedMembersError | OwnerMismatchError
type GroupPolicy = Schema.Schema.Type<typeof SessionGroup.Policy>

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly listWithSessions: () => Effect.Effect<Detail[]>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly resolveOrCreate: (input: ResolveInput) => Effect.Effect<Info>
  readonly rename: (input: { id: ID; name: string }) => Effect.Effect<void, NotFoundError>
  readonly remove: (
    id: ID,
    options?: {
      mode?: "unlink_unlocked" | "cascade_unlink"
      ownerPlugin?: string
      anchorSessionDeleted?: boolean
    },
  ) => Effect.Effect<void, RemoveError>
  readonly reorder: (input: { id: ID; position: number }) => Effect.Effect<void, NotFoundError>
  readonly addSession: (input: AddSessionInput) => Effect.Effect<void, NotFoundError>
  readonly removeSession: (input: RemoveSessionInput) => Effect.Effect<void, MembershipError>
  /** Internal lifecycle hook: detach a session that is being permanently deleted. */
  readonly detachDeletedSession: (sessionId: string) => Effect.Effect<void>
  readonly membershipsFor: (sessionId: string) => Effect.Effect<Detail[]>
  readonly getWithSessions: (id: ID) => Effect.Effect<Detail, NotFoundError>
  readonly setPolicy: (input: { id: ID; policy: GroupPolicy }) => Effect.Effect<void, NotFoundError>
  readonly reorderMembers: (input: { id: ID; sessionIds: string[] }) => Effect.Effect<void, NotFoundError>
  readonly capabilities: () => Effect.Effect<{ version: number; features: string[] }>
}

interface CreateInput {
  name: string
  kind?: SessionGroup.Kind
  anchorSessionId?: string
  ownerPlugin?: string
  ownerRef?: string
  policy?: GroupPolicy
}

interface ResolveInput extends CreateInput {
  kind: SessionGroup.Kind
}

interface AddSessionInput {
  groupId: ID
  sessionId: string
  locked?: boolean
  origin?: SessionGroup.MemberOrigin
  originPlugin?: string
  originRef?: string
  position?: number
}

interface RemoveSessionInput {
  groupId: ID
  sessionId: string
  ownerPlugin?: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGroup") {}

const layer: Layer.Layer<Service, never, Database.Service | EventV2Bridge.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const filename = database.filename
    let listCache: { at: number; value: Info[] } | null = null
    let detailCache: { at: number; value: Detail[] } | null = null
    const membershipsCache = new Map<string, { at: number; value: Detail[] }>()
    const LIST_TTL = 5_000
    const invalidate = (sessionId?: string) => {
      listCache = null
      detailCache = null
      if (sessionId) membershipsCache.delete(sessionId)
      if (!sessionId) membershipsCache.clear()
    }

    const list = Effect.fn("SessionGroup.list")(function* () {
      const now = Date.now()
      if (listCache && now - listCache.at < LIST_TTL) return listCache.value
      const read = (backfill: Database.DatabaseShape) =>
        backfill
          .select()
          .from(SessionGroupTable)
          .where(
            sql`EXISTS (
              SELECT 1 FROM ${SessionGroupMemberTable}
              WHERE ${SessionGroupMemberTable.group_id} = ${SessionGroupTable.id}
            )`,
          )
          .orderBy(asc(SessionGroupTable.position))
          .all()
      const rows = yield* (filename === ":memory:" ? read(database.db) : Database.withBackfillDb(filename, read)).pipe(
        Effect.orDie,
      )
      const value = rows.map(fromGroupRow)
      listCache = { at: now, value }
      return value
    })

    const listWithSessions = Effect.fn("SessionGroup.listWithSessions")(function* () {
      const now = Date.now()
      if (detailCache && now - detailCache.at < LIST_TTL) return detailCache.value
      const read = (backfill: Database.DatabaseShape) =>
        Effect.gen(function* () {
          const groupRows = yield* backfill
            .select()
            .from(SessionGroupTable)
            .where(
              sql`EXISTS (
                SELECT 1 FROM ${SessionGroupMemberTable}
                WHERE ${SessionGroupMemberTable.group_id} = ${SessionGroupTable.id}
              )`,
            )
            .orderBy(asc(SessionGroupTable.position))
            .all()
          const memberRows = yield* backfill
            .select({
              member: SessionGroupMemberTable,
              session: {
                id: SessionTable.id,
                slug: SessionTable.slug,
                projectID: SessionTable.project_id,
                directory: SessionTable.directory,
                parentID: SessionTable.parent_id,
                title: SessionTable.title,
                version: SessionTable.version,
                timeCreated: SessionTable.time_created,
                timeUpdated: SessionTable.time_updated,
                timeArchived: SessionTable.time_archived,
              },
            })
            .from(SessionGroupMemberTable)
            .innerJoin(SessionTable, eq(SessionGroupMemberTable.session_id, SessionTable.id))
            .orderBy(asc(SessionGroupMemberTable.position), asc(SessionGroupMemberTable.time_added))
            .all()
          return [groupRows, memberRows] as const
        })
      const [groups, memberships] = yield* (
        filename === ":memory:" ? read(database.db) : Database.withBackfillDb(filename, read)
      ).pipe(Effect.orDie)
      const byGroup = new Map<string, Member[]>()
      for (const row of memberships) {
        const bucket = byGroup.get(row.member.group_id)
        const member = fromMemberRow(row)
        if (bucket) bucket.push(member)
        if (!bucket) byGroup.set(row.member.group_id, [member])
      }
      const value = groups.map((group) => ({ group: fromGroupRow(group), sessions: byGroup.get(group.id) ?? [] }))
      detailCache = { at: now, value }
      listCache = { at: now, value: value.map((detail) => detail.group) }
      return value
    })

    const create = Effect.fn("SessionGroup.create")(function* (input: CreateInput) {
      const id = SessionGroup.ID.create()
      const now = Date.now()
      const row: typeof SessionGroupTable.$inferInsert = {
        id,
        name: input.name,
        position: now,
        kind: input.kind ?? "user",
        owner_plugin: input.ownerPlugin,
        owner_ref: input.ownerRef,
        anchor_session_id: input.anchorSessionId ? SessionID.make(input.anchorSessionId) : null,
        policy: input.policy,
        time_created: now,
        time_updated: now,
      }
      yield* database.db.insert(SessionGroupTable).values(row).run().pipe(Effect.orDie)
      invalidate()
      const info = fromGroupRow({
        id: row.id,
        name: row.name,
        position: row.position,
        kind: row.kind ?? "user",
        owner_plugin: row.owner_plugin ?? null,
        owner_ref: row.owner_ref ?? null,
        anchor_session_id: row.anchor_session_id ?? null,
        policy: row.policy ?? null,
        time_created: row.time_created,
        time_updated: row.time_updated,
        time_archived: null,
      })
      yield* events.publish(Event.Created, { groupID: id, info })
      return info
    })

    const resolveOrCreate = Effect.fn("SessionGroup.resolveOrCreate")(function* (input: ResolveInput) {
      const anchorSessionID = input.anchorSessionId ? SessionID.make(input.anchorSessionId) : undefined

      // Plugin-owned groups use a stable ownerRef instead of their anchor as
      // identity. A single coordinator may own multiple plugin groups, and the
      // coordinator session itself can be re-rooted/rebound over time. Resolve
      // the stable logical group first and update its presentation anchor
      // in-place so clients keep the same group id across those transitions.
      if (input.kind === "plugin" && input.ownerPlugin && input.ownerRef) {
        let existing = yield* database.db
          .select()
          .from(SessionGroupTable)
          .where(
            and(
              eq(SessionGroupTable.kind, "plugin"),
              eq(SessionGroupTable.owner_plugin, input.ownerPlugin),
              eq(SessionGroupTable.owner_ref, input.ownerRef),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        // Upgrade the pre-ownerRef representation in place when it is
        // unambiguous. This preserves existing plugin group ids across the
        // migration instead of flashing a duplicate group on first startup.
        if (!existing && anchorSessionID) {
          const legacy = yield* database.db
            .select()
            .from(SessionGroupTable)
            .where(
              and(
                eq(SessionGroupTable.kind, "plugin"),
                eq(SessionGroupTable.owner_plugin, input.ownerPlugin),
                eq(SessionGroupTable.name, input.name),
                eq(SessionGroupTable.anchor_session_id, anchorSessionID),
                isNull(SessionGroupTable.owner_ref),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (legacy) {
            const now = Date.now()
            yield* database.db
              .update(SessionGroupTable)
              .set({ owner_ref: input.ownerRef, time_updated: now })
              .where(eq(SessionGroupTable.id, legacy.id))
              .run()
              .pipe(Effect.orDie)
            existing = { ...legacy, owner_ref: input.ownerRef, time_updated: now }
            invalidate()
          }
        }
        if (existing) {
          const now = Date.now()
          const next = {
            ...existing,
            name: input.name,
            anchor_session_id: anchorSessionID ?? null,
            policy: input.policy ?? existing.policy,
            time_updated: now,
          }
          const changed =
            existing.name !== next.name ||
            existing.anchor_session_id !== next.anchor_session_id ||
            (input.policy !== undefined && JSON.stringify(existing.policy) !== JSON.stringify(input.policy))
          if (changed) {
            yield* database.db
              .update(SessionGroupTable)
              .set({
                name: next.name,
                anchor_session_id: next.anchor_session_id,
                policy: next.policy,
                time_updated: next.time_updated,
              })
              .where(eq(SessionGroupTable.id, existing.id))
              .run()
              .pipe(Effect.orDie)
            invalidate()
            const info = fromGroupRow(next)
            yield* events.publish(Event.Updated, { groupID: info.id, info })
            return info
          }
          return fromGroupRow(existing)
        }
      }

      if (!anchorSessionID) return yield* create(input)
      const id = SessionGroup.ID.create()
      const now = Date.now()
      const inserted = yield* database.db
        .insert(SessionGroupTable)
        .values({
          id,
          name: input.name,
          position: now,
          kind: input.kind,
          owner_plugin: input.ownerPlugin,
          owner_ref: input.ownerRef,
          anchor_session_id: anchorSessionID,
          policy: input.policy,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (inserted) {
        const info = fromGroupRow(inserted)
        invalidate()
        yield* events.publish(Event.Created, { groupID: info.id, info })
        return info
      }
      const existing = yield* database.db
        .select()
        .from(SessionGroupTable)
        .where(and(eq(SessionGroupTable.kind, input.kind), eq(SessionGroupTable.anchor_session_id, anchorSessionID)))
        .get()
        .pipe(Effect.orDie)
      if (existing) return fromGroupRow(existing)
      return yield* create(input)
    })

    const rename = Effect.fn("SessionGroup.rename")(function* (input: { id: ID; name: string }) {
      const row = yield* requireGroup(database.db, input.id)
      const now = Date.now()
      yield* database.db
        .update(SessionGroupTable)
        .set({ name: input.name, time_updated: now })
        .where(eq(SessionGroupTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
      const info = fromGroupRow({ ...row, name: input.name, time_updated: now })
      invalidate()
      yield* events.publish(Event.Updated, { groupID: input.id, info })
    })

    const remove = Effect.fn("SessionGroup.remove")(function* (
      id: ID,
      options?: {
        mode?: "unlink_unlocked" | "cascade_unlink"
        ownerPlugin?: string
        anchorSessionDeleted?: boolean
      },
    ) {
      const group = yield* requireGroup(database.db, id)
      const locked = yield* database.db
        .select({ session_id: SessionGroupMemberTable.session_id })
        .from(SessionGroupMemberTable)
        .where(and(eq(SessionGroupMemberTable.group_id, id), eq(SessionGroupMemberTable.locked, true)))
        .all()
        .pipe(Effect.orDie)
      if (locked.length > 0 && options?.mode !== "cascade_unlink") {
        return yield* new HasLockedMembersError({
          code: "session_group.has_locked_members",
          message: `This group contains ${locked.length} locked membership${locked.length === 1 ? "" : "s"}. Remove them through their owner before deleting the group.`,
          groupID: id,
          lockedCount: locked.length,
        })
      }
      if (locked.length > 0 && group.kind === "plugin" && group.owner_plugin !== options?.ownerPlugin) {
        return yield* new OwnerMismatchError({
          code: "session_group.owner_mismatch",
          message: "This group is managed by another plugin. Ask that plugin to remove it.",
          groupID: id,
          sessionID: locked[0].session_id,
        })
      }
      if (locked.length > 0 && group.kind === "subagent" && options?.anchorSessionDeleted !== true) {
        return yield* new HasLockedMembersError({
          code: "session_group.has_locked_members",
          message: "This subagent group stays attached to its parent session and cannot be deleted directly.",
          groupID: id,
          lockedCount: locked.length,
        })
      }
      if (locked.length > 0 && group.kind !== "plugin" && group.kind !== "subagent") {
        return yield* new HasLockedMembersError({
          code: "session_group.has_locked_members",
          message: "This group has locked memberships and cannot be deleted.",
          groupID: id,
          lockedCount: locked.length,
        })
      }
      yield* database.db
        .update(SessionTable)
        .set({
          group_id: sql`(SELECT ${SessionGroupMemberTable.group_id} FROM ${SessionGroupMemberTable} WHERE ${SessionGroupMemberTable.session_id} = ${SessionTable.id} AND ${SessionGroupMemberTable.group_id} != ${id} ORDER BY ${SessionGroupMemberTable.position}, ${SessionGroupMemberTable.time_added} LIMIT 1)`,
        })
        .where(eq(SessionTable.group_id, id))
        .run()
        .pipe(Effect.orDie)
      yield* database.db.delete(SessionGroupTable).where(eq(SessionGroupTable.id, id)).run().pipe(Effect.orDie)
      invalidate()
      yield* events.publish(Event.Deleted, { groupID: id })
    })

    const reorder = Effect.fn("SessionGroup.reorder")(function* (input: { id: ID; position: number }) {
      const row = yield* requireGroup(database.db, input.id)
      const now = Date.now()
      yield* database.db
        .update(SessionGroupTable)
        .set({ position: input.position, time_updated: now })
        .where(eq(SessionGroupTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
      const info = fromGroupRow({ ...row, position: input.position, time_updated: now })
      invalidate()
      yield* events.publish(Event.Updated, { groupID: input.id, info })
    })

    const addSession = Effect.fn("SessionGroup.addSession")(function* (input: AddSessionInput) {
      yield* requireGroup(database.db, input.groupId)
      const sessionID = SessionID.make(input.sessionId)
      const session = yield* database.db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return yield* new NotFoundError({ message: `Session not found: ${input.sessionId}` })
      const now = Date.now()
      const inserted = yield* database.db
        .insert(SessionGroupMemberTable)
        .values({
          group_id: input.groupId,
          session_id: sessionID,
          locked: input.locked ?? false,
          origin: input.origin ?? "user",
          origin_plugin: input.originPlugin,
          origin_ref: input.originRef,
          position: input.position ?? now,
          time_added: now,
        })
        .onConflictDoNothing()
        .returning({ session_id: SessionGroupMemberTable.session_id })
        .get()
        .pipe(Effect.orDie)
      if (!inserted) return
      yield* database.db
        .update(SessionTable)
        .set({ group_id: input.groupId, time_updated: now })
        .where(and(eq(SessionTable.id, sessionID), sql`${SessionTable.group_id} IS NULL`))
        .run()
        .pipe(Effect.orDie)
      invalidate(input.sessionId)
      yield* events.publish(Event.SessionAdded, { groupID: input.groupId, sessionID: input.sessionId })
    })

    const removeSession = Effect.fn("SessionGroup.removeSession")(function* (input: RemoveSessionInput) {
      yield* requireGroup(database.db, input.groupId)
      const sessionID = SessionID.make(input.sessionId)
      const member = yield* database.db
        .select()
        .from(SessionGroupMemberTable)
        .where(
          and(eq(SessionGroupMemberTable.group_id, input.groupId), eq(SessionGroupMemberTable.session_id, sessionID)),
        )
        .get()
        .pipe(Effect.orDie)
      if (!member) {
        return yield* new NotFoundError({
          message: `Session membership not found: ${input.groupId}/${input.sessionId}`,
        })
      }
      if (member.locked && member.origin === "auto_subagent") {
        return yield* new MemberLockedError({
          code: "session_group.member_locked",
          message:
            "This subagent can't leave its group. OpenFork keeps spawned sessions with their parent so they stay reachable.",
          groupID: input.groupId,
          sessionID: input.sessionId,
        })
      }
      if (member.locked && member.origin === "plugin" && member.origin_plugin !== input.ownerPlugin) {
        return yield* new OwnerMismatchError({
          code: "session_group.owner_mismatch",
          message: "This membership is managed by another plugin. Ask that plugin to remove it.",
          groupID: input.groupId,
          sessionID: input.sessionId,
        })
      }
      if (member.locked && member.origin !== "plugin") {
        return yield* new MemberLockedError({
          code: "session_group.member_locked",
          message: "This session has a locked membership and cannot leave this group.",
          groupID: input.groupId,
          sessionID: input.sessionId,
        })
      }
      yield* database.db
        .delete(SessionGroupMemberTable)
        .where(
          and(eq(SessionGroupMemberTable.group_id, input.groupId), eq(SessionGroupMemberTable.session_id, sessionID)),
        )
        .run()
        .pipe(Effect.orDie)
      const replacement = yield* database.db
        .select({ group_id: SessionGroupMemberTable.group_id })
        .from(SessionGroupMemberTable)
        .where(
          and(eq(SessionGroupMemberTable.session_id, sessionID), ne(SessionGroupMemberTable.group_id, input.groupId)),
        )
        .orderBy(asc(SessionGroupMemberTable.position), asc(SessionGroupMemberTable.time_added))
        .get()
        .pipe(Effect.orDie)
      yield* database.db
        .update(SessionTable)
        .set({ group_id: replacement?.group_id ?? null, time_updated: Date.now() })
        .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.group_id, input.groupId)))
        .run()
        .pipe(Effect.orDie)
      const remaining = yield* database.db
        .select({ session_id: SessionGroupMemberTable.session_id })
        .from(SessionGroupMemberTable)
        .where(eq(SessionGroupMemberTable.group_id, input.groupId))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!remaining) {
        // Groups are useful only as a relationship between sessions. Removing
        // the final explicit membership therefore removes the container too,
        // instead of leaving a permanently empty row for every abandoned
        // manual/plugin group. The list APIs also hide membership-empty rows so
        // a create-then-add transaction can never flash a "0 sessions" group.
        yield* database.db.delete(SessionGroupTable).where(eq(SessionGroupTable.id, input.groupId)).run().pipe(Effect.orDie)
      }
      invalidate(input.sessionId)
      yield* events.publish(Event.SessionRemoved, { groupID: input.groupId, sessionID: input.sessionId })
      if (!remaining) yield* events.publish(Event.Deleted, { groupID: input.groupId })
    })

    const detachDeletedSession = Effect.fn("SessionGroup.detachDeletedSession")(function* (sessionId: string) {
      const sessionID = SessionID.make(sessionId)
      const memberships = yield* database.db
        .select({ group_id: SessionGroupMemberTable.group_id })
        .from(SessionGroupMemberTable)
        .where(eq(SessionGroupMemberTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      if (memberships.length === 0) return

      // Deletion is not a user-requested ungroup operation, so locked/owner
      // policies do not apply. Remove every edge first; this also prevents the
      // FK cascade from silently changing membership behind the group's cache.
      yield* database.db
        .delete(SessionGroupMemberTable)
        .where(eq(SessionGroupMemberTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      const deletedGroups: ID[] = []
      for (const membership of memberships) {
        const remaining = yield* database.db
          .select({ session_id: SessionGroupMemberTable.session_id })
          .from(SessionGroupMemberTable)
          .where(eq(SessionGroupMemberTable.group_id, membership.group_id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (remaining) continue
        yield* database.db
          .delete(SessionGroupTable)
          .where(eq(SessionGroupTable.id, membership.group_id))
          .run()
          .pipe(Effect.orDie)
        deletedGroups.push(SessionGroup.ID.make(membership.group_id))
      }

      invalidate(sessionId)
      for (const membership of memberships) {
        yield* events.publish(Event.SessionRemoved, {
          groupID: SessionGroup.ID.make(membership.group_id),
          sessionID: sessionId,
        })
      }
      for (const groupID of deletedGroups) yield* events.publish(Event.Deleted, { groupID })
    })

    const membershipsFor = Effect.fn("SessionGroup.membershipsFor")(function* (sessionId: string) {
      const now = Date.now()
      const cached = membershipsCache.get(sessionId)
      if (cached && now - cached.at < LIST_TTL) return cached.value
      const value = (yield* listWithSessions()).filter((detail) =>
        detail.sessions.some((member) => member.id === sessionId),
      )
      membershipsCache.set(sessionId, { at: now, value })
      return value
    })

    const getWithSessions = Effect.fn("SessionGroup.getWithSessions")(function* (id: ID) {
      const detail = (yield* listWithSessions()).find((item) => item.group.id === id)
      if (!detail) return yield* new NotFoundError({ message: `Session group not found: ${id}` })
      return detail
    })

    const setPolicy = Effect.fn("SessionGroup.setPolicy")(function* (input: { id: ID; policy: GroupPolicy }) {
      const row = yield* requireGroup(database.db, input.id)
      const now = Date.now()
      yield* database.db
        .update(SessionGroupTable)
        .set({ policy: input.policy, time_updated: now })
        .where(eq(SessionGroupTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
      const info = fromGroupRow({ ...row, policy: input.policy, time_updated: now })
      invalidate()
      yield* events.publish(Event.Updated, { groupID: input.id, info })
    })

    const reorderMembers = Effect.fn("SessionGroup.reorderMembers")(function* (input: {
      id: ID
      sessionIds: string[]
    }) {
      yield* requireGroup(database.db, input.id)
      yield* Effect.forEach(
        input.sessionIds,
        (sessionId, position) =>
          database.db
            .update(SessionGroupMemberTable)
            .set({ position })
            .where(
              and(
                eq(SessionGroupMemberTable.group_id, input.id),
                eq(SessionGroupMemberTable.session_id, SessionID.make(sessionId)),
              ),
            )
            .run()
            .pipe(Effect.orDie),
        { discard: true },
      )
      invalidate()
    })

    const capabilities = Effect.fn("SessionGroup.capabilities")(function* () {
      return {
        version: 1,
        features: [
          "multiple-membership",
          "locked-membership",
          "plugin-ownership",
          "member-reordering",
          "subagent-auto-grouping",
          "goal-auditor-auto-grouping",
          "special-agent-auto-grouping",
          "session-group-assign-hook",
          "plugin-stable-identity",
        ],
      }
    })

    /**
     * Couple one host-owned special-agent transcript into the parent Session's
     * subagent group as an irremovable, locked member. Goal Auditor keeps its
     * dedicated `goal_auditor` origin; every other special agent (Prompt Revisor,
     * Session Title) uses the generic `special_agent` origin.
     */
    const attachSpecialAgent = Effect.fn("SessionGroup.attachSpecialAgent")(function* (input: {
      sessionID: string
      parentSessionID: string
      agent: string
      originRef: string
      parentTitle?: string
    }) {
      const group = yield* resolveOrCreate({
        name: input.parentTitle || "Subagents",
        kind: "subagent",
        anchorSessionId: input.parentSessionID,
        policy: { autoAddDescendants: true, lockAdded: true, autoDeleteWhenEmpty: true },
      })
      yield* addSession({ groupId: group.id, sessionId: input.parentSessionID, origin: "auto_subagent" })
      yield* addSession({
        groupId: group.id,
        sessionId: input.sessionID,
        locked: true,
        origin: input.agent === "goal_auditor" ? "goal_auditor" : "special_agent",
        originRef: input.originRef,
      })
    })

    const specialAgentOriginRef = (input: {
      sessionID: string
      metadata?: Record<string, unknown> | null
      agent: string
    }) => {
      if (input.agent === "goal_auditor") {
        const goalID = typeof input.metadata?.goalID === "string" ? input.metadata.goalID : undefined
        return goalID ? `goal:${goalID}` : undefined
      }
      const ownerID =
        typeof input.metadata?.specialAgentOwnerID === "string" ? input.metadata.specialAgentOwnerID : input.sessionID
      return `${input.agent}:${ownerID}`
    }

    const attachSpecialAgentFromInfo = Effect.fn("SessionGroup.attachSpecialAgentFromInfo")(function* (
      info: SessionV1.SessionInfo,
    ) {
      if (!info.parentID) return
      const agent = typeof info.metadata?.specialAgent === "string" ? info.metadata.specialAgent : undefined
      if (!agent) return
      const originRef = specialAgentOriginRef({ sessionID: info.id, metadata: info.metadata, agent })
      if (!originRef) return
      const parent = yield* database.db
        .select({ title: SessionTable.title })
        .from(SessionTable)
        .where(eq(SessionTable.id, info.parentID))
        .get()
        .pipe(Effect.orDie)
      yield* attachSpecialAgent({
        sessionID: info.id,
        parentSessionID: info.parentID,
        agent,
        originRef,
        parentTitle: parent?.title,
      })
    })

    const reconcileSubagents = Effect.gen(function* () {
      const candidates = yield* database.db
        .select({ id: SessionTable.id, parent_id: SessionTable.parent_id, title: SessionTable.title })
        .from(SessionTable)
        .where(
          sql`${SessionTable.parent_id} IS NOT NULL
            AND json_extract(${SessionTable.metadata}, '$.specialAgent') IS NULL
            AND NOT EXISTS (
            SELECT 1 FROM ${SessionGroupMemberTable}
            WHERE ${SessionGroupMemberTable.session_id} = ${SessionTable.id}
              AND ${SessionGroupMemberTable.origin} = 'auto_subagent'
          )`,
        )
        .limit(100)
        .all()
        .pipe(Effect.orDie)
      for (const candidate of candidates) {
        if (!candidate.parent_id) continue
        const visited = new Set<string>([candidate.id])
        let anchor = candidate.parent_id
        let depth = 0
        while (depth < 64 && !visited.has(anchor)) {
          visited.add(anchor)
          const parent = yield* database.db
            .select({ id: SessionTable.id, parent_id: SessionTable.parent_id, title: SessionTable.title })
            .from(SessionTable)
            .where(eq(SessionTable.id, anchor))
            .get()
            .pipe(Effect.orDie)
          if (!parent || !parent.parent_id) break
          anchor = parent.parent_id
          depth++
        }
        if (depth >= 64 || visited.has(anchor)) continue
        const root = yield* database.db
          .select({ id: SessionTable.id, title: SessionTable.title })
          .from(SessionTable)
          .where(eq(SessionTable.id, anchor))
          .get()
          .pipe(Effect.orDie)
        if (!root) continue
        const group = yield* resolveOrCreate({
          name: root.title || "Subagents",
          kind: "subagent",
          anchorSessionId: root.id,
          policy: { autoAddDescendants: true, lockAdded: true, autoDeleteWhenEmpty: true },
        })
        yield* addSession({ groupId: group.id, sessionId: root.id, origin: "auto_subagent" })
        yield* addSession({ groupId: group.id, sessionId: candidate.id, locked: true, origin: "auto_subagent" })
      }
    }).pipe(Effect.catchCause((cause) => Effect.logError("failed to reconcile subagent groups", { cause })))

    const reconcileSpecialAgents = Effect.gen(function* () {
      const candidates = yield* database.db
        .select({
          id: SessionTable.id,
          parentID: SessionTable.parent_id,
          metadata: SessionTable.metadata,
        })
        .from(SessionTable)
        .where(
          sql`${SessionTable.parent_id} IS NOT NULL
            AND json_extract(${SessionTable.metadata}, '$.specialAgent') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${SessionGroupMemberTable}
              WHERE ${SessionGroupMemberTable.session_id} = ${SessionTable.id}
                AND ${SessionGroupMemberTable.origin} IN ('goal_auditor', 'special_agent')
            )`,
        )
        .limit(100)
        .all()
        .pipe(Effect.orDie)
      for (const candidate of candidates) {
        if (!candidate.parentID) continue
        const agent = typeof candidate.metadata?.specialAgent === "string" ? candidate.metadata.specialAgent : undefined
        if (!agent) continue
        const originRef = specialAgentOriginRef({ sessionID: candidate.id, metadata: candidate.metadata, agent })
        if (!originRef) continue
        const parent = yield* database.db
          .select({ title: SessionTable.title })
          .from(SessionTable)
          .where(eq(SessionTable.id, candidate.parentID))
          .get()
          .pipe(Effect.orDie)
        yield* attachSpecialAgent({
          sessionID: candidate.id,
          parentSessionID: candidate.parentID,
          agent,
          originRef,
          parentTitle: parent?.title,
        })
      }
    }).pipe(Effect.catchCause((cause) => Effect.logError("failed to reconcile special-agent groups", { cause })))

    const unsubscribeSessionCreated = yield* events.listen((event) =>
      event.type === SessionV1.Event.Created.type
        ? attachSpecialAgentFromInfo((event.data as { info: SessionV1.SessionInfo }).info).pipe(
            Effect.catchCause((cause) => Effect.logError("failed to group special-agent Session", { cause })),
          )
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribeSessionCreated)

    yield* Effect.all([reconcileSubagents, reconcileSpecialAgents], { concurrency: 2 }).pipe(Effect.forkScoped)

    return Service.of({
      list,
      listWithSessions,
      create,
      resolveOrCreate,
      rename,
      remove,
      reorder,
      addSession,
      removeSession,
      detachDeletedSession,
      membershipsFor,
      getWithSessions,
      setPolicy,
      reorderMembers,
      capabilities,
    })
  }),
)

function fromGroupRow(row: typeof SessionGroupTable.$inferSelect): Info {
  return {
    id: SessionGroup.ID.make(row.id),
    name: row.name,
    position: row.position,
    kind: row.kind,
    ownerPlugin: row.owner_plugin ?? undefined,
    ownerRef: row.owner_ref ?? undefined,
    anchorSessionID: row.anchor_session_id ?? undefined,
    policy: row.policy ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      archived: row.time_archived === null ? undefined : DateTime.makeUnsafe(row.time_archived),
    },
  }
}

function fromMemberRow(row: {
  member: typeof SessionGroupMemberTable.$inferSelect
  session: {
    id: string
    slug: string
    projectID: string
    directory: string
    parentID: string | null
    title: string
    version: string
    timeCreated: number
    timeUpdated: number
    timeArchived: number | null
  }
}): Member {
  return {
    id: row.session.id,
    slug: row.session.slug,
    projectID: row.session.projectID,
    directory: row.session.directory,
    parentID: row.session.parentID ?? undefined,
    title: row.session.title,
    version: row.session.version,
    time: {
      created: DateTime.makeUnsafe(row.session.timeCreated),
      updated: DateTime.makeUnsafe(row.session.timeUpdated),
      archived: row.session.timeArchived === null ? undefined : DateTime.makeUnsafe(row.session.timeArchived),
    },
    locked: row.member.locked,
    origin: row.member.origin,
    originPlugin: row.member.origin_plugin ?? undefined,
    originRef: row.member.origin_ref ?? undefined,
    position: row.member.position,
    timeAdded: DateTime.makeUnsafe(row.member.time_added),
  }
}

function requireGroup(database: Database.DatabaseShape, id: ID) {
  return database
    .select()
    .from(SessionGroupTable)
    .where(eq(SessionGroupTable.id, id))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) =>
        row ? Effect.succeed(row) : Effect.fail(new NotFoundError({ message: `Session group not found: ${id}` })),
      ),
    )
}

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, EventV2Bridge.node] })

export * as SessionGroup from "./group"
