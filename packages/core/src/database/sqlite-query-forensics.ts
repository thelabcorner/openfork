/**
 * Stable, privacy-safe correlation of previously observed runaway SQL shapes.
 * Fingerprints are diagnostic hints, not authorization or query identity.
 * Never persist or log SQL text, bind arguments, or call stacks.
 */
export function sqliteFingerprint(query: string): string {
  let hash = 2166136261
  const sample = (index: number) => {
    hash ^= query.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const limit = Math.min(query.length, 2048)
  for (let i = 0; i < limit; i++) sample(i)
  if (query.length > limit) {
    for (let i = query.length - Math.min(512, query.length - limit); i < query.length; i++) sample(i)
  }
  hash ^= query.length
  return (hash >>> 0).toString(16).padStart(8, "0")
}

const runaway = new Map([
  ["c2b111a6", 1065],
  ["0bbba6a9", 1001],
])

/** Recognize only the two independently reproduced incident SQL templates. */
export function sqlitePlanProbeFingerprint(query: string): string | undefined {
  if (query.length !== 1065 && query.length !== 1001) return
  const hash = sqliteFingerprint(query)
  return runaway.get(hash) === query.length ? hash : undefined
}

export interface SqlitePlanDiagnostic {
  readonly hash: string
  readonly steps: number
  readonly scans: number
  readonly searches: number
  readonly tempSorts: number
  readonly covering: number
  readonly automaticIndexes: number
  readonly status: "ok" | "unavailable"
}

/**
 * Summarize EXPLAIN QUERY PLAN details from a SQLite worker, never forwarding
 * table/column/index identifiers, private SQL literals, or arguments.
 */
export function summarizeSqlitePlan(hash: string, rows: readonly { detail?: unknown }[]): SqlitePlanDiagnostic {
  let scans = 0
  let searches = 0
  let tempSorts = 0
  let covering = 0
  let automaticIndexes = 0
  for (const row of rows) {
    const detail = typeof row.detail === "string" ? row.detail.toUpperCase() : ""
    if (/^SCAN\b/.test(detail)) scans++
    if (/^SEARCH\b/.test(detail)) searches++
    if (detail.includes("USE TEMP B-TREE")) tempSorts++
    if (detail.includes("COVERING INDEX")) covering++
    if (detail.includes("AUTOMATIC INDEX")) automaticIndexes++
  }
  return { hash, steps: rows.length, scans, searches, tempSorts, covering, automaticIndexes, status: "ok" }
}

export function unavailableSqlitePlan(hash: string): SqlitePlanDiagnostic {
  return { hash, steps: 0, scans: 0, searches: 0, tempSorts: 0, covering: 0, automaticIndexes: 0, status: "unavailable" }
}
