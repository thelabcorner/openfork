import { Duration, Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseShape } from "./database"

export const SQLITE_MAINTENANCE_QUIET_MS = 100
export const SQLITE_MAINTENANCE_POLL_MS = 10

/**
 * Cross-process low-priority writer gate.
 *
 * PRAGMA data_version changes on this connection whenever ANOTHER connection
 * commits, but deliberately ignores this connection's own commits. Background
 * maintenance can therefore wait for a short externally-quiet window, then
 * drain aggressively until foreground activity resumes.
 */
export function makeSqliteMaintenanceQuietGate(
  db: DatabaseShape,
  options?: { readonly quietMs?: number; readonly pollMs?: number },
) {
  const quietMs = Math.max(0, Math.floor(options?.quietMs ?? SQLITE_MAINTENANCE_QUIET_MS))
  const pollMs = Math.max(1, Math.floor(options?.pollMs ?? SQLITE_MAINTENANCE_POLL_MS))
  let observedVersion: number | undefined
  let quietSince = 0

  const wait = Effect.fnUntraced(function* () {
    for (;;) {
      const row = yield* db
        .get<{ data_version: number }>(sql`PRAGMA data_version`)
        .pipe(Effect.orDie)
      const version = Number(row?.data_version ?? 0)
      const now = Date.now()
      if (observedVersion === undefined || version !== observedVersion) {
        observedVersion = version
        quietSince = now
      }
      const remaining = quietMs - (now - quietSince)
      if (remaining <= 0) return
      yield* Effect.sleep(Duration.millis(Math.min(pollMs, remaining)))
    }
  })

  return { wait } as const
}

export type SqliteMaintenanceQuietGate = ReturnType<typeof makeSqliteMaintenanceQuietGate>
