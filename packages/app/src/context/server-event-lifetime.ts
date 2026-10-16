/**
 * The shared SDK owns one SSE socket per server. ServerSync permanently pins
 * it for its own lifetime, while a committed remote hover may borrow it
 * temporarily without bootstrapping a full SessionSync tree. Never let the
 * release of a hover lease stop a stream already pinned by ServerSync.
 *
 * This owner controls stream admission only; it does not create transports.
 */
export function createServerEventLifetime(options: { begin: () => void; stop: () => void }) {
  let pinned = false
  let active = false
  let disposed = false
  const leases = new Set<object>()
  const begin = () => {
    if (disposed || active) return
    active = true
    options.begin()
  }
  const stop = () => {
    if (!active) return
    active = false
    options.stop()
  }
  return {
    pin() {
      if (disposed) return
      pinned = true
      begin()
    },
    acquire() {
      if (disposed) return () => {}
      const lease = {}
      leases.add(lease)
      begin()
      return () => {
        if (!leases.delete(lease)) return
        if (!pinned && leases.size === 0) stop()
      }
    },
    pagehide() {
      stop()
    },
    pageshow() {
      if (pinned || leases.size > 0) begin()
    },
    dispose() {
      if (disposed) return
      disposed = true
      stop()
      leases.clear()
      pinned = false
    },
  }
}