/**
 * JSDOC: Safe read of a @tanstack/solid-query result without Suspense.
 *
 * `@tanstack/solid-query` creates an internal `createResource()` per query.
 * Accessing `.data` while the resource is unresolved (`isPending` true)
 * causes Solid's Suspense mechanism to park the read, producing route-level
 * black screens (see session-composer-controls.ts, session-groups.ts,
 * session.tsx, server-sync.tsx). This helper guards with `isPending` first,
 * then reads `.data ?? fallback`, never triggering the suspension trap.
 *
 * @param {Object} query - The @tanstack/solid-query result (needs `isPending`, `data`)
 * @param {T} fallback - Default value when the query hasn't resolved yet
 * @returns {T} The query data (with fallback default) or the fallback itself
 */
export function safeQueryData<T>(query: { isPending: boolean; data?: T }, fallback: T): T {
  return query.isPending ? (fallback as T) : ((query.data ?? fallback) as T)
}
