export function createSessionVcsRefreshController(input: {
  visible: () => boolean
  identity: () => string
  request: () => Promise<unknown>
  delayMs?: number
}) {
  let dirty = true
  let inFlight = false
  let retryBlocked = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const schedule = () => {
    if (disposed || retryBlocked || !dirty || inFlight || !input.visible() || timer !== undefined) return
    timer = setTimeout(run, input.delayMs ?? 100)
  }
  const run = () => {
    timer = undefined
    if (disposed || retryBlocked || !dirty || inFlight || !input.visible()) return
    const identity = input.identity()
    dirty = false
    inFlight = true
    void input.request().then(
      () => {
        inFlight = false
        if (disposed) return
        // An invalidation that raced this successful request is still pending.
        if (dirty) schedule()
      },
      () => {
        inFlight = false
        if (disposed) return
        // A failure for an obsolete directory/branch must not poison the new
        // identity. For the current identity, retain dirtiness but block
        // automatic retries until a new invalidation or visibility transition.
        if (input.identity() === identity) {
          dirty = true
          retryBlocked = true
          return
        }
        dirty = true
        retryBlocked = false
        schedule()
      },
    )
  }

  return {
    invalidate() {
      dirty = true
      retryBlocked = false
      schedule()
    },
    visibleChanged() {
      if (!input.visible()) return
      retryBlocked = false
      schedule()
    },
    state() {
      return { dirty, inFlight, retryBlocked, scheduled: timer !== undefined }
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
