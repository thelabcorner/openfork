import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionGroupTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionGroup } from "@opencode-ai/schema/session-group"
import { SessionID } from "@/session/schema"
import { define } from "@opencode-ai/schema/event"
import { DateTime } from "effect"
import { eq, asc, sql } from "drizzle-orm"
import { Effect, Layer, Context, Schema, Types } from "effect"
import { NotFoundError } from "@/storage/storage"

export const ID = SessionGroup.ID
export type ID = Schema.Schema.Type<typeof ID>

export const Info = SessionGroup.Info
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Event = {
  Created: define({
    type: "session_group.created",
    schema: {
      groupID: SessionGroup.ID,
      info: Info,
    },
  }),
  Updated: define({
    type: "session_group.updated",
    schema: {
      groupID: SessionGroup.ID,
      info: Info,
    },
  }),
  Deleted: define({
    type: "session_group.deleted",
    schema: {
      groupID: SessionGroup.ID,
    },
  }),
  SessionAdded: define({
    type: "session_group.session.added",
    schema: {
      groupID: SessionGroup.ID,
      sessionID: Schema.String,
    },
  }),
  SessionRemoved: define({
    type: "session_group.session.removed",
    schema: {
      groupID: SessionGroup.ID,
      sessionID: Schema.String,
    },
  }),
}

function fromRow(row: typeof SessionGroupTable.$inferSelect): Info {
  return {
    id: SessionGroup.ID.make(row.id),
    name: row.name,
    position: row.position,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
    },
  }
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly listWithSessions: () => Effect.Effect<Array<{ group: Info; sessions: Array<{ id: string; title: string }> }>>
  readonly create: (input: { name: string }) => Effect.Effect<Info>
  readonly rename: (input: { id: ID; name: string }) => Effect.Effect<void, NotFoundError>
  readonly remove: (id: ID) => Effect.Effect<void, NotFoundError>
  readonly reorder: (input: { id: ID; position: number }) => Effect.Effect<void, NotFoundError>
  readonly addSession: (input: { groupId: ID; sessionId: string }) => Effect.Effect<void, NotFoundError>
  readonly removeSession: (input: { groupId: ID; sessionId: string }) => Effect.Effect<void, NotFoundError>
  readonly getWithSessions: (
    id: ID,
  ) => Effect.Effect<{ group: Info; sessions: Array<{ id: string; title: string }> }, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGroup") {}

