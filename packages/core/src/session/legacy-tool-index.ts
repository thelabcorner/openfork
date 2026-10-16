export * as SessionLegacyToolIndex from "./legacy-tool-index"

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { resolveProjectionRef } from "../event"
import type { Database } from "../database/database"
import type { MessageID, PartID } from "../v1/session"
import type { SessionSchema } from "./schema"
import { legacyPartKind, unsettledLegacyToolPredicate } from "./legacy-part-query"
import { PartTable, SessionV1ToolCallBackfillTable, SessionV1ToolCallTable } from "./sql"

export const VERSION = 1
// Certifying an enormous non-tool row rewrites its entire SQLite table
// record (including JSON), even though it can never produce a tool call.
// Leave such rows on the conservative historical fallback instead.
export const MAX_NON_TOOL_REWRITE_BYTES = 16 * 1024
const PENDING = ["pending", "running"] as const
type DB = Database.Interface["db"]
type Reader = Pick<DB, "select">
type Writer = Pick<DB, "insert" | "delete">
type PartFacts = {
  readonly id: PartID
  readonly sessionID: SessionSchema.ID
  readonly messageID: MessageID
  readonly type: string
  readonly callID?: string
  readonly state?: { readonly status: string }
}

/**
 * Maintained in the SAME durable event transaction as the V1 part projector.
 * The part marker certifies both positive tool identities and negative
 * non-tool facts, so a missing sidecar row is not enough to prove absence.
 */
export function project(db: Writer, part: PartFacts, previousWasTool = false) {
  if (part.type !== "tool") {
    if (!previousWasTool) return Effect.void
    return db.delete(SessionV1ToolCallTable)
      .where(eq(SessionV1ToolCallTable.part_id, part.id))
      .run().pipe(Effect.asVoid)
  }
  if (!part.callID || !part.state) return Effect.die(new Error("Cannot certify a tool part without call identity and state"))
  const status = part.state.status
  return db.insert(SessionV1ToolCallTable)
    .values({
      part_id: part.id,
      message_id: part.messageID,
      session_id: part.sessionID,
      call_id: part.callID,
      status,
    })
    .onConflictDoUpdate({
      target: SessionV1ToolCallTable.part_id,
      set: {
        message_id: part.messageID,
        session_id: part.sessionID,
        call_id: part.callID,
        status,
      },
      setWhere: sql`
        ${SessionV1ToolCallTable.message_id} <> ${part.messageID}
        OR ${SessionV1ToolCallTable.session_id} <> ${part.sessionID}
        OR ${SessionV1ToolCallTable.call_id} <> ${part.callID}
        OR ${SessionV1ToolCallTable.status} <> ${status}
      `,
    }).run().pipe(Effect.asVoid)
}

/**
 * Check exact tool-call identity without materializing any part JSON for
 * producer-certified parts. Legacy version-0 rows must still use JSON:
 * coverage is per-part, not an unsound global "sidecar has some rows" test.
 */
export const exists = Effect.fn("SessionLegacyToolIndex.exists")(function* (
  db: Reader,
  input: { sessionID: SessionSchema.ID; messageID?: MessageID; callID: string; unsettled?: boolean },
) {
  const indexed = yield* db.select({ id: SessionV1ToolCallTable.part_id })
    .from(SessionV1ToolCallTable)
    .where(and(
      eq(SessionV1ToolCallTable.session_id, input.sessionID),
      input.messageID ? eq(SessionV1ToolCallTable.message_id, input.messageID) : undefined,
      eq(SessionV1ToolCallTable.call_id, input.callID),
      input.unsettled ? inArray(SessionV1ToolCallTable.status, PENDING) : undefined,
    )).limit(1).get().pipe(Effect.orDie)
  if (indexed) return true
  const legacy = yield* db.select({ id: PartTable.id }).from(PartTable)
    .where(and(
      eq(PartTable.session_id, input.sessionID),
      input.messageID ? eq(PartTable.message_id, input.messageID) : undefined,
      eq(PartTable.tool_identity_version, 0),
      // SQLite is allowed to reorder independent AND predicates. CASE makes
      // callID JSON extraction explicitly conditional on confirmed tool kind:
      // large/corrupt certified non-tool rows cannot be deserialized by an
      // exact-call lookup, even when they remain unindexed by rewrite policy.
      sql`CASE WHEN ${legacyPartKind} = 'tool'
        THEN json_extract(${PartTable.data}, '$.callID') = ${input.callID}
        ELSE 0 END`,
      input.unsettled ? unsettledLegacyToolPredicate : undefined,
    )).limit(1).get().pipe(Effect.orDie)
  return !!legacy
})

