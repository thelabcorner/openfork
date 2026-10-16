/**
 * Authoritative Context totals from producer-owned V1 part facts.
 *
 * Never transfer transcript bodies or build a message-sized JS collection.
 * One SQLite aggregate computes the totals over all uncompacted messages;
 * for historical v0/opaque parts or compaction-reordered history the caller
 * must use the canonical ContextInspection ledger instead.
 *
 * This is still an O(history) SQL aggregate, NOT the final O(1) incrementally
 * maintained totals table. The facts are producer-owned; totals are computed
 * at read time until migration/backfill can prove every historical row.
 */
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { Database } from "@opencode-ai/core/database/database"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { eq } from "drizzle-orm"
import { createContextTotalsRevisionCache } from "./totals-cache"

export type ContextTotals = {
  messageCount: number
  excludedCount: number
  pinnedCount: number
  editedCount: number
  estimatedTokens: number
  estimatedTokensExcluded: number
}

// Connection-owned, bounded and strictly revision-fenced. Unlike eager
// transactional per-part materialization this imposes zero additional writes
// on active model generation. Hot settled reads are O(1) SQLite scalars.
const totalsCache = createContextTotalsRevisionCache<ContextTotals>(128)

const stateSources = Object.entries(SessionTurnProvenance.policies)
  .filter(([, policy]) => policy.owner === "host" && policy.lineage === "state")
  .map(([source]) => source)
const stateList = sql.join(stateSources.map((source) => sql`${source}`), sql`, `)

export function readChronologicalTotals(
  sessionID: string,
  reader: Pick<Database.DatabaseShape, "get">,
) {
  return Effect.gen(function* () {
    // Missing producer v1 facts make the scalar projection incomplete. Physical
    // OPCL refs are safe *when* the original producer already wrote v1 facts:
    // externalizing the part JSON does not change their exact token/signature
    // semantics. Never fill unresolved v0 refs with plausible zeroes.
    const unsupported = yield* reader.get(sql`
      SELECT 1 AS unsupported
      FROM part
      WHERE session_id = ${sessionID}
        AND (context_projection_version <> 1
          OR context_kind IS NULL OR context_tokens < 0)
      LIMIT 1
    `)
    if (unsupported) return undefined
    const opaque = yield* reader.get(sql`
      SELECT 1 AS opaque
      FROM message WHERE session_id = ${sessionID} AND context_opaque = 1 LIMIT 1
    `)
    if (opaque) return undefined

    // Shared provenance policy defines the set of host STATE kinds; avoid
    // hand-maintained SQL copies of this security-sensitive classification.
    const row = yield* reader.get<Record<keyof ContextTotals, number>>(sql`
      WITH per_message AS (
        SELECT
          m.id,
          4 + COALESCE(SUM(p.context_tokens), 0) AS tokens,
          MAX(CASE WHEN p.context_signed = 1 THEN 1 ELSE 0 END) AS signed,
          MAX(CASE WHEN p.context_kind IN ('text','reasoning')
            AND (json_extract(s.override_data, '$.partID') IS NULL
              OR p.id = json_extract(s.override_data, '$.partID'))
            THEN 1 ELSE 0 END) AS edit_target,
          MAX(CASE WHEN p.context_kind = 'tool' AND p.context_status = 'completed'
            AND p.id = json_extract(s.override_data, '$.partID')
            THEN 1 ELSE 0 END) AS collapse_target,
          COALESCE(s.excluded, 0) AS requested_excluded,
          COALESCE(s.pinned, 0) AS requested_pinned,
          json_type(s.override_data, '$.text') AS override_text_type,
          json_extract(s.override_data, '$.collapsed') AS override_collapsed,
          CASE WHEN json_extract(m.data, '$.provenance.owner') = 'host'
            AND json_extract(m.data, '$.provenance.source') IN (${stateList})
            THEN 1 ELSE 0 END AS state_owned
        FROM message m
        LEFT JOIN part p ON p.message_id = m.id
        LEFT JOIN session_context_state s ON s.session_id = m.session_id AND s.message_id = m.id
        WHERE m.session_id = ${sessionID}
        GROUP BY m.id
      ), decisions AS (
        SELECT *,
          CASE WHEN state_owned = 0 AND requested_excluded = 1
            AND requested_pinned = 0 AND COALESCE(signed, 0) = 0
            THEN 1 ELSE 0 END AS excluded,
          CASE WHEN state_owned = 0 AND requested_pinned = 1 THEN 1 ELSE 0 END AS pinned
        FROM per_message
      )
      SELECT
        COUNT(*) AS messageCount,
        COALESCE(SUM(excluded), 0) AS excludedCount,
        COALESCE(SUM(pinned), 0) AS pinnedCount,
        COALESCE(SUM(CASE WHEN state_owned = 0 AND excluded = 0
          AND ((override_text_type IS NOT NULL AND override_text_type <> 'null'
            AND COALESCE(signed, 0) = 0 AND COALESCE(edit_target, 0) = 1)
            OR (override_collapsed = 1 AND COALESCE(collapse_target, 0) = 1))
          THEN 1 ELSE 0 END), 0) AS editedCount,
        COALESCE(SUM(CASE WHEN excluded = 0 THEN tokens ELSE 0 END), 0) AS estimatedTokens,
        COALESCE(SUM(CASE WHEN excluded = 1 THEN tokens ELSE 0 END), 0) AS estimatedTokensExcluded
      FROM decisions
    `)

    if (!row) return undefined
    const totals: ContextTotals = {
      messageCount: Number(row.messageCount),
      excludedCount: Number(row.excludedCount),
      pinnedCount: Number(row.pinnedCount),
      editedCount: Number(row.editedCount),
      estimatedTokens: Number(row.estimatedTokens),
      estimatedTokensExcluded: Number(row.estimatedTokensExcluded),
    }
    if (Object.values(totals).some((value) => !Number.isSafeInteger(value) || value < 0))
      return undefined
    return totals
  })
}