const layer: Layer.Layer<Service, never, Database.Service | EventV2Bridge.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service

    const list = Effect.fn("SessionGroup.list")(function* () {
      const rows = yield* db
        .select()
        .from(SessionGroupTable)
        .orderBy(asc(SessionGroupTable.position))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    // Batched variant of `getWithSessions` for clients that need every group's
    // membership: two total queries (groups + memberships bucketed in memory)
    // instead of one round-trip per group.
    const listWithSessions = Effect.fn("SessionGroup.listWithSessions")(function* () {
      const rows = yield* db
        .select()
        .from(SessionGroupTable)
        .orderBy(asc(SessionGroupTable.position))
        .all()
        .pipe(Effect.orDie)
      const memberships = yield* db
        .select({ id: SessionTable.id, title: SessionTable.title, group_id: SessionTable.group_id })
        .from(SessionTable)
        .where(sql`"group_id" IS NOT NULL`)
        .all()
        .pipe(Effect.orDie)
      const byGroup = new Map<string, Array<{ id: string; title: string }>>()
      for (const row of memberships) {
        if (!row.group_id) continue
        const bucket = byGroup.get(row.group_id)
        if (bucket) bucket.push({ id: row.id, title: row.title })
        else byGroup.set(row.group_id, [{ id: row.id, title: row.title }])
      }
      return rows.map((row) => ({ group: fromRow(row), sessions: byGroup.get(row.id) ?? [] }))
    })

    const create = Effect.fn("SessionGroup.create")(function* (input: { name: string }) {
      const id = SessionGroup.ID.create()
      const now = Date.now()
      const row = {
        id,
        name: input.name,
        position: now,
        time_created: now,
        time_updated: now,
      }
      yield* db.insert(SessionGroupTable).values(row).run().pipe(Effect.orDie)
      const info = fromRow(row)
      yield* events.publish(Event.Created, { groupID: id, info })
      return info
    })

    const rename = Effect.fn("SessionGroup.rename")(function* (input: { id: ID; name: string }) {
      const row = yield* db
        .select()
        .from(SessionGroupTable)
        .where(eq(SessionGroupTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session group not found: ${input.id}` }))
      const now = Date.now()
      yield* db
        .update(SessionGroupTable)
        .set({ name: input.name, time_updated: now })
        .where(eq(SessionGroupTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
      const info = fromRow({ ...row, name: input.name, time_updated: now })
      yield* events.publish(Event.Updated, { groupID: input.id, info })
    })

    const remove = Effect.fn("SessionGroup.remove")(function* (id: ID) {
      const row = yield* db
        .select()
        .from(SessionGroupTable)
        .where(eq(SessionGroupTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session group not found: ${id}` }))
      yield* db
        .update(SessionTable)
        .set({ group_id: null })
        .where(sql`"group_id" = ${id}`)
        .run()
        .pipe(Effect.orDie)
      yield* db.delete(SessionGroupTable).where(eq(SessionGroupTable.id, id)).run().pipe(Effect.orDie)
      yield* events.publish(Event.Deleted, { groupID: id })
    })

    const reorder = Effect.fn("SessionGroup.reorder")(function* (input: { id: ID; position: number }) {
      const row = yield* db
        .select()
        .from(SessionGroupTable)
        .where(eq(SessionGroupTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session group not found: ${input.id}` }))
      const now = Date.now()
      yield* db
        .update(SessionGroupTable)
        .set({ position: input.position, time_updated: now })
        .where(eq(SessionGroupTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
      const info = fromRow({ ...row, position: input.position, time_updated: now })
      yield* events.publish(Event.Updated, { groupID: input.id, info })
    })

    const addSession = Effect.fn("SessionGroup.addSession")(function* (input: { groupId: ID; sessionId: string }) {
      const group = yield* db
        .select()
        .from(SessionGroupTable)
        .where(eq(SessionGroupTable.id, input.groupId))
        .get()
        .pipe(Effect.orDie)
      if (!group) return yield* Effect.fail(new NotFoundError({ message: `Session group not found: ${input.groupId}` }))
      const now = Date.now()
      yield* db
        .update(SessionTable)
        .set({ group_id: input.groupId, time_updated: now })
        .where(sql`"id" = ${input.sessionId}`)
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(Event.SessionAdded, { groupID: input.groupId, sessionID: input.sessionId })
    })

    const removeSession = Effect.fn("SessionGroup.removeSession")(function* (input: {
      groupId: ID
      sessionId: string
    }) {
      const group = yield* db
        .select()
        .from(SessionGroupTable)
        .where(eq(SessionGroupTable.id, input.groupId))
        .get()
        .pipe(Effect.orDie)
      if (!group) return yield* Effect.fail(new NotFoundError({ message: `Session group not found: ${input.groupId}` }))
      const now = Date.now()
      yield* db
        .update(SessionTable)
        .set({ group_id: null, time_updated: now })
        .where(sql`"id" = ${input.sessionId}`)
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(Event.SessionRemoved, { groupID: input.groupId, sessionID: input.sessionId })
    })

    const getWithSessions = Effect.fn("SessionGroup.getWithSessions")(function* (id: ID) {
      const row = yield* db
        .select()
        .from(SessionGroupTable)
        .where(eq(SessionGroupTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session group not found: ${id}` }))
      const sessions = yield* db
        .select({ id: SessionTable.id, title: SessionTable.title })
        .from(SessionTable)
        .where(sql`"group_id" = ${id}`)
        .all()
        .pipe(Effect.orDie)
      return { group: fromRow(row), sessions }
    })

    return Service.of({
      list,
      listWithSessions,
      create,
      rename,
      remove,
      reorder,
      addSession,
      removeSession,
      getWithSessions,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node, EventV2Bridge.node],
})

export * as SessionGroup from "./group"
