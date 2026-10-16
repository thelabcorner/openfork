/**
 * Reference-counted, hover-scoped event listeners for inactive servers.
 * Only an actually open remote inspector retains a subscription. Same-tick
 * Swarm/group event bursts coalesce into one cached-snapshot refresh.
 */
export function createRemoteGroupObservers(options: {
  subscribe: (server: string, onEvent: (type: string) => void) => () => void
  invalidates: (type: string) => boolean
  onChanged: (server: string) => void
  onUnwatched?: (server: string) => void
  /** Minimum coalescing window across multiple event-loop ticks; defaults
   * to the original microtask-only behavior for existing consumers/tests. */
  coalesceMs?: number
}) {
  type Entry = {
    refs: number
    release: () => void
    queued: boolean
    revision: number
    timer?: ReturnType<typeof setTimeout>
  }
  const entries = new Map<string, Entry>()
  const cancelQueued = (entry: Entry) => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.queued = false
  }
  const connect = (server: string, entry: Entry) => {
    const revision = ++entry.revision
    cancelQueued(entry)
    try {
      entry.release = options.subscribe(server, (type) => {
        // A previously revoked transport callback cannot invalidate a new
        // principal's cache even if its final event races with unsubscribe.
        if (entries.get(server) !== entry || entry.revision !== revision) return
        if (!options.invalidates(type) || entry.queued) return
        entry.queued = true
        const flush = () => {
          entry.timer = undefined
          if (entries.get(server) !== entry || entry.revision !== revision) return
          entry.queued = false
          options.onChanged(server)
        }
        if (options.coalesceMs && options.coalesceMs > 0)
          entry.timer = setTimeout(flush, options.coalesceMs)
        else queueMicrotask(flush)
      })
    } catch {
      entry.release = () => {}
    }
  }
  const drop = (server: string) => {
    const entry = entries.get(server)
    if (!entry) return
    entries.delete(server)
    entry.revision++
    cancelQueued(entry)
    entry.release()
    options.onUnwatched?.(server)
  }
  return {
    watching(server: string) {
      return entries.has(server)
    },
    refresh(server: string) {
      const entry = entries.get(server)
      if (!entry) return
      entry.revision++
      cancelQueued(entry)
      entry.release()
      connect(server, entry)
    },
    watch(server: string) {
      let entry = entries.get(server)
      if (entry) entry.refs++
      else {
        const current: Entry = { refs: 1, release: () => {}, queued: false, revision: 0 }
        entries.set(server, current)
        connect(server, current)
        entry = current
      }
      let released = false
      return () => {
        if (released) return
        released = true
        const current = entries.get(server)
        if (current !== entry) return
        if (--current.refs <= 0) drop(server)
      }
    },
    drop,
    dispose() {
      for (const server of entries.keys()) drop(server)
    },
  }
}