/** Safety-critical negative proof: both indexed and unindexed generations. */
export const hasUnsettled = Effect.fn("SessionLegacyToolIndex.hasUnsettled")(function* (
  db: Reader, sessionID: SessionSchema.ID,
) {
  const indexed = yield* db.select({ id: SessionV1ToolCallTable.part_id })
    .from(SessionV1ToolCallTable)
    .where(and(
      eq(SessionV1ToolCallTable.session_id, sessionID),
      inArray(SessionV1ToolCallTable.status, PENDING),
    )).limit(1).get().pipe(Effect.orDie)
  if (indexed) return true
  const legacy = yield* db.select({ id: PartTable.id })
    .from(PartTable)
    .where(and(
      eq(PartTable.session_id, sessionID),
      eq(PartTable.tool_identity_version, 0),
      unsettledLegacyToolPredicate,
    )).limit(1).get().pipe(Effect.orDie)
  return !!legacy
})

/** Bounded startup sweep: union two independently indexed/fallback sources. */
export const unsettledSessions = Effect.fn("SessionLegacyToolIndex.unsettledSessions")(function* (
  db: Reader, sessionIDs: readonly SessionSchema.ID[],
) {
  const found = new Set<string>()
  if (sessionIDs.length === 0) return found
  const indexed = yield* db.select({ sessionID: SessionV1ToolCallTable.session_id })
    .from(SessionV1ToolCallTable)
    .where(and(
      inArray(SessionV1ToolCallTable.session_id, sessionIDs),
      inArray(SessionV1ToolCallTable.status, PENDING),
    )).groupBy(SessionV1ToolCallTable.session_id).all().pipe(Effect.orDie)
  for (const row of indexed) found.add(row.sessionID)
  const old = yield* db.select({ sessionID: PartTable.session_id })
    .from(PartTable)
    .where(and(
      inArray(PartTable.session_id, sessionIDs),
      eq(PartTable.tool_identity_version, 0),
      unsettledLegacyToolPredicate,
    )).groupBy(PartTable.session_id).all().pipe(Effect.orDie)
  for (const row of old) found.add(row.sessionID)
  return found
})

/** Retrieve exact repair candidates; payload materialization happens ONLY after
 * selecting verified pending calls. Historical unknown rows stay eligible. */
export const unsettledParts = Effect.fn("SessionLegacyToolIndex.unsettledParts")(function* (
  db: Reader, sessionID: SessionSchema.ID,
) {
  const indexed = yield* db.select({
    id: PartTable.id, messageID: PartTable.message_id,
    sessionID: PartTable.session_id, data: PartTable.data,
  }).from(SessionV1ToolCallTable)
    .innerJoin(PartTable, eq(SessionV1ToolCallTable.part_id, PartTable.id))
    .where(and(
      eq(SessionV1ToolCallTable.session_id, sessionID),
      inArray(SessionV1ToolCallTable.status, PENDING),
    )).all().pipe(Effect.orDie)
  const old = yield* db.select({
    id: PartTable.id, messageID: PartTable.message_id,
    sessionID: PartTable.session_id, data: PartTable.data,
  }).from(PartTable)
    .where(and(
      eq(PartTable.session_id, sessionID),
      eq(PartTable.tool_identity_version, 0),
      unsettledLegacyToolPredicate,
    )).all().pipe(Effect.orDie)
  return [...indexed, ...old]
})

/**
 * Resumable, bounded historical repair on the dedicated background maintenance
 * connection. An old part is never marked indexed until its exact identity is
 * inserted in the same SQLite transaction. The data equality predicate is a
 * CAS fence against an in-flight PartUpdated from another process.
 *
 * A malformed/opaque-unresolvable historical tool must STOP the pass, leaving
 * the watermark and version-0 read fallback intact, never falsely certifying
 * the absence of an unsettled effect.
 */
