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

export const current = () => revision

export const advance = () => {
  revision += 1
}
