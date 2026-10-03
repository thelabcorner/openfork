export interface PendingResponseRepairOwner {
  invalidate: (directory: string, all: boolean) => void
  dispose: () => void
}

/** Owns bounded, serialized snapshot repair after transient response-event overflow. */
export function createPendingResponseRepairOwner(input: {
  directories: () => ReadonlyArray<string>
  active: (directory: string) => boolean
  repair: (directory: string) => Promise<void>
  maxDirectories?: number
}) {
  const dirty = new Set<string>()
  const maxDirectories = input.maxDirectories ?? 32
  let all = false
  let running = false
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelay = 250
  const idleWaiters = new Set<() => void>()

  const settleIdle = () => {
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  const scheduleRetry = () => {
    if (disposed || retryTimer !== undefined) return
    const delay = retryDelay
    retryDelay = Math.min(retryDelay * 2, 10_000)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void drain()
    }, delay)
  }

  const drain = async () => {
    if (running || disposed) return
    running = true
    const failed = new Set<string>()
    try {
      while (!disposed && (all || dirty.size > 0)) {
        const batch = all ? input.directories().filter(input.active) : Array.from(dirty)
        all = false
        dirty.clear()
        for (const directory of batch) {
          if (disposed) break
          if (!input.active(directory)) continue
          try {
            await input.repair(directory)
          } catch {
            failed.add(directory)
          }
        }
      }
    } finally {
      running = false
      if (!disposed && failed.size > 0) {
        for (const directory of failed) {
          if (dirty.size < maxDirectories || dirty.has(directory)) dirty.add(directory)
          else all = true
        }
        scheduleRetry()
      } else if (!disposed && (all || dirty.size > 0)) {
        void drain()
      } else {
        retryDelay = 250
        settleIdle()
      }
    }
  }

  return {
    invalidate(directory: string, invalidateAll: boolean) {
      if (disposed) return
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
      if (invalidateAll) all = true
      else if (dirty.size < maxDirectories || dirty.has(directory)) dirty.add(directory)
      else all = true
      void drain()
    },
    dispose() {
      disposed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      dirty.clear()
      all = false
      settleIdle()
    },
    /** Test/diagnostic barrier; production callers do not wait on the repair worker. */
    whenIdle() {
      if (!running && retryTimer === undefined && !all && dirty.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        idleWaiters.add(resolve)
      })
    },
  } satisfies PendingResponseRepairOwner & { whenIdle: () => Promise<void> }
}
