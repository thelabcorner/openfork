// Bounds concurrent execution of a class of async tasks (e.g. per-session sync
// requests). Existing per-key dedup (runInflight in server-session.ts) already
// prevents the SAME session from firing twice concurrently, and every write
// is keyed by sessionID so a late response can never overwrite a different
// session's state -- there is no correctness race here. The problem this
// solves is pile-up: rapidly spam-switching through N distinct tabs fires N
// concurrent HTTP request pairs that all run to completion uncancelled,
// competing for the connection pool and adding load exactly when the app is
// least able to spare it (mid-navigation). Nothing is dropped -- a queued
// task still eventually runs, since a background tab's data stays useful
// once revisited -- it's just deferred until a concurrency slot frees up.
//
// Newest-request-priority: a task that has to wait joins the FRONT of the
// queue, not the back. If the user is rapidly re-clicking through tabs, the
// tab they're on RIGHT NOW should not be stuck behind a backlog of older
// clicks they've already moved past.
export function createRequestGate(maxConcurrent: number) {
  let active = 0
  const queue: Array<() => void> = []

  const drain = () => {
    if (active >= maxConcurrent) return
    const next = queue.shift()
    if (next) next()
  }

  return function gated<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++
        task().then(
          (value) => {
            active--
            resolve(value)
            drain()
          },
          (error) => {
            active--
            reject(error)
            drain()
          },
        )
      }
      if (active < maxConcurrent) run()
      else queue.unshift(run)
    })
  }
}
