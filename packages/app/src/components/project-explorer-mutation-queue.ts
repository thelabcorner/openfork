/**
 * Backpressured filesystem-operation admission owned by the Project Explorer.
 * This is a bounded renderer queue around the authoritative FileOpsPort,
 * never a second filesystem executor.
 *
 * Success means that the backend Promise actually resolved, not that the
 * request was merely admitted. Cancellation/disposal prevents queued work
 * from starting and resolves all remaining admission receipts with false.
 */
export function createProjectExplorerMutationQueue(options: {
  concurrency?: number
  maxQueued?: number
  onError?: (error: unknown) => void
  onOverflow?: () => void
}) {
  type Job = { run: () => Promise<unknown>; settle: (ok: boolean) => void }
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2))
  const maxQueued = Math.max(1, Math.floor(options.maxQueued ?? 512))
  const waiting: Job[] = []
  const running = new Set<Job>()
  let active = 0
  let disposed = false
  let overflowNotified = false
  const pump = () => {
    while (!disposed && active < concurrency && waiting.length) {
      const job = waiting.shift()!
      active++
      running.add(job)
      void Promise.resolve()
        .then(job.run)
        .then(
          () => job.settle(!disposed),
          (error) => {
            job.settle(false)
            if (disposed) return
            try { options.onError?.(error) } catch { /* reporting cannot stall queue */ }
          },
        )
        .finally(() => {
          running.delete(job)
          active--
          if (waiting.length < maxQueued / 2) overflowNotified = false
          pump()
        })
    }
  }

  const enqueue = (run: () => Promise<unknown>): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    if (waiting.length >= maxQueued) {
      if (!overflowNotified) {
        overflowNotified = true
        options.onOverflow?.()
      }
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      waiting.push({ run, settle: resolve })
      pump()
    })
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const job of waiting.splice(0)) job.settle(false)
    // An underlying filesystem Promise may hang indefinitely. We cannot
    // force-cancel a backend that lacks abort semantics, but panel teardown
    // must still release every producer awaiting an admission receipt.
    for (const job of running) job.settle(false)
  }
  return {
    enqueue,
    dispose,
    get active() { return active },
    get queued() { return waiting.length },
    get disposed() { return disposed },
  }
}
