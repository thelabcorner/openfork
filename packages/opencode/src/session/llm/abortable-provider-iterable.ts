/**
 * An AI SDK stream is allowed to be slow to produce tokens, but it must not
 * trap the Session's host-side cancellation in a hung AsyncIterator.return().
 *
 * Provider transport abort MUST precede iterator teardown: awaiting return()
 * first can deadlock with the SDK waiting for the network reader to settle.
 * Keep the wrapper local to one physical LLM attempt. This does not change
 * request payload, remote provider contracts or ordinary next() semantics.
 */
export function abortableProviderIterable<A>(
  source: AsyncIterable<A>,
  controller: AbortController,
  closeTimeoutMs = 1_000,
): AsyncIterable<A> {
  const budget = Number.isFinite(closeTimeoutMs) && closeTimeoutMs > 0
    ? Math.floor(closeTimeoutMs)
    : 1_000
  return {
    [Symbol.asyncIterator]() {
      const sourceIterator = source[Symbol.asyncIterator]()
      let closed = false
      let exhausted = false
      return {
        next: async () => {
          const item = await sourceIterator.next()
          if (item.done) exhausted = true
          return item
        },
        async return(): Promise<IteratorResult<A>> {
          if (closed) return { done: true, value: undefined }
          closed = true
          // Effect's Stream.fromAsyncIterable calls return() even after
          // next() naturally returned done. That is NOT host cancellation:
          // aborting here would erase the evidence of a premature provider
          // EOF before the terminal-finish fence inspects the signal.
          if (exhausted) return { done: true, value: undefined }
          // Only an early consumer exit actually cancels provider transport.
          // Abort before waiting on a potentially hung SDK teardown.
          controller.abort()
          if (!sourceIterator.return) return { done: true, value: undefined }
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            const result = await Promise.race([
              Promise.resolve().then(() => sourceIterator.return!()),
              new Promise<IteratorResult<A>>((resolve) => {
                timeout = setTimeout(() => resolve({ done: true, value: undefined }), budget)
              }),
            // The caller explicitly closed this iterator. AbortError or
            // teardown failure after closure is not a new provider response
            // failure and must not override an already-consumed 'finish'.
            ]).catch((): IteratorResult<A> => ({ done: true, value: undefined }))
            return result
          } finally {
            if (timeout !== undefined) clearTimeout(timeout)
          }
        },
        throw: (error?: unknown) => sourceIterator.throw
          ? sourceIterator.throw(error)
          : Promise.reject(error),
      }
    },
  }
}
