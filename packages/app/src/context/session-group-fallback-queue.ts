/**
 * Old servers without sessionGroup.listDetails need individual get() calls.
 * Bound fallback concurrency instead of spawning one HTTP request per group.
 * Stop admitting queued requests when a newer server-scoped snapshot replaces
 * this one; already-running calls settle under the normal generation guard.
 */
export async function fetchSessionGroupDetailsBounded(
  ids: readonly string[],
  fetch: (id: string) => Promise<unknown>,
  valid: () => boolean,
  concurrency = 4,
): Promise<void> {
  if (!ids.length || !valid()) return
  let next = 0
  const max = Math.min(ids.length, Math.max(1, Math.floor(concurrency)))
  await Promise.all(Array.from({ length: max }, async () => {
    while (valid()) {
      const index = next++
      if (index >= ids.length) return
      try {
        await fetch(ids[index]!)
      } catch {
        // Individual fallback failures never fail the entire navigation
        // projection; a later invalidation can retry this group.
      }
    }
  }))
}