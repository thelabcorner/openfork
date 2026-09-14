export function createWorkerTransport<T extends { id: number; key: string }>(input: {
  post: (request: T) => void
  supersede: (request: T) => void
  maxActive?: number
  maxQueued?: number
  /** Stable worker/lane identity for this request. */
  laneOf?: (request: T) => string | number
  /** Maximum requests posted concurrently to one serial worker lane. */
  maxActivePerLane?: number
}) {
  const active = new Map<string, T>()
  const queued = new Map<string, T>()
  // One transport instance feeds one serial queue inside one Web Worker lane.
  // Posting several distinct keys at once cannot create CPU parallelism; it
  // only moves FIFO backlog across the thread boundary, where newer requests
  // can no longer supersede/dispose them before structured-clone + dispatch.
  // Keep exactly one request in flight by default and retain the override for
  // transports that genuinely target a parallel backend.
  const maxActive = Math.max(1, input.maxActive ?? 1)
  const maxQueued = Math.max(1, input.maxQueued ?? 512)
  const maxActivePerLane = Math.max(1, input.maxActivePerLane ?? maxActive)
  const activeByLane = new Map<string | number, number>()

  const laneOf = (request: T) => input.laneOf?.(request) ?? 0
  const laneAvailable = (request: T) => (activeByLane.get(laneOf(request)) ?? 0) < maxActivePerLane
  const markActive = (request: T) => {
    const lane = laneOf(request)
    activeByLane.set(lane, (activeByLane.get(lane) ?? 0) + 1)
  }
  const unmarkActive = (request: T) => {
    const lane = laneOf(request)
    const next = (activeByLane.get(lane) ?? 0) - 1
    if (next > 0) activeByLane.set(lane, next)
    else activeByLane.delete(lane)
  }

  const post = (key: string, request: T) => {
    active.set(key, request)
    markActive(request)
    input.post(request)
  }

  const dispatch = () => {
    while (active.size < maxActive && queued.size > 0) {
      let first: [string, T] | undefined
      for (const entry of queued) {
        if (!laneAvailable(entry[1])) continue
        first = entry
        break
      }
      // All queued requests target lanes that are already busy. Leave them on
      // the main side where a newer request for the same key can supersede them.
      if (!first) return
      const [key, request] = first
      queued.delete(key)
      post(key, request)
    }
  }

  const enqueue = (request: T) => {
    if (queued.size >= maxQueued) {
      const oldest = queued.entries().next().value as [string, T] | undefined
      if (!oldest) return false
      queued.delete(oldest[0])
      input.supersede(oldest[1])
    }
    queued.set(request.key, request)
    return true
  }

  return {
    send(request: T) {
      const queuedPrevious = queued.get(request.key)
      if (queuedPrevious) {
        queued.delete(request.key)
        input.supersede(queuedPrevious)
      }
      if (active.has(request.key)) {
        enqueue(request)
        return
      }
      if (active.size < maxActive && laneAvailable(request)) {
        post(request.key, request)
        return
      }
      enqueue(request)
    },
    complete(key: string, id: number) {
      const request = active.get(key)
      if (request?.id !== id) return
      active.delete(key)
      unmarkActive(request)
      dispatch()
    },
    dispose(key: string) {
      const current = active.get(key)
      if (current) {
        active.delete(key)
        unmarkActive(current)
      }
      const request = queued.get(key)
      if (request) input.supersede(request)
      queued.delete(key)
      dispatch()
    },
    reset() {
      queued.forEach(input.supersede)
      queued.clear()
      active.clear()
      activeByLane.clear()
    },
    queued: () => queued.size,
  }
}
