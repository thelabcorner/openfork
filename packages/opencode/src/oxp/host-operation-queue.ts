/**
 * Serialize OXP host mutations while allowing adjacent, concurrent state
 * observers to share the same *in-flight* projection. No state survives the
 * projection's settlement, and any intervening mutation invalidates reuse.
 *
 * This is only a scheduling optimization: it never caches root verification,
 * grants, Session state, or anything across distinct state-read epochs.
 */
export function createHostOperationQueue<State>() {
  let tail: Promise<void> = Promise.resolve()
  let pendingRead: Promise<State> | undefined

  const enqueue = <A>(fn: () => Promise<A>): Promise<A> => {
    // A write or lifecycle operation queued after a read creates a new epoch.
    pendingRead = undefined
    const next = tail.then(fn, fn)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const read = (fn: () => Promise<State>): Promise<State> => {
    if (pendingRead) return pendingRead
    const next = enqueue(fn)
    pendingRead = next
    const clear = () => {
      if (pendingRead === next) pendingRead = undefined
    }
    // Handle both outcomes: never leave an orphan rejected finally() promise.
    void next.then(clear, clear)
    return next
  }

  return { enqueue, read }
}