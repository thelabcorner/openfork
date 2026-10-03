export type MarkdownWorkPriority = "background" | "visible" | "tail"

/** Keep all optional/background work off the lane used by selected and live content. */
export function markdownLaneForPriority(key: string, priority: MarkdownWorkPriority, lanes: number) {
  if (priority !== "background") return Math.max(0, lanes - 1)
  const backgroundLanes = Math.max(1, lanes - 1)
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % backgroundLanes
}

const PRIORITY: Record<MarkdownWorkPriority, number> = { background: 0, visible: 1, tail: 2 }

type Job<T extends { id: number; key: string }> = {
  request: T
  lane: number
  kind: string
  priority: MarkdownWorkPriority
  bytes: number
  order: number
  enqueuedAt: number
  post: (request: T) => void
  supersede: (request: T) => void
}

/** One admission owner for all request kinds targeting the same serial workers. */
export function createMarkdownWorkerAdmission<T extends { id: number; key: string }>(input: {
  lanes: number
  maxQueued?: number
  maxQueuedBytes?: number
  maxJobBytes?: number
  now?: () => number
}) {
  const queue: Job<T>[] = []
  const active = new Map<number, Job<T>>()
  const activeByLane = new Map<number, number>()
  const maxQueued = Math.max(1, input.maxQueued ?? 128)
  const maxQueuedBytes = Math.max(1, input.maxQueuedBytes ?? 16 * 1024 * 1024)
  const maxJobBytes = Math.max(1, input.maxJobBytes ?? 16 * 1024 * 1024)
  const now = input.now ?? (() => performance.now())
  let sequence = 0
  let queuedBytes = 0
  let activeBytes = 0
  let tailStreak = 0

  const removeQueued = (job: Job<T>) => {
    const index = queue.indexOf(job)
    if (index < 0) return false
    queue.splice(index, 1)
    queuedBytes -= job.bytes
    return true
  }

  const supersede = (job: Job<T>) => {
    if (removeQueued(job)) job.supersede(job.request)
  }

  const coalesceQueued = (job: Job<T>) => {
    for (const previous of [...queue]) {
      if (previous.kind === job.kind && previous.request.key === job.request.key) supersede(previous)
    }
  }

  const effectivePriority = (job: Job<T>, time: number) =>
    Math.min(2, PRIORITY[job.priority] + Math.floor(Math.max(0, time - job.enqueuedAt) / 750))

  const choose = (lane: number) => {
    const candidates = queue.filter((job) => job.lane === lane)
    if (!candidates.length) return
    const time = now()
    const highest = Math.max(...candidates.map((job) => effectivePriority(job, time)))
    const eligible = candidates.filter((job) => effectivePriority(job, time) === highest)
    // Tail work gets four consecutive admissions at most while ordinary work
    // waits. Aging eventually promotes background work, so it cannot starve.
    const nonTail = eligible.filter((job) => job.priority !== "tail")
    if (tailStreak >= 4 && nonTail.length) return nonTail.sort((a, b) => a.order - b.order)[0]
    return eligible.sort((a, b) => a.order - b.order)[0]
  }

  const dispatch = () => {
    for (let lane = 0; lane < input.lanes; lane++) {
      if (activeByLane.has(lane)) continue
      const job = choose(lane)
      if (!job) continue
      removeQueued(job)
      active.set(job.request.id, job)
      activeByLane.set(lane, job.request.id)
      activeBytes += job.bytes
      if (job.priority === "tail") tailStreak++
      else tailStreak = 0
      job.post(job.request)
    }
  }

  const evictFor = (bytes: number, priority: MarkdownWorkPriority) => {
    while (queue.length >= maxQueued || queuedBytes + bytes > maxQueuedBytes) {
      if (!queue.length) return false
      const oldestLowest = [...queue].sort((a, b) => {
        const byPriority = PRIORITY[a.priority] - PRIORITY[b.priority]
        return byPriority || a.order - b.order
      })[0]!
      // Admission pressure must not let low-priority arrivals displace work
      // that is more important to the currently visible surface.
      if (PRIORITY[oldestLowest.priority] > PRIORITY[priority]) return false
      supersede(oldestLowest)
    }
    return true
  }

  return {
    send(request: T, options: {
      lane: number
      kind: string
      priority: MarkdownWorkPriority
      bytes: number
      post: (request: T) => void
      supersede: (request: T) => void
    }) {
      const bytes = Math.max(0, options.bytes)
      if (bytes > maxJobBytes) {
        options.supersede(request)
        return false
      }
      coalesceQueued({
        request,
        lane: options.lane,
        kind: options.kind,
        priority: options.priority,
        bytes,
        order: sequence,
        enqueuedAt: now(),
        post: options.post,
        supersede: options.supersede,
      })
      if (!evictFor(bytes, options.priority)) {
        options.supersede(request)
        return false
      }
      queue.push({
        request,
        lane: options.lane,
        kind: options.kind,
        priority: options.priority,
        bytes,
        order: sequence++,
        enqueuedAt: now(),
        post: options.post,
        supersede: options.supersede,
      })
      queuedBytes += bytes
      dispatch()
      return true
    },
    complete(id: number) {
      const job = active.get(id)
      if (!job) return
      active.delete(id)
      activeBytes -= job.bytes
      if (activeByLane.get(job.lane) === id) activeByLane.delete(job.lane)
      dispatch()
    },
    dispose(key: string, kind?: string) {
      for (const job of [...queue]) {
        if (job.request.key === key && (kind === undefined || job.kind === kind)) supersede(job)
      }
      dispatch()
    },
    reset(kind?: string) {
      for (const job of [...queue]) {
        if (kind === undefined || job.kind === kind) supersede(job)
      }
      for (const [id, job] of [...active]) {
        if (kind !== undefined && job.kind !== kind) continue
        active.delete(id)
        activeBytes -= job.bytes
        if (activeByLane.get(job.lane) === id) activeByLane.delete(job.lane)
      }
      dispatch()
    },
    snapshot: () => ({ queued: queue.length, queuedBytes, active: active.size, activeBytes }),
  }
}
