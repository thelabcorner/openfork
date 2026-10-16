export * as V1CurrentShadow from "./v1-current-shadow"

import { createHash } from "node:crypto"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { resolveProjectionRef } from "../event"
import { EventSequenceTable } from "../event/sql"
import type { MessageID, SessionV1 } from "../v1/session"
import { V1CurrentBridge } from "./v1-current-bridge"
import { V1CurrentResidue } from "./v1-current-residue"
import type { SessionSchema } from "./schema"
import {
  MessageTable, PartTable, SessionV1ShadowCursorTable, SessionV1ShadowTable,
} from "./sql"

/**
 * Crash-safe, OPT-IN shadow persistence. Never queried by the live prompt
 * runner or timeline and never writes SessionMessageTable / EventTable.
 *
 * All expensive schema/JSON/OPCL conversion occurs before a transaction.
 * The short write transaction rereads and fingerprints the canonical V1
 * message and ALL its parts plus the session event sequence before committing.
 * No stale precomputed candidate is allowed to overwrite a newer shadow.
 *
 * A cursor is background-work bookkeeping, NOT a snapshot, owner lease,
 * migration authorization, or certificate that all historical rows survive.
 */
type DB = Database.Interface["db"]
type Reader = Pick<DB, "select">
type Wire = ReturnType<typeof V1CurrentResidue.toWire>

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

const readSnapshot = Effect.fnUntraced(function* (
  db: Reader, sessionID: SessionSchema.ID, messageID: MessageID,
) {
  const message = yield* db.select().from(MessageTable).where(and(
    eq(MessageTable.id, messageID),
    eq(MessageTable.session_id, sessionID),
  )).get().pipe(Effect.orDie)
  if (!message) return undefined
  // Select by globally unique messageID, NOT (sessionID,messageID). A
  // corrupted cross-session Part.session_id must block migration rather than
  // silently disappearing from a supposedly lossless source projection.
  const parts = yield* db.select().from(PartTable)
    .where(eq(PartTable.message_id, messageID))
    .orderBy(asc(PartTable.id)).all().pipe(Effect.orDie)
  if (parts.some((part) => part.session_id !== sessionID))
    return { blocked: "foreign-part-session" } as const
  const sequence = yield* db.select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, sessionID))
    .get().pipe(Effect.orDie)
  const body = message.data as { role?: string; parentID?: MessageID }
  const parentID = body.role === "assistant" ? body.parentID : undefined
  if (parentID) {
    const parent = yield* db.select({ id: MessageTable.id }).from(MessageTable)
      .where(and(eq(MessageTable.id, parentID), eq(MessageTable.session_id, sessionID)))
      .get().pipe(Effect.orDie)
    if (!parent) return { blocked: "orphan-parent" } as const
  }
  const sourceEventSeq = sequence?.seq ?? 0
  // Compare raw backing columns including OPCL refs and time metadata. No
  // approximate updated_at or count-only test can substitute for this digest:
  // in-place same-ID part replacement, deletion or import must invalidate it.
  const sourceSnapshotHash = sha256(JSON.stringify({
    message: [message.id, message.session_id, message.time_created, message.time_updated, message.data],
    parts: parts.map((p) => [p.id, p.session_id, p.message_id, p.time_created, p.time_updated, p.data]),
  }))
  return { message, parts, sourceEventSeq, sourceSnapshotHash } as const
})

const assemble = Effect.fnUntraced(function* (
  db: Reader, sessionID: SessionSchema.ID,
  snapshot: {
    message: typeof MessageTable.$inferSelect
    parts: (typeof PartTable.$inferSelect)[]
  },
) {
  const message = snapshot.message
  const info = yield* resolveProjectionRef(db, sessionID, "message.data", message.data)
  const parts: SessionV1.Part[] = []
  for (const row of snapshot.parts) {
    const body = yield* resolveProjectionRef(db, sessionID, "part.data", row.data)
    parts.push({
      ...(body && typeof body === "object" ? body : {}),
      id: row.id, messageID: row.message_id, sessionID: row.session_id,
    } as SessionV1.Part)
  }
  return {
    info: {
      ...(info && typeof info === "object" ? info : {}),
      id: message.id, sessionID: message.session_id,
    },
    parts,
  } as SessionV1.WithParts
})

/** Reuse canonical V1 hydration inside a caller-owned SQLite snapshot. It
 * returns no shadow authority and is suitable for event replay comparison. */
export const currentSource = Effect.fn("V1CurrentShadow.currentSource")(function* (
  db: Reader, input: { sessionID: SessionSchema.ID; messageID: MessageID },
) {
  const snapshot = yield* readSnapshot(db, input.sessionID, input.messageID)
  if (!snapshot || "blocked" in snapshot)
    return { status: !snapshot ? "missing" as const : "blocked" as const }
  const source = yield* assemble(db, input.sessionID, snapshot)
  return {
    status: "present" as const,
    source,
    sourceHash: V1CurrentBridge.digest(source),
    eventSeq: snapshot.sourceEventSeq,
  }
})

