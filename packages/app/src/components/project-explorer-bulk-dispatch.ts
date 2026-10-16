/**
 * Bounded, backpressured bulk filesystem action dispatch.
 *
 * A producer never puts more than one chunk into the panel's request queue at
 * once. Earlier fire-and-forget timers could push thousands of requests into
 * the 512-item queue, silently dropping everything after the limit.
 */
export async function dispatchProjectExplorerBulk<T>(
  items: readonly T[],
  dispatch: (item: T) => void | boolean | Promise<void | boolean>,
  options: {
    cancelled: () => boolean
    chunkSize?: number
    yield?: () => Promise<void>
  },
) {
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 32))
  const yieldTurn = options.yield ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  let dispatched = 0
  while (dispatched < items.length && !options.cancelled()) {
    const end = Math.min(items.length, dispatched + chunkSize)
    const batch: Promise<void | boolean>[] = []
    while (dispatched < end) {
      if (options.cancelled()) break
      const item = items[dispatched++]!
      batch.push(Promise.resolve().then(() => dispatch(item)))
    }
    const results = await Promise.allSettled(batch)
    // False means the downstream bounded queue explicitly rejected a job.
    // Do not keep dispatching a remainder that cannot be admitted.
    if (results.some((result) => result.status === "rejected" || result.value === false)) break
    if (dispatched < items.length && !options.cancelled()) await yieldTurn()
  }
  return dispatched
}
