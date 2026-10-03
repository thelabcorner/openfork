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
  })).pipe(Effect.ensuring(options.flush))
}
