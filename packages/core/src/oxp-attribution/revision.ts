export * as OxpAttributionRevision from "./revision"

/**
 * Monotonic in-process revision for durable OXP context-footprint projections.
 *
 * This intentionally does not reuse UsageRevision: OXP settlement should not
 * invalidate unrelated provider-usage caches. Readers combine this local signal
 * with SQLite PRAGMA data_version to observe commits from maintenance/peer
 * connections.
 */
let revision = 0

// Bounded commit journal: producers identify the activity affected by each
// successful write. Unknown changes or expired history force a full rebuild.
const LIMIT = 2048
type Change = { readonly revision: number; readonly activities?: readonly string[] }
const changes: Array<Change | undefined> = new Array(LIMIT)

export const current = () => revision

export const advance = (activities?: string | readonly string[]) => {
  revision += 1
  changes[revision % LIMIT] = { revision, activities: typeof activities === "string" ? [activities] : activities }
}

/** Unknown delta => undefined; never guess which activities changed. */
export const changedSince = (before: number): ReadonlySet<string> | undefined => {
  if (!Number.isSafeInteger(before) || before < 0 || before > revision) return
  if (before === revision) return new Set()
  if (revision - before > LIMIT) return
  const result = new Set<string>()
  for (let next = before + 1; next <= revision; next++) {
    const change = changes[next % LIMIT]
    if (change?.revision !== next) return
    if (!change.activities) return
    for (const activity of change.activities) result.add(activity)
  }
  return result
}
