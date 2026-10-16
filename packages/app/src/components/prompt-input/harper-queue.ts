/**
 * Shared bounded, latest-only scheduler for local grammar work.
 *
 * A single worker cannot physically interrupt a running synchronous WASM lint,
 * but we can immediately reject obsolete callers, cancel never-started work,
 * and guarantee that an old result cannot start another obsolete job.
 *
 * Each owner has at most one queued request. Different composers use distinct
 * symbols so the queue is fair across sessions. No prompt is persisted.
 */
export function harperCancelled(message = "Harper request superseded"): Error {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

type Request<Input, Output> = {
  owner: symbol
  input: Input | undefined
  signal?: AbortSignal
  resolve: (value: Output) => void
  reject: (error: Error) => void
  onAbort: () => void
  settled: boolean
}

export class HarperLatestQueue<Input, Output> {
  private active: Request<Input, Output> | undefined
  private pending = new Map<symbol, Request<Input, Output>>()
  private disposed = false

  constructor(
    private readonly execute: (input: Input) => Promise<Output>,
    private readonly maxPending = 12,
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error("Harper queue requires positive pending capacity")
    }
  }

  get stats() {
    return { active: this.active ? 1 : 0, pending: this.pending.size }
  }

  run(owner: symbol, input: Input, signal?: AbortSignal): Promise<Output> {
    if (this.disposed) return Promise.reject(harperCancelled("Harper worker disposed"))
    if (signal?.aborted) return Promise.reject(harperCancelled())

    return new Promise((resolve, reject) => {
      const request: Request<Input, Output> = {
        owner,
        input,
        signal,
        resolve,
        reject,
        settled: false,
        onAbort: () => this.cancel(request, harperCancelled()),
      }
      // The old active WASM job remains in flight but its caller is released
      // immediately; the replacement is parked until the worker is free.
      if (this.active?.owner === owner) this.cancel(this.active, harperCancelled())
      const former = this.pending.get(owner)
      if (former) this.cancel(former, harperCancelled())
      signal?.addEventListener("abort", request.onAbort, { once: true })
      this.pending.set(owner, request)
      while (this.pending.size > this.maxPending) {
        const oldest = this.pending.values().next().value
        if (!oldest) break
        this.cancel(oldest, harperCancelled("Harper queue at capacity"))
      }
      this.pump()
    })
  }

  cancelOwner(owner: symbol) {
    const pending = this.pending.get(owner)
    if (pending) this.cancel(pending, harperCancelled())
    if (this.active?.owner === owner) this.cancel(this.active, harperCancelled())
  }

  private settle(request: Request<Input, Output>, result: { value: Output } | { error: Error }) {
    if (request.settled) return
    request.settled = true
    request.input = undefined
    request.signal?.removeEventListener("abort", request.onAbort)
    if ("error" in result) request.reject(result.error)
    else request.resolve(result.value)
  }

  private cancel(request: Request<Input, Output>, reason: Error) {
    if (this.pending.get(request.owner) === request) this.pending.delete(request.owner)
    this.settle(request, { error: reason })
    // The active task can only finish naturally, but its stale response is
    // ignored. New queued work begins when that physical operation completes.
  }

  private pump() {
    if (this.active || this.disposed) return
    const request = this.pending.values().next().value
    if (!request) return
    this.pending.delete(request.owner)
    if (request.settled || request.input === undefined) {
      this.pump()
      return
    }
    this.active = request
    const input = request.input
    // Run in a microtask so a burst of synchronous keystroke state changes
    // can replace this request before we post anything to the worker.
    void Promise.resolve().then(() => {
      if (request.settled || this.disposed) throw harperCancelled()
      return this.execute(input)
    }).then(
      (value) => this.settle(request, { value }),
      (error: unknown) => this.settle(request, { error: error instanceof Error ? error : new Error(String(error)) }),
    ).finally(() => {
      if (this.active === request) this.active = undefined
      this.pump()
    })
  }

  dispose(reason = harperCancelled("Harper worker disposed")) {
    if (this.disposed) return
    this.disposed = true
    if (this.active) this.cancel(this.active, reason)
    for (const request of this.pending.values()) this.settle(request, { error: reason })
    this.pending.clear()
  }
}
