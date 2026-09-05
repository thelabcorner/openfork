export function createWorkerTransport<T extends { id: number; key: string }>(input: {
  post: (request: T) => void
  supersede: (request: T) => void
  maxActive?: number
  maxQueued?: number
}) {
  const active = new Map<string, T>()
  const queued = new Map<string, T>()
  const maxActive = Math.max(1, input.maxActive ?? 4)
  const maxQueued = Math.max(1, input.maxQueued ?? 512)

  const dispatch = () => {
    while (active.size < maxActive && queued.size > 0) {
      const first = queued.entries().next().value as [string, T] | undefined
      if (!first) return
      const [key, request] = first
      queued.delete(key)
      active.set(key, request)
      input.post(request)
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
      if (active.size < maxActive) {
        active.set(request.key, request)
        input.post(request)
        return
      }
      enqueue(request)
    },
    complete(key: string, id: number) {
      if (active.get(key)?.id !== id) return
      active.delete(key)
      dispatch()
    },
    dispose(key: string) {
      active.delete(key)
      const request = queued.get(key)
      if (request) input.supersede(request)
      queued.delete(key)
      dispatch()
    },
    reset() {
      queued.forEach(input.supersede)
      queued.clear()
      active.clear()
    },
    queued: () => queued.size,
  }
}
