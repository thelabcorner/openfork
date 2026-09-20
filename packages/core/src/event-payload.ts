import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm"
import type { DatabaseShape } from "./database/database"
import type { SqliteMaintenanceQuietGate } from "./database/sqlite-maintenance"
import { EventPayloadChunkTable, EventPayloadMetaTable } from "./event/sql"

/**
 * Content-addressed jumbo-event representation.
 *
 * This module owns the durable reference shape and its lifecycle-facing decode
 * helpers. Both the foreground Event service and background semantic maintenance
 * consume this authority so a new storage representation cannot be understood by
 * one path while being leaked or skipped by another.
 */
export const EVENT_PAYLOAD_REF = "$eventPayload"
export const EVENT_PAYLOAD_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000
export const EVENT_PAYLOAD_RECLAIM_LIMIT = 8

export type EventPayloadRef = {
  readonly [EVENT_PAYLOAD_REF]: {
    readonly id: string
    readonly count: number
  }
}

export class EventPayloadRehydrateError extends Schema.TaggedErrorClass<EventPayloadRehydrateError>()(
  "EventV2.EventPayloadRehydrateError",
  {
    payloadID: Schema.String,
    reason: Schema.String,
  },
) {}

export function isEventPayloadRef(data: unknown): data is EventPayloadRef {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false
  const record = data as Record<string, unknown>
  if (Object.keys(record).length !== 1) return false
  const ref = record[EVENT_PAYLOAD_REF]
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return false
  const value = ref as Record<string, unknown>
  return typeof value.id === "string" && Number.isSafeInteger(value.count) && Number(value.count) > 0
}

type StoredChunk = {
  readonly payloadID: string
  readonly index: number
  readonly text: string
}

const resolvePayloads = Effect.fnUntraced(function* (
  refs: ReadonlyArray<EventPayloadRef>,
  chunks: ReadonlyArray<StoredChunk>,
) {
  const grouped = Map.groupBy(chunks, (chunk) => chunk.payloadID)
  const resolved = new Map<string, Record<string, unknown>>()
  const uniquePayloads = new Set(refs.map((item) => item[EVENT_PAYLOAD_REF].id)).size
  let resolvedCount = 0
  for (const item of refs) {
    const ref = item[EVENT_PAYLOAD_REF]
    if (resolved.has(ref.id)) continue
    const stored = grouped.get(ref.id) ?? []
    if (stored.length !== ref.count) {
      throw new EventPayloadRehydrateError({
        payloadID: ref.id,
        reason: `expected ${ref.count} chunks, found ${stored.length}`,
      })
    }
    const hash = createHash("sha256")
    const parts: string[] = []
    for (let index = 0; index < stored.length; index++) {
      const chunk = stored[index]!
      if (chunk.index !== index) {
        throw new EventPayloadRehydrateError({
          payloadID: ref.id,
          reason: `expected chunk ${index}, found ${chunk.index}`,
        })
      }
      hash.update(chunk.text, "utf8")
      parts.push(chunk.text)
      if ((index + 1) % 8 === 0 && index + 1 < stored.length) yield* Effect.yieldNow
    }
    if (hash.digest("hex") !== ref.id) {
      throw new EventPayloadRehydrateError({ payloadID: ref.id, reason: "sha256 mismatch" })
    }
    try {
      const value = JSON.parse(parts.join(""))
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("event payload is not an object")
      }
      resolved.set(ref.id, value as Record<string, unknown>)
      resolvedCount += 1
      // Parsing itself remains synchronous and fail-closed, but a batch of
      // independent jumbo values must yield between object constructions.
      if (resolvedCount < uniquePayloads) yield* Effect.yieldNow
    } catch (cause) {
      if (cause instanceof EventPayloadRehydrateError) throw cause
      throw new EventPayloadRehydrateError({ payloadID: ref.id, reason: `invalid JSON: ${String(cause)}` })
    }
  }
  return resolved
})

const loadPayloads = Effect.fnUntraced(function* (db: Pick<DatabaseShape, "select">, refs: ReadonlyArray<EventPayloadRef>) {
  const ids = Array.from(new Set(refs.map((item) => item[EVENT_PAYLOAD_REF].id)))
  if (ids.length === 0) return new Map<string, Record<string, unknown>>()
  const stored = yield* db
    .select({
      payloadID: EventPayloadChunkTable.payload_id,
      index: EventPayloadChunkTable.chunk_index,
      text: EventPayloadChunkTable.text,
    })
    .from(EventPayloadChunkTable)
    .where(inArray(EventPayloadChunkTable.payload_id, ids))
    .orderBy(asc(EventPayloadChunkTable.payload_id), asc(EventPayloadChunkTable.chunk_index))
    .all()
    .pipe(Effect.orDie)
  return yield* resolvePayloads(refs, stored)
})

/** Resolve one staged jumbo reference for a representation-aware maintenance path. */
export const resolveEventPayloadRef = Effect.fnUntraced(function* (
  db: Pick<DatabaseShape, "select">,
  ref: EventPayloadRef,
) {
  const resolved = yield* loadPayloads(db, [ref])
  const payloadID = ref[EVENT_PAYLOAD_REF].id
  const value = resolved.get(payloadID)
  if (!value) throw new EventPayloadRehydrateError({ payloadID, reason: "payload did not resolve" })
  return value
})

