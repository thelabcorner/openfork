/**
 * Versions detail requests independently for each connected server. A late
 * batch or per-group fallback is never permitted to overwrite a newer
 * refresh, even when the selected server has changed in the meantime.
 */
export function createSessionGroupRequestGenerations() {
  const generations = new Map<string, number>()
  // Globally monotonic epochs let us delete disconnected scopes outright
  // without accidentally accepting a stale response if the same key
  // reconnects. Per-scope counters would need permanent tombstones.
  let counter = 0
  return {
    current(scope: string) {
      let epoch = generations.get(scope)
      if (epoch !== undefined) return epoch
      epoch = ++counter
      generations.set(scope, epoch)
      return epoch
    },
    advance(scope: string) {
      const next = ++counter
      generations.set(scope, next)
      return next
    },
    valid(scope: string, generation: number) {
      return generations.get(scope) === generation
    },
    forget(scope: string) {
      generations.delete(scope)
    },
    dedupeKey(scope: string, groupId: string, generation: number) {
      return JSON.stringify([scope, generation, groupId])
    },
  }
}