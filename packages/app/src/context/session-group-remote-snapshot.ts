/**
 * Central, bootstrap-on-demand cache for *inactive* server SessionGroups.
 *
 * One request flight per connected server regardless of how many tabs hover
 * over it. No timers, transport subscriptions or per-row requests are added.
 * Failed requests have a short backoff; successful snapshots have a bounded
 * freshness window and are refreshed only by a later explicit reader.
 */
export function createRemoteSessionGroupSnapshots<T>(options: {
  load: (server: string, valid: () => boolean) => Promise<T>
  publish: (server: string, value: T) => void
  now?: () => number
  freshnessMs?: number
  retryMs?: number
}) {
  const now = options.now ?? Date.now
  const freshnessMs = options.freshnessMs ?? 5 * 60_000
  const retryMs = options.retryMs ?? 15_000
  const successful = new Map<string, number>()
  const attempted = new Map<string, number>()
  // Deletable object-identity epochs prevent accumulating numeric tombstones
  // for every disconnected key while still rejecting a late old response
  // after reconnecting with the same logical server key.
  const generation = new Map<string, object>()
  const inflight = new Map<string, Promise<void>>()
  const dirty = new Set<string>()
  let disposed = false
  const version = (key: string) => {
    let token = generation.get(key)
    if (!token) {
      token = {}
      generation.set(key, token)
    }
    return token
  }

  return {
    ensure(key: string) {
      if (disposed || inflight.has(key)) return
      const clock = now()
      const lastGood = successful.get(key)
      if (lastGood !== undefined && clock - lastGood < freshnessMs) return
      const lastTry = attempted.get(key)
      if (lastTry !== undefined && clock - lastTry < retryMs) return
      attempted.set(key, clock)
      const epoch = version(key)
      const valid = () => !disposed && generation.get(key) === epoch
      const promise = options.load(key, valid)
        .then((data) => {
          if (disposed || generation.get(key) !== epoch) return
          options.publish(key, data)
          successful.set(key, now())
        })
        .catch(() => undefined)
        .finally(() => {
          if (inflight.get(key) !== promise) return
          inflight.delete(key)
          // A storm of membership events while HTTP was pending should
          // enqueue one successor, not one overlapping request per event.
          if (!dirty.delete(key) || disposed) return
          this.ensure(key)
        })
      inflight.set(key, promise)
    },
    pending(key: string) {
      return inflight.has(key)
    },
    refresh(key: string) {
      if (disposed) return
      if (!inflight.has(key)) {
        this.forget(key)
        this.ensure(key)
        return
      }
      // Logically retire the current response without removing its physical
      // HTTP flight. The finalizer performs one latest-only replacement.
      generation.set(key, {})
      successful.delete(key)
      attempted.delete(key)
      dirty.add(key)
    },
    forget(key: string) {
      generation.delete(key)
      successful.delete(key)
      attempted.delete(key)
      inflight.delete(key)
      dirty.delete(key)
    },
    dispose() {
      disposed = true
      inflight.clear()
      successful.clear()
      attempted.clear()
      dirty.clear()
      generation.clear()
    },
  }
}