/**
 * Run the full-history aggregate independently of first-page rendering.
 * Its revision belongs to the SAME committed WAL transaction as its totals,
 * so an HTTP continuation can reject a result from before a concurrent edit.
 * Cannot claim chronological coverage if compaction/opaque/v0 state exists.
 */
export const readTotals = Effect.fn("ContextLedgerTotals.read")(function* (sessionID: string) {
  const { scanDb, filename } = yield* Database.Service
  const reader = yield* scanDb()
  return yield* reader.transaction((tx) =>
    Effect.gen(function* () {
      const row = yield* tx.select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get().pipe(Effect.orDie)
      const revision = row?.seq ?? -1
      // Persistent query-only scan connection observes commits from primary
      // and external writers via PRAGMA data_version. Event sequence alone is
      // NOT an adequate fence for direct/out-of-band SQL changes. In-memory
      // scanDb aliases the writer, so never cache it.
      const rawVersion = filename === ":memory:" ? undefined
        : yield* tx.get<{ data_version: number }>(sql`PRAGMA data_version`)
      const dataVersion = rawVersion?.data_version
      const canCache = typeof dataVersion === "number" &&
        Number.isSafeInteger(dataVersion) && dataVersion >= 0
      if (canCache) {
        const cached = totalsCache.lookup(reader, sessionID, revision, dataVersion)
        // Each caller receives its own tiny six-scalar response. A UI/client
        // adapter must not be able to mutate the process-global cached value.
        if (cached.hit) return {
          revision, totals: cached.totals ? { ...cached.totals } : undefined,
        }
      }
      // A compaction part can reorder effective history. This SQL path only
      // supports chronological histories, even when no assistant has completed
      // the compaction yet (conservatively opt out).
      const compacted = yield* tx.get(sql`
        SELECT 1 FROM part
        WHERE session_id = ${sessionID} AND context_compaction = 1 LIMIT 1
      `)
      const totals = compacted ? undefined : yield* readChronologicalTotals(sessionID, tx)
      if (canCache) totalsCache.store(reader, sessionID, {
        eventSeq: revision, dataVersion,
        totals: totals ? Object.freeze({ ...totals }) : undefined,
      })
      return { revision, totals }
    }),
    { behavior: "deferred" },
  )
})