export const repairChunk = Effect.fn("SessionLegacyToolIndex.repairChunk")(function* (
  db: DB, requested = 128,
) {
  const limit = Math.max(1, Math.min(128, Math.floor(requested)))
  const state = yield* db.select().from(SessionV1ToolCallBackfillTable)
    .where(eq(SessionV1ToolCallBackfillTable.id, 1)).get().pipe(Effect.orDie)
  if (state?.done === 1) return { scanned: 0, indexed: 0, done: true } as const
  const watermark = state?.watermark_rowid ?? 0
  if (!state) {
    yield* db.insert(SessionV1ToolCallBackfillTable)
      .values({ id: 1, watermark_rowid: 0, done: 0 })
      .onConflictDoNothing().run().pipe(Effect.orDie)
  }
  const rows = yield* db.select({
    id: PartTable.id,
    messageID: PartTable.message_id,
    sessionID: PartTable.session_id,
    rowid: sql<number>`rowid`,
    version: PartTable.tool_identity_version,
    contextVersion: PartTable.context_projection_version,
    kind: PartTable.context_kind,
    payloadBytes: sql<number>`length(CAST(${PartTable.data} AS BLOB))`,
  }).from(PartTable)
    .where(gt(sql<number>`rowid`, watermark))
    .orderBy(asc(sql<number>`rowid`)).limit(limit).all().pipe(Effect.orDie)
  let indexed = 0
  for (const row of rows) {
    if (row.version === VERSION) continue
    // Certified non-tool parts do not need content or JSON materialization.
    const certifiedNonTool = row.contextVersion === 1 && typeof row.kind === "string" && row.kind !== "tool"
    const raw = certifiedNonTool ? undefined : yield* db.select({
      data: PartTable.data,
    }).from(PartTable).where(eq(PartTable.id, row.id)).get().pipe(Effect.orDie)
    if (!certifiedNonTool && !raw)
      continue // The row disappeared; a replay does not resurrect it.
    const source = certifiedNonTool ? undefined
      : yield* resolveProjectionRef(db, row.sessionID, "part.data", raw!.data)
    const record = source && typeof source === "object" && !Array.isArray(source)
      ? source as Record<string, unknown> : undefined
    if (!certifiedNonTool && !record) return yield* Effect.die(
      new Error(`Cannot verify historical part identity at rowid ${row.rowid}`),
    )
    const tool = !certifiedNonTool && record!.type === "tool"
    const state = tool && record!.state && typeof record!.state === "object"
      ? record!.state as Record<string, unknown> : undefined
    if (tool && (typeof record!.callID !== "string" || !state ||
      !["pending", "running", "completed", "error"].includes(String(state.status)))) {
      return yield* Effect.die(new Error(`Invalid historical tool identity at rowid ${row.rowid}`))
    }
    // A source that cannot be identified as tool vs non-tool is not verified.
    if (!certifiedNonTool && typeof record!.type !== "string")
      return yield* Effect.die(new Error(`Unknown historical part type at rowid ${row.rowid}`))
    if (!tool && row.payloadBytes > MAX_NON_TOOL_REWRITE_BYTES) {
      // The backfill cursor records that this historical row was inspected,
      // not that every row can bypass fallback forever. Keeping version 0 is
      // essential: it still participates in conservative negative proofs.
      continue
    }

    const claimed = yield* db.transaction((tx) => Effect.gen(function* () {
      const updated = yield* tx.update(PartTable)
        .set({ tool_identity_version: VERSION })
        .where(and(
          eq(PartTable.id, row.id),
          eq(PartTable.tool_identity_version, 0),
          // If the source was changed since the cold read, never certify a
          // different state/callID. This includes same-ID tool replacements.
          raw ? eq(PartTable.data, raw.data) : eq(PartTable.context_kind, row.kind!),
          eq(PartTable.context_projection_version, row.contextVersion),
        )).returning({ id: PartTable.id }).get().pipe(Effect.orDie)
      if (!updated) return false
      if (tool) yield* project(tx, {
        id: row.id, sessionID: row.sessionID, messageID: row.messageID,
        type: "tool", callID: record!.callID as string,
        state: { status: state!.status as string },
      }).pipe(Effect.orDie)
      return true
    })).pipe(Effect.orDie)
    if (claimed) indexed++
  }
  const last = rows.at(-1)?.rowid ?? watermark
  const done = rows.length < limit
  yield* db.update(SessionV1ToolCallBackfillTable)
    .set({ watermark_rowid: last, done: done ? 1 : 0 })
    .where(eq(SessionV1ToolCallBackfillTable.id, 1)).run().pipe(Effect.orDie)
  return { scanned: rows.length, indexed, done } as const
})