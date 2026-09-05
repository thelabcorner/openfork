import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionGroupMemberTable, SessionGroupTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionGroup } from "@opencode-ai/schema/session-group"
import { DateTime } from "effect"
import { and, asc, eq, ne, sql } from "drizzle-orm"
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
        backfill.select().from(SessionGroupTable).orderBy(asc(SessionGroupTable.position)).all()
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
            .orderBy(asc(SessionGroupTable.position))
            .all()
          const memberRows = yield* backfill
            .select({ member: SessionGroupMemberTable, session: { id: SessionTable.id, title: SessionTable.title } })
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
      if (!input.anchorSessionId) return yield* create(input)
      const anchorSessionID = SessionID.make(input.anchorSessionId)
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
      invalidate(input.sessionId)
      yield* events.publish(Event.SessionRemoved, { groupID: input.groupId, sessionID: input.sessionId })
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
          "session-group-assign-hook",
        ],
      }
    })

    const reconcileSubagents = Effect.gen(function* () {
      const candidates = yield* database.db
        .select({ id: SessionTable.id, parent_id: SessionTable.parent_id, title: SessionTable.title })
        .from(SessionTable)
        .where(
          sql`${SessionTable.parent_id} IS NOT NULL AND NOT EXISTS (
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

    yield* reconcileSubagents.pipe(Effect.forkScoped)

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
  session: { id: string; title: string }
}): Member {
  return {
    id: row.session.id,
    title: row.session.title,
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
