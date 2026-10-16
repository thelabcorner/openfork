/**
 * Bounded revision-fenced Context aggregate memo for persistent WAL readers.
 *
 * The durable per-session event sequence detects normal event projection.
 * SQLite's connection-local PRAGMA data_version additionally changes after
 * writes by *other connections*, including direct SQL maintenance that did
 * not publish an EventV2 event. The scanDb handle is persistent, query_only
 * and separate from the writer for file-backed databases.
 *
 * NEVER cache in-memory databases: scanDb aliases the same writer handle and
 * data_version does not report writes performed on the querying connection.
 * NEVER reuse entries between SQLite connection identities. No timers.
 */
export type ContextTotalsCacheEntry<T> = {
  eventSeq: number
  dataVersion: number
  totals: T | undefined
}
export function createContextTotalsRevisionCache<T>(capacity = 128) {
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new Error("Context totals cache capacity must be a positive integer")
  const perConnection = new WeakMap<object, Map<string, ContextTotalsCacheEntry<T>>>()
  const bucket = (connection: object) => {
    let value = perConnection.get(connection)
    if (!value) {
      value = new Map()
      perConnection.set(connection, value)
    }
    return value
  }
  const lookup = (connection: object, sessionID: string, eventSeq: number, dataVersion: number) => {
    const entries = bucket(connection)
    const entry = entries.get(sessionID)
    if (!entry || entry.eventSeq !== eventSeq || entry.dataVersion !== dataVersion)
      return { hit: false as const }
    // Reads preserve a recency order without allocating a separate metadata
    // structure. The cache owns at most 128 compact six-scalar objects.
    entries.delete(sessionID)
    entries.set(sessionID, entry)
    return { hit: true as const, totals: entry.totals }
  }
  const store = (connection: object, sessionID: string, entry: ContextTotalsCacheEntry<T>) => {
    const entries = bucket(connection)
    entries.delete(sessionID)
    entries.set(sessionID, entry)
    if (entries.size > capacity) entries.delete(entries.keys().next().value!)
  }
  return { lookup, store }
}
