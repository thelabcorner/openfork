export type LatestStateSendResult =
  | { status: "updated" }
  | { status: "superseded"; generation: number }
  | { status: "unsupported" }
  | { status: "deferred" }

export type LatestStateRequestOptions<T> = {
  key: (value: T) => string
  schedule: (run: () => Promise<void>, options: { signal: AbortSignal; key: string; kind: string }) => Promise<void>
  send: (value: T, signal: AbortSignal) => Promise<LatestStateSendResult>
  rebase?: (value: T, generation: number) => T | undefined
  promote: () => void
  signal?: AbortSignal
  kind: string
  onFailure?: (error: unknown) => void
  onBlocked?: (reason: string) => void
}

/**
 * Own one latest-state request for a shared remote resource.
 *
 * While admission is queued, the scheduled closure reads the newest desired
 * value when it starts. A newer value promotes that queue entry. If transport
 * has started, it is aborted before the latest value is sent. The server must
 * still fence requests by generation because abort can race with server apply.
 */
export function createLatestStateRequest<T>(options: LatestStateRequestOptions<T>) {
  let desired: T | undefined
  let desiredKey: string | undefined
  let acknowledgedKey: string | undefined
  let ready = false
  let unsupported = false
  let blocked: string | undefined
  let disposed = false
  let lifecycle = 0
  let pending:
    | {
        started: boolean
        controller: AbortController
        lifecycle: number
      }
    | undefined

  const pump = () => {
    if (disposed || !ready || unsupported || blocked || pending || desired === undefined || desiredKey === acknowledgedKey) return

    const controller = new AbortController()
    const abortFromOwner = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener("abort", abortFromOwner, { once: true })

    const job = {
      started: false,
      controller,
      lifecycle,
    }
    let failed = false
    let deferred = false
    pending = job
    void options
      .schedule(
        async () => {
          if (disposed || pending !== job || controller.signal.aborted) return
          job.started = true
          const value = desired
          const key = desiredKey
          if (value === undefined || key === undefined || key === acknowledgedKey) return
          const result = await options.send(value, controller.signal)
          if (result.status === "unsupported") {
            unsupported = true
            return
          }
          if (result.status === "deferred") {
            // A stale request may finish after its abort raced with transport.
            // Its deferral must not prevent the newer desired state from being
            // pumped when this job releases the single-flight slot.
            if (desiredKey === key) deferred = true
            return
          }
          if (result.status === "superseded") {
            const current = desired
            const rebased = current === undefined ? undefined : options.rebase?.(current, result.generation)
            if (rebased === undefined) {
              blocked = "server generation cannot be safely rebased"
              options.onBlocked?.(blocked)
              return
            }
            desired = rebased
            desiredKey = options.key(rebased)
            return
          }
          if (job.lifecycle === lifecycle && desiredKey === key) acknowledgedKey = key
        },
        { signal: controller.signal, key: options.kind, kind: options.kind },
      )
      .catch((error) => {
        if (!disposed && !controller.signal.aborted) {
          failed = true
          options.onFailure?.(error)
        }
      })
      .finally(() => {
        options.signal?.removeEventListener("abort", abortFromOwner)
        if (pending !== job) return
        pending = undefined
        if (!disposed && ready && !unsupported && !blocked && !failed && !deferred && desiredKey !== acknowledgedKey) pump()
      })
  }

  return {
    setDesired(value: T) {
      if (disposed) return
      const nextKey = options.key(value)
      if (desiredKey !== undefined && desiredKey !== nextKey && pending?.started) pending.controller.abort()
      desired = value
      desiredKey = nextKey
      if (pending && !pending.started) options.promote()
      pump()
    },
    setReady(value: boolean) {
      if (disposed || ready === value) return
      ready = value
      lifecycle++
      if (value) acknowledgedKey = undefined
      else pending?.controller.abort()
      pump()
    },
    retry: pump,
    block(reason: string) {
      if (disposed || blocked) return
      blocked = reason
      pending?.controller.abort()
      options.onBlocked?.(reason)
    },
    dispose() {
      if (disposed) return
      disposed = true
      ready = false
      lifecycle++
      pending?.controller.abort()
    },
    snapshot() {
      return {
        ready,
        unsupported,
        blocked,
        pending: pending !== undefined,
        pendingStarted: pending?.started ?? false,
        desiredKey,
        acknowledgedKey,
      }
    },
  }
}
