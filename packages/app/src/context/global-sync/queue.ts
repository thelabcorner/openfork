type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
}

export function createRefreshQueue(input: QueueInput) {
  const queued = new Map<string, string>()
  let root = false
  let running = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const key = input.key ?? ((directory: string) => directory)

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items: string[] = []
    for (const [id, directory] of queued) {
      queued.delete(id)
      items.push(directory)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (disposed || running || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string) => {
    if (disposed || !directory) return
    queued.set(key(directory), directory)
    if (input.paused()) return
    schedule()
  }

  const refresh = () => {
    if (disposed) return
    root = true
    if (input.paused()) return
    schedule()
  }

  async function drain() {
    if (disposed || running) return
    running = true
    try {
      while (true) {
        if (disposed || input.paused()) return
        if (root) {
          root = false
          await Promise.resolve()
            .then(input.bootstrap)
            .catch((error) => console.error("[refresh-queue] bootstrap failed", error))
          await tick()
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        // Wait for every in-flight directory, including when one fails. Otherwise
        // the next batch overlaps surviving requests and defeats the limit of two.
        const results = await Promise.allSettled(
          dirs.map((dir) => Promise.resolve().then(() => input.bootstrapInstance(dir))),
        )
        for (const result of results) {
          if (result.status === "rejected") console.error("[refresh-queue] directory bootstrap failed", result.reason)
        }
        await tick()
      }
    } finally {
      running = false
      if (!disposed && !input.paused() && (root || queued.size)) schedule()
    }
  }

  return {
    push,
    refresh,
    clear(directory: string) {
      queued.delete(key(directory))
    },
    dispose() {
      disposed = true
      queued.clear()
      root = false
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
