export * as SessionRecoveryTurn from "./recovery-turn"

import { and, desc, eq, gte, isNull, lt, or } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionV1 } from "../v1/session"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import {
  MessageTable,
  SessionMessageLifecycleTable,
  SessionMessageTable,
} from "./sql"

type Reader = Pick<Database.Interface["db"], "select">

/**
 * This is a recovery-only, bounded proof path, never a sidebar/list query.
 * One physical execution generation can encompass several provider steps and
 * several assistant messages. Only rows created *after that generation was
 * acquired* may be settled. No time-based guess authorizes a tool replay.
 *
 * An ambiguous/corrupt/opaque V1 row, a missing acquisition timestamp or an
 * unusually large candidate set leaves durable execution fenced for operator
 * review instead of silently abandoning an unknown message.
 */
export const RECOVERY_SCAN_PAGE_SIZE = 32
export const MAX_GENERATION_MESSAGES_TO_REPAIR = 512

export type SealResult =
  | { readonly state: "sealed"; readonly v1: number; readonly current: number }
  | { readonly state: "unverifiable"; readonly reason: string }

export const sealInterruptedGeneration = Effect.fn("SessionRecoveryTurn.sealInterruptedGeneration")(function* (
  db: Reader,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  acquiredAt: number | undefined,
) {
  if (acquiredAt === undefined || !Number.isSafeInteger(acquiredAt) || acquiredAt < 0) {
    // Historical owner rows may predate acquired_at. Such a row is still safe
    // to retire when there is literally NO transcript to seal. This must be
    // proved from both owners, not inferred from the absence of tool effects.
    const [v1, current] = yield* Effect.all([
      db.select({ id: MessageTable.id }).from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID)).limit(1).get(),
      db.select({ id: SessionMessageTable.id }).from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID)).limit(1).get(),
    ]).pipe(Effect.orDie)
    if (!v1 && !current) return { state: "sealed", v1: 0, current: 0 }
    return { state: "unverifiable", reason: "execution acquisition timestamp unavailable" }
  }

  // These columns are covered by the existing session/type/seq and
  // session/time-created indexes. Do not read canonical V2 content or decode
  // costly OPCL references just to establish settled step identities.
  const current: Array<{
    id: typeof SessionMessageTable.$inferSelect.id
    created: number
  }> = []
  let currentSeqCursor: number | undefined
  for (;;) {
    const page = yield* db
      .select({
        id: SessionMessageTable.id, seq: SessionMessageTable.seq,
        created: SessionMessageTable.time_created,
      })
      .from(SessionMessageTable)
      .leftJoin(
        SessionMessageLifecycleTable,
        eq(SessionMessageLifecycleTable.message_id, SessionMessageTable.id),
      )
      .where(and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gte(SessionMessageTable.time_created, acquiredAt),
        isNull(SessionMessageLifecycleTable.settlement),
        currentSeqCursor === undefined ? undefined : lt(SessionMessageTable.seq, currentSeqCursor),
      ))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(RECOVERY_SCAN_PAGE_SIZE)
      .all().pipe(Effect.orDie)
    current.push(...page)
    if (current.length > MAX_GENERATION_MESSAGES_TO_REPAIR)
      return { state: "unverifiable", reason: "too many unfinished current assistant steps" }
    if (page.length < RECOVERY_SCAN_PAGE_SIZE) break
    currentSeqCursor = page.at(-1)!.seq
    yield* Effect.yieldNow
  }

  // V1 is the production runtime. Its historic message rows have no
  // generation_id scalar. The durable owner-acquired timestamp bounds the
  // smallest safe candidate set; inspect only rows within that generation,
  // and refuse to release ownership if any such row cannot be decoded.
  const decodeAssistant = Schema.decodeUnknownOption(SessionV1.Assistant)
  const pending: SessionV1.Assistant[] = []
  let legacyScanned = 0
  let legacyCursor: { created: number; id: typeof MessageTable.$inferSelect.id } | undefined
  for (;;) {
    // Seek rather than OFFSET keeps a long interrupted worker's scan bounded
    // by one small indexed page at a time even on multi-GiB histories.
    const page = yield* db
      .select({
        id: MessageTable.id, data: MessageTable.data, sessionID: MessageTable.session_id,
        created: MessageTable.time_created,
      })
      .from(MessageTable)
      .where(and(
        eq(MessageTable.session_id, sessionID),
        gte(MessageTable.time_created, acquiredAt),
        legacyCursor === undefined ? undefined : or(
          lt(MessageTable.time_created, legacyCursor.created),
          and(eq(MessageTable.time_created, legacyCursor.created), lt(MessageTable.id, legacyCursor.id)),
        ),
      ))
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(RECOVERY_SCAN_PAGE_SIZE)
      .all().pipe(Effect.orDie)
    legacyScanned += page.length
    if (legacyScanned > MAX_GENERATION_MESSAGES_TO_REPAIR)
      return { state: "unverifiable", reason: "too many V1 messages in interrupted generation" }
    for (const row of page) {
      if (!row.data || typeof row.data !== "object")
        return { state: "unverifiable", reason: "opaque or invalid V1 message payload" }
      if (row.data.role !== "assistant" && row.data.role !== "user")
        return { state: "unverifiable", reason: "opaque or unknown V1 message role" }
      if (row.data.role === "user") continue
      const decoded = decodeAssistant({ ...row.data, id: row.id, sessionID: row.sessionID })
      if (Option.isNone(decoded))
        return { state: "unverifiable", reason: "unreadable V1 assistant state" }
      if (decoded.value.time.completed !== undefined) continue
      pending.push(structuredClone(decoded.value) as SessionV1.Assistant)
    }
    if (page.length < RECOVERY_SCAN_PAGE_SIZE) break
    legacyCursor = { created: page.at(-1)!.created, id: page.at(-1)!.id }
    yield* Effect.yieldNow
  }

  // NTP corrections and restored snapshots can put wall-clock now *before*
  // the originally recorded request time. A recovery settlement can never
  // precede its own assistant creation timestamp in either projection.
  const wallClock = DateTime.toEpochMillis(yield* DateTime.now)
  const completed = Math.max(wallClock, acquiredAt,
    ...current.map((entry) => entry.created),
    ...pending.map((info) => info.time.created),
  )
  const now = DateTime.makeUnsafe(completed)
  for (const item of current) {
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID,
      assistantMessageID: item.id,
      timestamp: now,
      error: { type: "unknown", message: "Assistant generation interrupted by executor termination" },
    })
  }
  for (const info of pending) {
    info.time.completed = completed
    info.error ??= {
      name: "MessageAbortedError",
      data: { message: "Assistant generation interrupted by executor termination" },
    }
    yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info })
  }
  return { state: "sealed", current: current.length, v1: pending.length }
})