/** One strictly bounded message projection with transactional source recheck.
 * Concurrent V1 mutations result in 'stale', never a committed stale shadow.
 * Invalid source raises an error and leaves both tables intact. */
export const projectOne = Effect.fn("V1CurrentShadow.projectOne")(function* (
  db: DB, input: {
    sessionID: SessionSchema.ID
    messageID: MessageID
    /** Deterministic test seam for producer races between preflight and CAS. */
    beforeCommit?: () => Effect.Effect<void>
  },
) {
  const before = yield* readSnapshot(db, input.sessionID, input.messageID)
  if (!before) return { status: "missing" as const }
  if ("blocked" in before) return { status: "blocked" as const, reason: before.blocked }
  const source = yield* assemble(db, input.sessionID, before)
  const residue = yield* Effect.sync(() => V1CurrentResidue.lower(source))
  const wire = yield* Effect.sync(() => V1CurrentResidue.toWire(residue))
  const wireHash = sha256(JSON.stringify(wire))
  if (input.beforeCommit) yield* input.beforeCommit()

  return yield* db.transaction((tx) => Effect.gen(function* () {
    const now = yield* readSnapshot(tx, input.sessionID, input.messageID)
    if (!now || "blocked" in now ||
        now.sourceEventSeq !== before.sourceEventSeq ||
        now.sourceSnapshotHash !== before.sourceSnapshotHash)
      return { status: "stale" as const }
    const existing = yield* tx.select().from(SessionV1ShadowTable)
      .where(eq(SessionV1ShadowTable.message_id, input.messageID))
      .get().pipe(Effect.orDie)
    if (existing &&
        existing.source_hash === residue.sourceHash &&
        existing.source_snapshot_hash === before.sourceSnapshotHash &&
        existing.source_event_seq === before.sourceEventSeq &&
        existing.wire_hash === wireHash)
      return { status: "unchanged" as const, sourceHash: residue.sourceHash }
    yield* tx.insert(SessionV1ShadowTable).values({
      message_id: input.messageID, session_id: input.sessionID,
      source_event_seq: before.sourceEventSeq,
      source_hash: residue.sourceHash,
      source_snapshot_hash: before.sourceSnapshotHash,
      wire_hash: wireHash, wire, time_written: Date.now(),
    }).onConflictDoUpdate({
      target: SessionV1ShadowTable.message_id,
      set: {
        session_id: input.sessionID,
        source_event_seq: before.sourceEventSeq,
        source_hash: residue.sourceHash,
        source_snapshot_hash: before.sourceSnapshotHash,
        wire_hash: wireHash, wire, time_written: Date.now(),
      },
    }).run().pipe(Effect.orDie)
    return { status: "written" as const, sourceHash: residue.sourceHash }
  }), { behavior: "immediate" }).pipe(Effect.orDie)
})

/**
 * Restore a shadow only when it is still proven to match CURRENT V1 rows.
 * A valid stored hash alone never establishes freshness (or authoritativeness).
 */
export const readVerified = Effect.fn("V1CurrentShadow.readVerified")(function* (
  db: DB, input: { sessionID: SessionSchema.ID; messageID: MessageID },
) {
  // Pin the same WAL read snapshot through source validation and full
  // rehydration; split independent reads could accept a torn live source.
  // This opt-in verifier never runs in foreground execution/timeline paths.
  return yield* db.transaction((tx) => Effect.gen(function* () {
  const row = yield* tx.select().from(SessionV1ShadowTable)
    .where(and(eq(SessionV1ShadowTable.message_id, input.messageID),
      eq(SessionV1ShadowTable.session_id, input.sessionID)))
    .get().pipe(Effect.orDie)
  if (!row) return { status: "missing" as const }
  if (sha256(JSON.stringify(row.wire)) !== row.wire_hash)
    return { status: "corrupt" as const }
  const now = yield* readSnapshot(tx, input.sessionID, input.messageID)
  if (!now || "blocked" in now || now.sourceSnapshotHash !== row.source_snapshot_hash ||
      now.sourceEventSeq !== row.source_event_seq)
    return { status: "stale" as const }
  // The compact residue is internally verified AND compared with the
  // rehydrated current canonical payload, not just its raw OPCL references.
  const reconstructed = yield* Effect.sync(() =>
    V1CurrentResidue.restore(V1CurrentResidue.fromWire(row.wire as Wire)),
  )
  const source = yield* assemble(tx, input.sessionID, now)
  if (V1CurrentBridge.digest(source) !== row.source_hash ||
      V1CurrentBridge.digest(reconstructed) !== row.source_hash)
    return { status: "stale" as const }
  return {
    status: "verified" as const,
    sourceHash: row.source_hash,
    message: reconstructed,
    cutoverSafe: false as const,
  }
  })).pipe(Effect.orDie)
})

/** Cursor commit is fenced by the aggregate sequence and serializes
 * concurrent scanner progress within the SQLite write transaction. */
