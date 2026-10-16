/**
 * Only the latest mobile authentication attempt may commit state. An aborted
 * fetch may still settle later (or a test transport may ignore AbortSignal),
 * so callers must check current() after every asynchronous boundary.
 */
export function createAttemptGate() {
  let generation = 0
  let controller: AbortController | undefined

  const invalidate = () => {
    generation++
    controller?.abort()
    controller = undefined
  }

  return {
    invalidate,
    start() {
      invalidate()
      const own = generation
      const next = new AbortController()
      controller = next
      return {
        signal: next.signal,
        current: () => generation === own && !next.signal.aborted,
      }
    },
  }
}