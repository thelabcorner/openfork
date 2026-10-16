import { Effect, Queue, Stream } from "effect"

/**
 * One serial consumer owns provider events and delta publication. An alarm is
 * armed only while unpublished deltas exist; provider silence cannot strand a
 * fragment. The alarm never publishes concurrently with an event/boundary.
 * Its scope ends with the physical provider attempt, including interruption.
 */
export function consumeWithFlushDeadline<A, E, R, E2, R2>(
  stream: Stream.Stream<A, E, R>,
  options: {
    readonly delayMs: number
    /** Cleanup of an interrupted provider must not wait indefinitely for SSE publication. */
    readonly finalFlushTimeoutMs?: number
    readonly consume: (event: A) => Effect.Effect<void, E2, R2>
    readonly pending: () => boolean
    readonly flush: Effect.Effect<void, never, R2>
    readonly stop: () => boolean
  },
): Effect.Effect<void, E | E2, R | R2> {
  return Effect.scoped(Effect.gen(function* () {
    const alarms = yield* Queue.bounded<{ readonly flush: true }>(1)
    let armed = false
    const input = Stream.merge(
      stream.pipe(Stream.map((event) => ({ event }))),
      Stream.fromQueue(alarms),
      { haltStrategy: "left" },
    )
    yield* input.pipe(
      Stream.tap((item) => Effect.gen(function* () {
        if ("event" in item) yield* options.consume(item.event)
        else {
          armed = false
          yield* options.flush
        }
        if (!armed && options.pending()) {
          armed = true
          yield* Effect.sleep(options.delayMs).pipe(
            Effect.andThen(Queue.offer(alarms, { flush: true })),
            Effect.forkScoped,
          )
        }
      })),
      Stream.takeUntil(() => options.stop()),
      Stream.runDrain,
    )
  })).pipe(Effect.ensuring(
    Effect.gen(function* () {
      // The stream can be interrupted *because* its serial flush operation
      // stalled. Running that identical effect as an unbounded, effectively
      // uninterruptible finalizer makes the provider watchdog incapable of
      // settling the attempt. Cleanup persists the last full parts separately;
      // this publication-only finalizer is best effort.
      if (!options.pending()) return
      const budget = Math.max(1, options.finalFlushTimeoutMs ?? 2_000)
      const flushed = yield* options.flush.pipe(
        Effect.interruptible,
        Effect.timeoutOption(`${budget} millis`),
      )
      if (flushed._tag === "None") {
        yield* Effect.logWarning("provider delta flush finalizer timed out", { timeoutMs: budget })
      }
    }),
  ))
}
