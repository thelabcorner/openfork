export * as SessionLimitRecovery from "./limit-recovery"

import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { createHash } from "node:crypto"
import { SessionLimitRecovery as Contract } from "@opencode-ai/schema/session-limit-recovery"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Database } from "../database/database"
import { SessionLimitRecoveryEpochTable, SessionLimitRecoveryTable } from "./limit-recovery.sql"
import { SessionSchema } from "./schema"

type DB = Database.Interface["db"]
type Row = typeof SessionLimitRecoveryTable.$inferSelect

export type Failure = {
  readonly sessionID: SessionSchema.ID
  readonly sourceAssistantMessageID: string
  readonly sourceUserMessageID?: string
  readonly providerID: string
  readonly accountID?: string
  readonly modelID: string
  readonly failureClass: Contract.FailureClass
  readonly failureCode?: string
  readonly resetAt?: number
  readonly resetSource?: Contract.ResetSource
  readonly resetObservedAt?: number
  readonly expectedLatestUserSeq?: number
  readonly autoResume?: boolean
  readonly snoozeUntilReset?: boolean
  readonly now?: number
}

export type Info = Contract.Info

const TRUSTED_RESET_SOURCES: Contract.ResetSource[] = ["retry-after", "provider"]
const trustedReset = (source: Contract.ResetSource | undefined) =>
  source !== undefined && TRUSTED_RESET_SOURCES.includes(source)

const futureReset = (resetAt: number | undefined, now: number) => resetAt !== undefined && resetAt > now

function makeContinuationID(
  sessionID: SessionSchema.ID,
  sourceAssistantMessageID: string,
  resetAt: number | undefined,
  generation: number,
) {
  return `msg_limit_recovery_${createHash("sha256")
    .update(`${sessionID}\0${sourceAssistantMessageID}\0${resetAt ?? "none"}\0${generation}`)
    .digest("hex")}`
}

/**
 * Autonomous arming requires a trusted source *and* a still-future boundary. A reset deadline that
 * already elapsed at observation is manual-retry only; it must never become unattended provider work.
 */
const armableNow = (resetAt: number | undefined, resetSource: Contract.ResetSource | undefined, now: number) =>
  futureReset(resetAt, now) && trustedReset(resetSource)

export function get(db: DB, sessionID: SessionSchema.ID) {
  return db
    .select()
    .from(SessionLimitRecoveryTable)
    .where(eq(SessionLimitRecoveryTable.session_id, sessionID))
    .get()
    .pipe(Effect.map((row) => (row ? decode(row) : undefined)), Effect.orDie)
}

