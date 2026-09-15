export type ServerRequestPriority = "critical" | "interactive" | "background"

export type ServerRequestSchedulerOptions = {
  /** Total requests admitted through this scheduler at once. */
  concurrency?: number
  /** Background work may never occupy more than this many scheduler slots. */
  backgroundConcurrency?: number
  /**
   * Background concurrency while foreground work is active or queued. This is
   * deliberately lower than the idle background ceiling: localhost requests
   * are cheap individually, but two speculative CPU/SQLite/config jobs can
   * still contend with the one request the user is waiting on. Defaults to one.
   */
  foregroundBackgroundConcurrency?: number
  /**
   * Slots kept unavailable to non-critical work so a late foreground request
   * can start immediately instead of merely becoming first in a saturated
   * queue. Defaults to one when concurrency > 1.
   */
  criticalReserve?: number
  /** Deterministic clock seam for tests/benchmarks. Defaults to performance.now. */
  now?: () => number
}

type DurationStats = {
  count: number
  totalMs: number
  maxMs: number
}

type QueueEntry<T> = {
  priority: ServerRequestPriority
  key?: string
  kind: string
  run: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  signal?: AbortSignal
  enqueuedAt: number
  abortListener?: () => void
}

const abortError = () => new DOMException("The request was aborted", "AbortError")

/**
 * Server-scoped request admission control.
 *
 * OpenCode has several independently-bounded producers (session hydration,
 * sidebar metadata, file-tree expansion, tab previews). Independent gates do
 * not compose: their aggregate can still fill every localhost HTTP connection
 * and make a user navigation wait behind speculative work.
 *
 * This scheduler provides one ordering point for those producers. Background
 * work is capped separately so it can use otherwise-idle transport capacity
 * without occupying the whole pool. Critical/interactive work always drains
 * before queued background work.
 *
 * The scheduler deliberately does not own the long-lived SSE stream. It gates
 * finite request/response work only.
 */