/** Batch rehydrate staged jumbo refs with one chunk lookup for normal event reads. */
export const rehydrateStagedEventPayloads = Effect.fnUntraced(function* <
  R extends { readonly data: Record<string, unknown> },
>(db: Pick<DatabaseShape, "select">, rows: ReadonlyArray<R>) {
  const refs: EventPayloadRef[] = []
  for (const row of rows) if (isEventPayloadRef(row.data)) refs.push(row.data)
  if (refs.length === 0) return rows
  const resolved = yield* loadPayloads(db, refs)
  return rows.map((row) => {
    if (!isEventPayloadRef(row.data)) return row
    const value = resolved.get(row.data[EVENT_PAYLOAD_REF].id)
    if (!value) return row
    return { ...row, data: value }
  }) as R[]
})

export type EventPayloadRefCount = {
  readonly payloadID: string
  readonly count: number
}

/**
 * Decrement committed ownership without deleting chunk bodies under the caller's
 * write transaction. Physical orphan reclamation remains age-gated and bounded.
 */
export const decrementEventPayloadRefs = Effect.fnUntraced(function* (
  db: Pick<DatabaseShape, "all">,
  refs: ReadonlyArray<EventPayloadRefCount>,
) {
  const grouped = new Map<string, number>()
  for (const ref of refs) {
    if (ref.count <= 0) continue
    grouped.set(ref.payloadID, (grouped.get(ref.payloadID) ?? 0) + ref.count)
  }
  if (grouped.size === 0) return
  const valid = Array.from(grouped, ([payloadID, count]) => ({ payloadID, count }))
  const rows = sql.join(valid.map((ref) => sql`(${ref.payloadID}, ${ref.count})`), sql`, `)
  const changed = yield* db.all<{ payloadID: string }>(sql`
    WITH removed(payload_id, ref_count) AS (VALUES ${rows}),
         valid_owners AS (
           SELECT count(*) AS count
           FROM removed
           JOIN event_payload_meta meta ON meta.payload_id = removed.payload_id
           WHERE meta.refs >= removed.ref_count
         )
    UPDATE event_payload_meta
    SET refs = refs - (
          SELECT ref_count
          FROM removed
          WHERE removed.payload_id = event_payload_meta.payload_id
        ),
        time_touched = ${Date.now()}
    WHERE payload_id IN (SELECT payload_id FROM removed)
      AND (SELECT count FROM valid_owners) = ${valid.length}
    RETURNING payload_id AS payloadID
  `).pipe(Effect.orDie)
  if (changed.length !== valid.length) {
    throw new EventPayloadRehydrateError({
      payloadID: valid.map((ref) => ref.payloadID).join(","),
      reason: "event payload refcount decrement would underflow or references missing lifecycle metadata",
    })
  }
})

/**
 * Reclaim durable chunk bodies whose committed ownership has remained at zero
 * beyond the staging grace window.
 *
 * Candidate discovery is indexed and bounded. Every candidate is revalidated
 * under IMMEDIATE writer ownership before deletion, so a concurrent stager that
 * refreshes its lifecycle timestamp or a semantic event that claims a ref wins
 * safely. Chunk deletion and lifecycle-row deletion are one transaction per
 * payload, keeping unrelated payloads out of the same writer hold.
 */
export const reclaimOrphanedEventPayloads = Effect.fnUntraced(function* (
  db: DatabaseShape,
  options?: {
    readonly now?: number
    readonly limit?: number
    readonly quietGate?: SqliteMaintenanceQuietGate
  },
) {
  const now = options?.now ?? Date.now()
  const cutoff = now - EVENT_PAYLOAD_ORPHAN_GRACE_MS
  const limit = Math.max(1, Math.min(128, options?.limit ?? EVENT_PAYLOAD_RECLAIM_LIMIT))
  const candidates = yield* db
    .select({ payloadID: EventPayloadMetaTable.payload_id })
    .from(EventPayloadMetaTable)
    .where(and(eq(EventPayloadMetaTable.refs, 0), lt(EventPayloadMetaTable.time_touched, cutoff)))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)

  let reclaimed = 0
  for (const candidate of candidates.slice(0, limit)) {
    if (options?.quietGate) yield* options.quietGate.wait()
    const deleted = yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const meta = yield* tx
              .select({ refs: EventPayloadMetaTable.refs, touched: EventPayloadMetaTable.time_touched })
              .from(EventPayloadMetaTable)
              .where(eq(EventPayloadMetaTable.payload_id, candidate.payloadID))
              .get()
              .pipe(Effect.orDie)
            if (!meta || meta.refs !== 0 || meta.touched >= cutoff) return false
            yield* tx
              .delete(EventPayloadChunkTable)
              .where(eq(EventPayloadChunkTable.payload_id, candidate.payloadID))
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .delete(EventPayloadMetaTable)
              .where(eq(EventPayloadMetaTable.payload_id, candidate.payloadID))
              .run()
              .pipe(Effect.orDie)
            return true
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
    if (deleted) reclaimed += 1
  }
  return { reclaimed, hasMore: candidates.length > limit }
})

/**
 * Increment committed ownership without a read/modify/write race.
 *
 * Staging publishes the zero-ref lifecycle row before the semantic event exists;
 * the event commit then claims one durable reference atomically in the same
 * writer transaction as the event row. A missing lifecycle row is corruption /
 * concurrent cleanup and must fail closed rather than silently publishing a
 * reference whose chunks have no owner.
 */
export const incrementEventPayloadRef = Effect.fnUntraced(function* (
  db: Pick<DatabaseShape, "get">,
  payloadID: string,
  touched = Date.now(),
) {
  const result = yield* db.get<{ refs: number }>(sql`
    UPDATE event_payload_meta
    SET refs = refs + 1,
        time_touched = ${touched}
    WHERE payload_id = ${payloadID}
    RETURNING refs
  `).pipe(Effect.orDie)
  if (result === undefined) {
    throw new EventPayloadRehydrateError({
      payloadID,
      reason: "staged payload metadata disappeared before event commit",
    })
  }
})