/** Replace the Session's operational cursor; duplicate observation of the exact stop is idempotent. */
export const observeFailure = Effect.fn("SessionLimitRecovery.observeFailure")(function* (db: DB, input: Failure) {
  const now = input.now ?? Date.now()
  const continuationID = (generation: number) =>
    makeContinuationID(input.sessionID, input.sourceAssistantMessageID, input.resetAt, generation)

  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
        const current = yield* tx
          .select()
          .from(SessionLimitRecoveryTable)
          .where(eq(SessionLimitRecoveryTable.session_id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        const sameStopIdentity =
          current?.source_assistant_message_id === input.sourceAssistantMessageID &&
          current.source_user_message_id === (input.sourceUserMessageID ?? null) &&
          current.provider_id === input.providerID &&
          current.account_id === (input.accountID ?? null) &&
          current.model_id === input.modelID
        // Explicit manual Resume is user authority over this exact stopped
        // generation. A slower/repeated failure observation may refine display
        // evidence, but must not downgrade that decision back into an
        // unattended schedule or replace its deterministic continuation.
        if (current?.manual_resume && sameStopIdentity) return decode(current)
        const unchanged =
          sameStopIdentity &&
          current.reset_at === (input.resetAt ?? null) &&
          current.reset_source === (input.resetSource ?? null)
        const generation = unchanged
          ? current.generation
          : yield* tx
              .insert(SessionLimitRecoveryEpochTable)
              .values({ session_id: input.sessionID, generation: 1 })
              .onConflictDoUpdate({
                target: SessionLimitRecoveryEpochTable.session_id,
                set: { generation: sql`${SessionLimitRecoveryEpochTable.generation} + 1` },
              })
              .returning({ generation: SessionLimitRecoveryEpochTable.generation })
              .get()
              .pipe(Effect.map((row) => row!.generation), Effect.orDie)
        // A duplicate observation of the exact stop is idempotent: it must neither silently revoke armed
        // recovery nor silently grant it. Only a fresh generation may be armed autonomously.
        const autoResume =
          unchanged && current
            ? current.auto_resume
            : input.autoResume === true && armableNow(input.resetAt, input.resetSource, now)
        yield* tx
          .insert(SessionLimitRecoveryTable)
          .values({
            session_id: input.sessionID,
            source_assistant_message_id: input.sourceAssistantMessageID,
            source_user_message_id: input.sourceUserMessageID ?? null,
            provider_id: input.providerID,
            account_id: input.accountID ?? null,
            model_id: input.modelID,
            failure_class: input.failureClass,
            failure_code: input.failureCode ?? null,
            reset_at: input.resetAt ?? null,
            reset_source: input.resetSource ?? null,
            reset_observed_at: input.resetObservedAt ?? null,
            // Freeze the human-focus fence for duplicate observation of the exact stop.
            expected_latest_user_seq:
              unchanged && current ? current.expected_latest_user_seq : input.expectedLatestUserSeq ?? null,
            generation,
            auto_resume: autoResume,
            manual_resume: unchanged && current ? current.manual_resume : false,
            snooze_until:
              unchanged
                ? current.snooze_until
                : input.snoozeUntilReset === true && futureReset(input.resetAt, now)
                  ? input.resetAt!
                  : null,
            continuation_id: continuationID(generation),
            // A duplicate observation must not revoke an in-flight recovery lease.
            claim_owner: unchanged && current ? current.claim_owner : null,
            claim_expires_at: unchanged && current ? current.claim_expires_at : null,
            time_created: unchanged ? current.time_created : now,
            time_updated: now,
          })
          .onConflictDoUpdate({
            target: SessionLimitRecoveryTable.session_id,
            set: {
              source_assistant_message_id: input.sourceAssistantMessageID,
              source_user_message_id: input.sourceUserMessageID ?? null,
              provider_id: input.providerID,
              account_id: input.accountID ?? null,
              model_id: input.modelID,
              failure_class: input.failureClass,
              failure_code: input.failureCode ?? null,
              reset_at: input.resetAt ?? null,
              reset_source: input.resetSource ?? null,
              reset_observed_at: input.resetObservedAt ?? null,
              expected_latest_user_seq:
                unchanged && current ? current.expected_latest_user_seq : input.expectedLatestUserSeq ?? null,
              generation,
              auto_resume: autoResume,
              manual_resume: unchanged && current ? current.manual_resume : false,
              snooze_until:
                unchanged
                  ? current.snooze_until
                  : input.snoozeUntilReset === true && futureReset(input.resetAt, now)
                    ? input.resetAt!
                    : null,
              continuation_id: continuationID(generation),
              claim_owner: unchanged && current ? current.claim_owner : null,
              claim_expires_at: unchanged && current ? current.claim_expires_at : null,
              time_updated: now,
            },
          })
          .run()
          .pipe(Effect.orDie)
        const row = yield* tx
          .select()
          .from(SessionLimitRecoveryTable)
          .where(eq(SessionLimitRecoveryTable.session_id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        return row ? decode(row) : undefined
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

/**
 * Generation-fenced asynchronous reset enrichment.
 *
 * A quota endpoint can finish after the terminal provider failure was already
 * persisted. Learning a reset boundary changes continuation identity, so it
 * advances the generation rather than mutating the old cursor in place.
 * Existing trusted runtime evidence always wins.
 */
export const enrichReset = Effect.fn("SessionLimitRecovery.enrichReset")(function* (
  db: DB,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly generation: number
    readonly resetAt: number
    readonly resetSource: Contract.ResetSource
    readonly resetObservedAt: number
    readonly autoResume?: boolean
    readonly snoozeUntilReset?: boolean
    readonly now?: number
  },
) {
  const now = input.now ?? Date.now()
  if (!Number.isSafeInteger(input.resetAt) || input.resetAt <= 0) return undefined

  return yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select()
            .from(SessionLimitRecoveryTable)
            .where(eq(SessionLimitRecoveryTable.session_id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!current || current.generation !== input.generation) return undefined
          // A manual Resume is explicit user execution authority. If it wins
          // the race with asynchronous quota enrichment, retain this exact
          // generation instead of moving the runner onto a new continuation ID.
          if (current.manual_resume) return decode(current)
          if (
            current.reset_at !== null &&
            trustedReset(current.reset_source as Contract.ResetSource | undefined)
          ) {
            return decode(current)
          }

          const generation = current.generation + 1
          const continuationID = makeContinuationID(
            input.sessionID,
            current.source_assistant_message_id,
            input.resetAt,
            generation,
          )
          const autoResume =
            input.autoResume === true && armableNow(input.resetAt, input.resetSource, now)
          const snoozeUntil =
            input.snoozeUntilReset === true && futureReset(input.resetAt, now)
              ? input.resetAt
              : null

          const row = yield* tx
            .update(SessionLimitRecoveryTable)
            .set({
              reset_at: input.resetAt,
              reset_source: input.resetSource,
              reset_observed_at: input.resetObservedAt,
              generation,
              auto_resume: autoResume,
              manual_resume: false,
              snooze_until: snoozeUntil,
              continuation_id: continuationID,
              claim_owner: null,
              claim_expires_at: null,
              time_updated: now,
            })
            .where(
              and(
                eq(SessionLimitRecoveryTable.session_id, input.sessionID),
                eq(SessionLimitRecoveryTable.generation, input.generation),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          return row ? decode(row) : undefined
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const setAutoResume = Effect.fn("SessionLimitRecovery.setAutoResume")(function* (
  db: DB,
  input: { readonly sessionID: SessionSchema.ID; readonly generation: number; readonly enabled: boolean; readonly now?: number },
) {
  const now = input.now ?? Date.now()
  const row = yield* db
    .update(SessionLimitRecoveryTable)
    .set({
      auto_resume: input.enabled,
      time_updated: now,
    })
    .where(
      and(
        eq(SessionLimitRecoveryTable.session_id, input.sessionID),
        eq(SessionLimitRecoveryTable.generation, input.generation),
        input.enabled
          ? and(
              eq(SessionLimitRecoveryTable.manual_resume, false),
              sql`${SessionLimitRecoveryTable.reset_at} IS NOT NULL`,
              sql`${SessionLimitRecoveryTable.reset_at} > ${now}`,
              inArray(SessionLimitRecoveryTable.reset_source, TRUSTED_RESET_SOURCES),
            )
          : sql`1 = 1`,
      ),
    )
    .returning()
    .pipe(Effect.orDie)
  return row[0] ? decode(row[0]) : undefined
})

export const setSnooze = Effect.fn("SessionLimitRecovery.setSnooze")(function* (
  db: DB,
  input: { readonly sessionID: SessionSchema.ID; readonly generation: number; readonly until?: number; readonly now?: number },
) {
  const row = yield* db
    .update(SessionLimitRecoveryTable)
    .set({ snooze_until: input.until ?? null, time_updated: input.now ?? Date.now() })
    .where(
      and(
        eq(SessionLimitRecoveryTable.session_id, input.sessionID),
        eq(SessionLimitRecoveryTable.generation, input.generation),
      ),
    )
    .returning()
    .pipe(Effect.orDie)
  return row[0] ? decode(row[0]) : undefined
})

/**
 * Persist explicit user authority to continue immediately.
 *
 * Manual Resume is intentionally independent of reset provenance. The durable
 * bit gives the process-global runner crash/restart recovery without pretending
 * an advisory or unknown deadline was provider-authoritative.
 */
export const requestManualResume = Effect.fn("SessionLimitRecovery.requestManualResume")(function* (
  db: DB,
  input: { readonly sessionID: SessionSchema.ID; readonly generation: number; readonly now?: number },
) {
  const now = input.now ?? Date.now()
  const row = yield* db
    .update(SessionLimitRecoveryTable)
    .set({
      manual_resume: true,
      auto_resume: false,
      snooze_until: null,
      claim_owner: null,
      claim_expires_at: null,
      time_updated: now,
    })
    .where(
      and(
        eq(SessionLimitRecoveryTable.session_id, input.sessionID),
        eq(SessionLimitRecoveryTable.generation, input.generation),
      ),
    )
    .returning()
    .pipe(Effect.orDie)
  return row[0] ? decode(row[0]) : undefined
})

export const cancel = Effect.fn("SessionLimitRecovery.cancel")(function* (
  db: DB,
  input: { readonly sessionID: SessionSchema.ID; readonly generation: number },
) {
  const rows = yield* db
    .delete(SessionLimitRecoveryTable)
    .where(
      and(
        eq(SessionLimitRecoveryTable.session_id, input.sessionID),
        eq(SessionLimitRecoveryTable.generation, input.generation),
      ),
    )
    .returning({ sessionID: SessionLimitRecoveryTable.session_id })
    .pipe(Effect.orDie)
  return rows.length > 0
})

export const nextDueAt = Effect.fn("SessionLimitRecovery.nextDueAt")(function* (db: DB, now = Date.now()) {
  const manual = yield* db
    .select({ sessionID: SessionLimitRecoveryTable.session_id })
    .from(SessionLimitRecoveryTable)
    .where(
      and(
        eq(SessionLimitRecoveryTable.manual_resume, true),
        or(
          isNull(SessionLimitRecoveryTable.claim_owner),
          isNull(SessionLimitRecoveryTable.claim_expires_at),
          sql`${SessionLimitRecoveryTable.claim_expires_at} <= ${now}`,
        ),
      ),
    )
    .orderBy(asc(SessionLimitRecoveryTable.session_id))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

  const runnable = yield* db
    .select({ resetAt: SessionLimitRecoveryTable.reset_at })
    .from(SessionLimitRecoveryTable)
    .where(
      and(
        eq(SessionLimitRecoveryTable.auto_resume, true),
        sql`${SessionLimitRecoveryTable.reset_at} IS NOT NULL`,
        inArray(SessionLimitRecoveryTable.reset_source, TRUSTED_RESET_SOURCES),
        or(
          isNull(SessionLimitRecoveryTable.claim_owner),
          isNull(SessionLimitRecoveryTable.claim_expires_at),
          sql`${SessionLimitRecoveryTable.claim_expires_at} <= ${now}`,
        ),
      ),
    )
    .orderBy(asc(SessionLimitRecoveryTable.reset_at))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

  const claimed = yield* db
    .select({ claimExpiresAt: SessionLimitRecoveryTable.claim_expires_at })
    .from(SessionLimitRecoveryTable)
    .where(
      and(
        or(
          eq(SessionLimitRecoveryTable.manual_resume, true),
          and(
            eq(SessionLimitRecoveryTable.auto_resume, true),
            inArray(SessionLimitRecoveryTable.reset_source, TRUSTED_RESET_SOURCES),
          ),
        ),
        isNotNull(SessionLimitRecoveryTable.claim_owner),
        isNotNull(SessionLimitRecoveryTable.claim_expires_at),
        gt(SessionLimitRecoveryTable.claim_expires_at, now),
      ),
    )
    .orderBy(asc(SessionLimitRecoveryTable.claim_expires_at))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

  const resetAt = runnable?.resetAt ?? undefined
  const claimExpiresAt = claimed?.claimExpiresAt ?? undefined
  if (manual) return now
  if (resetAt === undefined) return claimExpiresAt
  if (claimExpiresAt === undefined) return resetAt
  return Math.min(resetAt, claimExpiresAt)
})

/** Bounded indexed due scan. Snooze is attention state and deliberately does not affect execution eligibility. */
export const due = Effect.fn("SessionLimitRecovery.due")(function* (db: DB, now: number, limit = 50) {
  const rows = yield* db
    .select()
    .from(SessionLimitRecoveryTable)
    .where(
      and(
        or(
          eq(SessionLimitRecoveryTable.manual_resume, true),
          and(
            eq(SessionLimitRecoveryTable.auto_resume, true),
            sql`${SessionLimitRecoveryTable.reset_at} <= ${now}`,
            inArray(SessionLimitRecoveryTable.reset_source, TRUSTED_RESET_SOURCES),
          ),
        ),
        or(
          isNull(SessionLimitRecoveryTable.claim_owner),
          isNull(SessionLimitRecoveryTable.claim_expires_at),
          sql`${SessionLimitRecoveryTable.claim_expires_at} <= ${now}`,
        ),
      ),
    )
    .orderBy(
      sql`${SessionLimitRecoveryTable.manual_resume} DESC`,
      asc(SessionLimitRecoveryTable.reset_at),
      asc(SessionLimitRecoveryTable.session_id),
    )
    .limit(Math.max(0, Math.min(limit, 100)))
    .all()
    .pipe(Effect.orDie)
  return rows.map(decode)
})

/** SQLite adjudicates cross-process ownership; an expired claim can be reclaimed after restart. */
export const claim = Effect.fn("SessionLimitRecovery.claim")(function* (
  db: DB,
  input: { readonly sessionID: SessionSchema.ID; readonly generation: number; readonly owner: string; readonly now: number; readonly leaseMs?: number },
) {
  const rows = yield* db
    .update(SessionLimitRecoveryTable)
    .set({ claim_owner: input.owner, claim_expires_at: input.now + (input.leaseMs ?? 30_000), time_updated: input.now })
    .where(
      and(
        eq(SessionLimitRecoveryTable.session_id, input.sessionID),
        eq(SessionLimitRecoveryTable.generation, input.generation),
        or(
          eq(SessionLimitRecoveryTable.manual_resume, true),
          and(
            eq(SessionLimitRecoveryTable.auto_resume, true),
            sql`${SessionLimitRecoveryTable.reset_at} <= ${input.now}`,
            inArray(SessionLimitRecoveryTable.reset_source, TRUSTED_RESET_SOURCES),
          ),
        ),
        or(
          isNull(SessionLimitRecoveryTable.claim_owner),
          // A claim that lost its expiry must stay reclaimable instead of being stuck forever.
          isNull(SessionLimitRecoveryTable.claim_expires_at),
          sql`${SessionLimitRecoveryTable.claim_expires_at} <= ${input.now}`,
        ),
      ),
    )
    .returning()
    .pipe(Effect.orDie)
  return rows[0] ? decode(rows[0]) : undefined
})

export const releaseClaim = Effect.fn("SessionLimitRecovery.releaseClaim")(function* (
  db: DB,
  input: { readonly sessionID: SessionSchema.ID; readonly generation: number; readonly owner: string },
) {
  yield* db
    .update(SessionLimitRecoveryTable)
    .set({ claim_owner: null, claim_expires_at: null })
    .where(
      and(
        eq(SessionLimitRecoveryTable.session_id, input.sessionID),
        eq(SessionLimitRecoveryTable.generation, input.generation),
        eq(SessionLimitRecoveryTable.claim_owner, input.owner),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export function decode(row: Row): Info {
  return Contract.Info.make({
    sessionID: row.session_id,
    sourceAssistantMessageID: SessionMessage.ID.make(row.source_assistant_message_id),
    ...(row.source_user_message_id ? { sourceUserMessageID: SessionMessage.ID.make(row.source_user_message_id) } : {}),
    providerID: row.provider_id,
    ...(row.account_id ? { accountID: row.account_id } : {}),
    modelID: row.model_id,
    failureClass: row.failure_class as Contract.FailureClass,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.reset_at === null ? {} : { resetAt: DateTime.makeUnsafe(row.reset_at) }),
    ...(row.reset_source === null ? {} : { resetSource: row.reset_source as Contract.ResetSource }),
    ...(row.reset_observed_at === null ? {} : { resetObservedAt: DateTime.makeUnsafe(row.reset_observed_at) }),
    ...(row.expected_latest_user_seq === null ? {} : { expectedLatestUserSeq: row.expected_latest_user_seq }),
    generation: row.generation,
    autoResume: row.auto_resume,
    manualResume: row.manual_resume,
    ...(row.snooze_until === null ? {} : { snoozeUntil: DateTime.makeUnsafe(row.snooze_until) }),
    continuationID: row.continuation_id,
    ...(row.claim_owner ? { claimOwner: row.claim_owner } : {}),
    ...(row.claim_expires_at === null ? {} : { claimExpiresAt: DateTime.makeUnsafe(row.claim_expires_at) }),
    timeCreated: DateTime.makeUnsafe(row.time_created),
    timeUpdated: DateTime.makeUnsafe(row.time_updated),
  })
}
