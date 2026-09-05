export function createLatestWorkerQueue<T extends { key: string }>(input: {
  run: (request: T) => Promise<void>
  supersede: (request: T) => void
  dispose: (key: string) => void
  /** Maximum unread jobs retained for distinct keys. */
  maxPendingJobs?: number
}) {
  type Slot = { type: "highlight"; key: string; request?: T }
  type DisposeSlot = { type: "dispose"; key: string; cancelled: boolean }
  const jobs: Array<Slot | DisposeSlot> = []
  const slots = new Map<string, Slot>()
  const disposals = new Map<string, DisposeSlot>()
  let running: Promise<void> | undefined
  let cursor = 0
  const maxPendingJobs = Math.max(1, input.maxPendingJobs ?? 512)

  const enqueue = (job: Slot | DisposeSlot) => {
    if (jobs.length - cursor >= maxPendingJobs) {
      // Drop the oldest queued request first. A running job is never touched;
      // its result is still needed to release the worker's active slot. The
      // supersede callback rejects the corresponding main-thread promise so a
      // dropped parse/highlight cannot remain in a pending map forever.
      let index = jobs.findIndex((candidate, offset) => offset >= cursor && candidate.type === "highlight")
      if (index === -1) index = cursor
      const dropped = jobs.splice(index, 1)[0]
      if (!dropped) return false
      if (dropped.type === "highlight") {
        slots.delete(dropped.key)
        if (dropped.request) input.supersede(dropped.request)
      } else {
        dropped.cancelled = true
        disposals.delete(dropped.key)
      }
    }
    jobs.push(job)
    return true
  }

  const schedule = () => {
    if (running) return
    running = Promise.resolve()
      .then(async () => {
        let sliceStart = performance.now()
        while (cursor < jobs.length) {
          const job = jobs[cursor++]!
          if (job.type === "dispose") {
            disposals.delete(job.key)
            if (!job.cancelled) input.dispose(job.key)
            if (performance.now() - sliceStart >= 4) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0))
              sliceStart = performance.now()
            }
            continue
          }
          if (slots.get(job.key) === job) slots.delete(job.key)
          const request = job.request
          job.request = undefined
          if (request) await input.run(request)
          if (performance.now() - sliceStart >= 4) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
            sliceStart = performance.now()
          }
        }
      })
      .finally(() => {
        jobs.splice(0, cursor)
        cursor = 0
        running = undefined
        if (jobs.length > 0) schedule()
      })
  }

  return {
    highlight(request: T) {
      const slot = slots.get(request.key)
      if (slot) {
        if (slot.request) input.supersede(slot.request)
        slot.request = request
        return
      }
      const next: Slot = { type: "highlight", key: request.key, request }
      slots.set(request.key, next)
      if (!enqueue(next)) {
        slots.delete(request.key)
        input.supersede(request)
        return
      }
      schedule()
    },
    dispose(key: string) {
      const slot = slots.get(key)
      if (slot?.request) input.supersede(slot.request)
      if (slot) {
        slot.request = undefined
        slots.delete(key)
      }
      const existing = disposals.get(key)
      if (existing) return
      const disposal: DisposeSlot = { type: "dispose", key, cancelled: false }
      disposals.set(key, disposal)
      enqueue(disposal)
      schedule()
    },
    pending: () => slots.size,
    async idle() {
      while (running) await running
    },
  }
}
