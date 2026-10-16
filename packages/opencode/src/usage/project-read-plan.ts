import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"

/**
 * Choose between a project-first session index walk and a time-first scan.
 *
 * Project-first is very fast when a selected project owns a small fraction of
 * Sessions, but adds expensive seeks and a global sort when a project dominates
 * almost the entire ledger. COUNT(*) is inexpensive on the existing indexes.
 * Both alternatives are logically equivalent; this affects cost, never data.
 *
 * Double-counting live+historical dimensions in both numerator and denominator
 * is intentional: it is a conservative metadata-only selectivity estimator.
 */
export function shouldIndexUsageProject(
  conn: Database.DatabaseShape,
  projectID: string,
): Effect.Effect<boolean> {
  return conn.get<{ selected: number; available: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM session WHERE project_id = ${projectID})
        + (SELECT COUNT(*) FROM usage_session WHERE project_id = ${projectID}) AS selected,
      (SELECT COUNT(*) FROM session)
        + (SELECT COUNT(*) FROM usage_session) AS available
  `).pipe(
    Effect.map((row) => Boolean(row && row.available > 0 && row.selected * 4 < row.available)),
    Effect.orDie,
  )
}
