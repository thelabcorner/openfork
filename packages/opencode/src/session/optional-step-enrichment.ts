import { Effect, Fiber, Option } from "effect"

/**
 * Optional step enrichment must not keep the provider event waiting for
 * uninterruptible Git/process teardown. Only the Fiber.join is timed: the
 * capture's cancellation is requested asynchronously, without joining it.
 * Snapshot remains the sole owner of shadow-index and mutation-barrier locks.
 */
export function awaitOptionalStepEnrichment<A, E, R>(
  task: Effect.Effect<A, E, R>,
  timeoutMs = 30_000,
): Effect.Effect<Option.Option<A>, E, R> {
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkDetach(task)
    const cancel = () => Effect.forkDetach(Fiber.interrupt(fiber)).pipe(Effect.asVoid)
    const result = yield* Fiber.join(fiber).pipe(
      Effect.onInterrupt(cancel),
      Effect.timeoutOption(`${timeoutMs} millis`),
    )
    if (Option.isNone(result)) yield* cancel()
    return result
  })
}