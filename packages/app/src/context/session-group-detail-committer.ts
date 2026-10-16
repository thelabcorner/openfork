/**
 * Progressive batching for legacy SessionGroup detail APIs. One store update
 * per row is quadratic; waiting for an entire 1,000-group fallback starves
 * the inspector when one legacy request is slow. Publish up to 32 completions
 * together, with a bounded first-result delay and no timer at rest.
 */
export function createSessionGroupDetailCommitter<T>(input: {
  valid: () => boolean
  publish: (details: readonly T[]) => void
  maxBatch?: number
  delayMs?: number
}) {
  const maxBatch = Math.max(1, Math.floor(input.maxBatch ?? 32))
  const delayMs = input.delayMs ?? 75
  const pending: T[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  const clear = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  const flush = () => {
    clear()
    if (!input.valid() || !pending.length) {
      pending.length = 0
      return
    }
    const batch = pending.splice(0, pending.length)
    input.publish(batch)
  }
  return {
    add(item: T) {
      if (finished || !input.valid()) return
      pending.push(item)
      if (pending.length >= maxBatch) {
        flush()
      } else if (timer === undefined) {
        timer = setTimeout(flush, delayMs)
      }
    },
    finish() {
      if (finished) return
      finished = true
      flush()
    },
    cancel() {
      finished = true
      pending.length = 0
      clear()
    },
  }
}