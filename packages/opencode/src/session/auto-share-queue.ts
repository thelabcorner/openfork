import { Effect, Queue, Scope } from "effect"

export interface Task {
  readonly sessionID: string
}

export interface Owner<T extends Task> {
  /** Returns false only when the bounded best-effort backlog is full. */
  readonly offer: (task: T) => Effect.Effect<boolean>
}

/** One scoped worker with bounded queued work and exact-session deduplication. */
export function make<T extends Task>(input: {
  readonly capacity: number
  readonly run: (task: T) => Effect.Effect<void>
}): Effect.Effect<Owner<T>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.dropping<T>(input.capacity)
    const pending = new Set<string>()
    const scope = yield* Scope.Scope

    const worker = Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap((task) =>
          input.run(task).pipe(
            Effect.catchCause((cause) => Effect.logWarning("auto-share worker failed", { sessionID: task.sessionID, cause })),
            Effect.ensuring(Effect.sync(() => pending.delete(task.sessionID))),
          ),
        ),
      ),
    )
    yield* worker.pipe(Effect.forkIn(scope, { startImmediately: true }))

    return {
      offer: Effect.fn("SessionAutoShareQueue.offer")(function* (task: T) {
        if (pending.has(task.sessionID)) return true
        pending.add(task.sessionID)
        const accepted = yield* Queue.offer(queue, task)
        if (!accepted) pending.delete(task.sessionID)
        return accepted
      }),
    }
  })
}