export function createServerRequestScheduler(options: ServerRequestSchedulerOptions = {}) {
  const now = options.now ?? (() => performance.now())
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 5))
  const backgroundConcurrency = Math.max(
    1,
    Math.min(concurrency - (concurrency > 1 ? 1 : 0), Math.floor(options.backgroundConcurrency ?? 2)),
  )
  const foregroundBackgroundConcurrency = Math.max(
    0,
    Math.min(backgroundConcurrency, Math.floor(options.foregroundBackgroundConcurrency ?? 1)),
  )
  const criticalReserve = Math.max(
    0,
    Math.min(concurrency > 1 ? concurrency - 1 : 0, Math.floor(options.criticalReserve ?? (concurrency > 1 ? 1 : 0))),
  )
  const nonCriticalConcurrency = concurrency - criticalReserve

  const queues: Record<ServerRequestPriority, QueueEntry<unknown>[]> = {
    critical: [],
    interactive: [],
    background: [],
  }
  const queuedByKey = new Map<string, Set<QueueEntry<unknown>>>()
  let active = 0
  let activeCritical = 0
  let activeInteractive = 0
  let activeBackground = 0
  let maxActive = 0
  let maxActiveBackground = 0
  let completed = 0
  let maxQueued = 0
  const waitTotal = { critical: 0, interactive: 0, background: 0 }
  const waitMax = { critical: 0, interactive: 0, background: 0 }
  const serviceTotal = { critical: 0, interactive: 0, background: 0 }
  const serviceMax = { critical: 0, interactive: 0, background: 0 }
  const activeByKind = new Map<string, number>()
  const queuedByKind = new Map<string, number>()
  const maxQueuedByKind = new Map<string, number>()
  const completedByKind = new Map<string, number>()
  const waitByKind = new Map<string, DurationStats>()
  const serviceByKind = new Map<string, DurationStats>()

  const bump = (map: Map<string, number>, key: string, delta: number) => {
    const next = (map.get(key) ?? 0) + delta
    if (next <= 0) map.delete(key)
    else map.set(key, next)
  }

  const observe = (map: Map<string, DurationStats>, key: string, ms: number) => {
    const current = map.get(key)
    if (!current) {
      map.set(key, { count: 1, totalMs: ms, maxMs: ms })
      return
    }
    current.count += 1
    current.totalMs += ms
    current.maxMs = Math.max(current.maxMs, ms)
  }

  const detachAbortListener = (entry: QueueEntry<unknown>) => {
    if (!entry.signal || !entry.abortListener) return
    entry.signal.removeEventListener("abort", entry.abortListener)
    entry.abortListener = undefined
  }

  const unindex = (entry: QueueEntry<unknown>) => {
    bump(queuedByKind, entry.kind, -1)
    detachAbortListener(entry)
    if (!entry.key) return
    const entries = queuedByKey.get(entry.key)
    if (!entries) return
    entries.delete(entry)
    if (entries.size === 0) queuedByKey.delete(entry.key)
  }

  const removeAbortedHead = (priority: ServerRequestPriority) => {
    const queue = queues[priority]
    while (queue[0]?.signal?.aborted) {
      const entry = queue.shift()!
      unindex(entry)
      entry.reject(abortError())
    }
  }

  const take = (): QueueEntry<unknown> | undefined => {
    removeAbortedHead("critical")
    if (queues.critical.length) {
      const entry = queues.critical.shift()!
      unindex(entry)
      return entry
    }

    removeAbortedHead("interactive")
    const activeNonCritical = activeInteractive + activeBackground
    if (queues.interactive.length && activeNonCritical < nonCriticalConcurrency) {
      const entry = queues.interactive.shift()!
      unindex(entry)
      return entry
    }

    removeAbortedHead("background")
    if (activeNonCritical >= nonCriticalConcurrency) return
    const foregroundPressure =
      activeCritical > 0 ||
      activeInteractive > 0 ||
      queues.critical.length > 0 ||
      queues.interactive.length > 0
    const backgroundLimit = foregroundPressure ? foregroundBackgroundConcurrency : backgroundConcurrency
    if (activeBackground >= backgroundLimit) return
    const entry = queues.background.shift()
    if (entry) unindex(entry)
    return entry
  }

  const pump = () => {
    while (active < concurrency) {
      const entry = take()
      if (!entry) return
      if (entry.signal?.aborted) {
        entry.reject(abortError())
        continue
      }

      active += 1
      bump(activeByKind, entry.kind, 1)
      if (entry.priority === "critical") activeCritical += 1
      if (entry.priority === "interactive") activeInteractive += 1
      if (entry.priority === "background") activeBackground += 1
      maxActive = Math.max(maxActive, active)
      maxActiveBackground = Math.max(maxActiveBackground, activeBackground)
      const startedAt = now()
      const waited = Math.max(0, startedAt - entry.enqueuedAt)
      waitTotal[entry.priority] += waited
      waitMax[entry.priority] = Math.max(waitMax[entry.priority], waited)
      observe(waitByKind, entry.kind, waited)
      const finish = () => {
        const serviceMs = Math.max(0, now() - startedAt)
        serviceTotal[entry.priority] += serviceMs
        serviceMax[entry.priority] = Math.max(serviceMax[entry.priority], serviceMs)
        observe(serviceByKind, entry.kind, serviceMs)
        active -= 1
        completed += 1
        bump(activeByKind, entry.kind, -1)
        bump(completedByKind, entry.kind, 1)
        if (entry.priority === "critical") activeCritical -= 1
        if (entry.priority === "interactive") activeInteractive -= 1
        if (entry.priority === "background") activeBackground -= 1
        // Release capacity and admit the next request before waking the caller
        // of this completed request. The old `.finally()` ordering resolved the
        // public promise first, leaving the scheduler artificially saturated for
        // an extra microtask under high request turnover.
        pump()
      }
      void Promise.resolve()
        .then(entry.run)
        .then(
          (value) => {
            finish()
            entry.resolve(value)
          },
          (error) => {
            finish()
            entry.reject(error)
          },
        )
    }
  }

  const schedule = <T>(
    priority: ServerRequestPriority,
    run: () => Promise<T>,
    options?: { signal?: AbortSignal; key?: string; kind?: string },
  ): Promise<T> => {
    const signal = options?.signal
    if (signal?.aborted) return Promise.reject(abortError())

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        priority,
        key: options?.key,
        kind: options?.kind ?? "other",
        run,
        resolve,
        reject,
        signal,
        enqueuedAt: now(),
      }
      queues[priority].push(entry as QueueEntry<unknown>)
      bump(queuedByKind, entry.kind, 1)
      maxQueuedByKind.set(entry.kind, Math.max(maxQueuedByKind.get(entry.kind) ?? 0, queuedByKind.get(entry.kind) ?? 0))
      maxQueued = Math.max(maxQueued, queues.critical.length + queues.interactive.length + queues.background.length)
      if (entry.key) {
        const indexed = queuedByKey.get(entry.key) ?? new Set<QueueEntry<unknown>>()
        indexed.add(entry as QueueEntry<unknown>)
        queuedByKey.set(entry.key, indexed)
      }

      if (signal) {
        const onAbort = () => {
          entry.abortListener = undefined
          const queue = queues[entry.priority]
          const index = queue.indexOf(entry as QueueEntry<unknown>)
          if (index < 0) return
          queue.splice(index, 1)
          unindex(entry as QueueEntry<unknown>)
          reject(abortError())
        }
        entry.abortListener = onAbort
        signal.addEventListener("abort", onAbort, { once: true })
        // This listener protects only the scheduler queue. Remove it as soon as
        // the request is admitted; keeping `{ once: true }` listeners attached
        // to a server-context AbortSignal until teardown retains every completed
        // QueueEntry for the lifetime of a long-running desktop session.
      }

      pump()
    })
  }

  const rank: Record<ServerRequestPriority, number> = { background: 0, interactive: 1, critical: 2 }
  const promote = (key: string, priority: ServerRequestPriority) => {
    const entries = queuedByKey.get(key)
    if (!entries) return false
    let changed = false
    for (const entry of [...entries]) {
      if (rank[entry.priority] >= rank[priority]) continue
      const queue = queues[entry.priority]
      const index = queue.indexOf(entry)
      if (index < 0) continue
      queue.splice(index, 1)
      entry.priority = priority
      queues[priority].push(entry)
      changed = true
    }
    if (!changed) return false
    pump()
    return true
  }

  return {
    schedule,
    promote,
    snapshot: () => ({
      active,
      activeCritical,
      activeInteractive,
      activeBackground,
      maxActive,
      maxActiveBackground,
      queuedCritical: queues.critical.length,
      queuedInteractive: queues.interactive.length,
      queuedBackground: queues.background.length,
      completed,
      maxQueued,
      waitTotal: { ...waitTotal },
      waitMax: { ...waitMax },
      serviceTotal: { ...serviceTotal },
      serviceMax: { ...serviceMax },
      activeByKind: Object.fromEntries(activeByKind),
      queuedByKind: Object.fromEntries(queuedByKind),
      maxQueuedByKind: Object.fromEntries(maxQueuedByKind),
      completedByKind: Object.fromEntries(completedByKind),
      waitByKind: Object.fromEntries([...waitByKind].map(([kind, stats]) => [kind, { ...stats }])),
      serviceByKind: Object.fromEntries([...serviceByKind].map(([kind, stats]) => [kind, { ...stats }])),
    }),
  }
}

export type ServerRequestScheduler = ReturnType<typeof createServerRequestScheduler>