const advanceCursor = Effect.fnUntraced(function* (
  db: DB, input: {
    sessionID: SessionSchema.ID
    sourceEventSeq: number
    watermarkRowid: number
    complete: boolean
  },
) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const nowSeq = (yield* tx.select({ seq: EventSequenceTable.seq })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
      .get().pipe(Effect.orDie))?.seq ?? 0
    if (nowSeq !== input.sourceEventSeq) return false
    const previous = yield* tx.select().from(SessionV1ShadowCursorTable)
      .where(eq(SessionV1ShadowCursorTable.session_id, input.sessionID))
      .get().pipe(Effect.orDie)
    // A slower second scanner must never regress an already-committed cursor
    // or clear a terminal complete bit for the same sequence generation.
    const same = previous?.source_event_seq === input.sourceEventSeq
    if (same && previous.watermark_rowid > input.watermarkRowid) return true
    if (same && previous.watermark_rowid === input.watermarkRowid &&
        previous.complete && !input.complete) return true
    const rowid = same
      ? Math.max(previous.watermark_rowid, input.watermarkRowid)
      : input.watermarkRowid
    yield* tx.insert(SessionV1ShadowCursorTable).values({
      session_id: input.sessionID, source_event_seq: input.sourceEventSeq,
      watermark_rowid: rowid, complete: input.complete,
    }).onConflictDoUpdate({
      target: SessionV1ShadowCursorTable.session_id,
      set: {
        source_event_seq: input.sourceEventSeq,
        watermark_rowid: rowid,
        complete: input.complete,
      },
    }).run().pipe(Effect.orDie)
    return true
  }), { behavior: "immediate" }).pipe(Effect.orDie)
})

/**
 * Explicitly invoked bounded historical scan with persisted rowid watermark.
 * Invalid sources halt without moving the cursor. Event-sequence drift resets
 * the scan on the next invocation; all shadow consumers recheck source anyway.
 */
export const scanSlice = Effect.fn("V1CurrentShadow.scanSlice")(function* (
  db: DB, input: { sessionID: SessionSchema.ID; limit?: number },
) {
  const limit = input.limit ?? 4
  if (!Number.isInteger(limit) || limit < 1 || limit > 16)
    return yield* Effect.die(new Error("Shadow scan slice must contain 1–16 messages"))
  const seq = (yield* db.select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, input.sessionID))
    .get().pipe(Effect.orDie))?.seq ?? 0
  const previous = yield* db.select().from(SessionV1ShadowCursorTable)
    .where(eq(SessionV1ShadowCursorTable.session_id, input.sessionID))
    .get().pipe(Effect.orDie)
  const cursor = previous?.source_event_seq === seq ? previous.watermark_rowid : 0
  const rows = yield* db.select({
    id: MessageTable.id, rowid: sql<number>`rowid`,
  }).from(MessageTable)
    .where(and(eq(MessageTable.session_id, input.sessionID), gt(sql<number>`rowid`, cursor)))
    .orderBy(asc(sql<number>`rowid`)).limit(limit + 1).all().pipe(Effect.orDie)
  const batch = rows.slice(0, limit)
  let written = 0
  for (const row of batch) {
    const result = yield* projectOne(db, { sessionID: input.sessionID, messageID: row.id })
    if (result.status !== "written" && result.status !== "unchanged")
      return { complete: false, status: result.status, scanned: written,
        watermarkRowid: cursor, cutoverSafe: false as const }
    if (result.status === "written") written++
    // Watermark only after the shadow row is durable, and only when the
    // canonical sequence still matches the scan's starting revision.
    const updated = yield* advanceCursor(db, {
      sessionID: input.sessionID, sourceEventSeq: seq,
      watermarkRowid: row.rowid, complete: false,
    })
    if (!updated) return { complete: false, status: "stale" as const,
      scanned: written, watermarkRowid: cursor, cutoverSafe: false as const }
  }
  const complete = rows.length <= limit
  if (complete) {
    const updated = yield* advanceCursor(db, {
      sessionID: input.sessionID, sourceEventSeq: seq,
      watermarkRowid: batch.at(-1)?.rowid ?? cursor, complete: true,
    })
    if (!updated) return { complete: false, status: "stale" as const,
      scanned: written, watermarkRowid: cursor, cutoverSafe: false as const }
  }
  return { complete, status: "ok" as const, scanned: batch.length,
    written, watermarkRowid: batch.at(-1)?.rowid ?? cursor,
    cutoverSafe: false as const }
})

/** Execute one explicit bounded slice on the maintenance-only SQLite lane.
 * No implicit startup scan or unbounded polling loop is installed. */
export function scanOnOwnConnection(
  filename: string, input: { sessionID: SessionSchema.ID; limit?: number },
) {
  if (filename === ":memory:")
    return Effect.die(new Error("Shadow background scanning needs a file-backed database"))
  return Database.withBackfillDb(filename, (db) => scanSlice(db, input), {
    busyTimeoutMs: 50, asyncWorker: true,
  })
}
