import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseShape } from "./database"

/**
 * Cross-process commit watermark observed on one SQLite connection.
 *
 * PRAGMA data_version changes on this connection whenever ANOTHER connection
 * commits, and deliberately ignores this connection's own commits. An unchanged
 * value therefore proves only that no other writer committed — never that
 * durable state is unchanged. Callers that must also observe their own writes
 * combine this external signal with an in-process revision; see
 * `UsageHistoryWatermark`.
 *
 * The probe reads no table, acquires no lock, and opens no read transaction, so
 * it is safe to run on the foreground writer connection beside live session
 * writes.
 *
 * This strict variant reports an unreadable pragma as a defect. That is correct
 * for maintenance gating, where an unknown writer state must not be treated as
 * quiet. A cache reader wants the opposite trade: an unobservable probe must
 * invalidate, not crash and not masquerade as unchanged, so it uses
 * `observeDataVersion` instead.
 */
export const dataVersion = (db: DatabaseShape): Effect.Effect<number> =>
  db
    .get<{ data_version: number }>(sql`PRAGMA data_version`)
    .pipe(
      Effect.map((row) => Number(row?.data_version ?? 0)),
      Effect.orDie,
    )

/**
 * Non-failing cross-process commit watermark.
 *
 * `undefined` means "not observed": the pragma failed, or it returned no usable
 * counter. Both failures and defects are absorbed, because a caller can only
 * respond safely by invalidating its cached view — never by crashing and never
 * by concluding that nothing changed.
 */
export const observeDataVersion = (db: DatabaseShape): Effect.Effect<number | undefined> =>
  db
    .get<{ data_version: number }>(sql`PRAGMA data_version`)
    .pipe(
      Effect.map((row) => {
        const raw = row?.data_version
        if (raw === undefined || raw === null) return undefined
        const version = Number(raw)
        return Number.isFinite(version) ? version : undefined
      }),
      // Catch cause, not just failure: a driver-level defect must still resolve
      // to "unobserved" so the reader fails open instead of propagating.
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
