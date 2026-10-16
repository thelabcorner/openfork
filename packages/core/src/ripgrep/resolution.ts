import { Cause, Effect, Exit, Semaphore } from "effect"

/**
 * Share one binary-install attempt across concurrent consumers, while caching
 * success indefinitely but a transient failure only for a bounded cooldown.
 * Every retry first probes the filesystem so an externally installed binary
 * immediately restores functionality without restarting the service.
 */
export function makeRecoverableResolution<A>(
  probe: Effect.Effect<A | undefined>,
  install: Effect.Effect<A, Error>,
  cooldownMs = 10_000,
): Effect.Effect<Effect.Effect<A, Error>> {
  return Effect.gen(function* () {
    const admission = yield* Semaphore.make(1)
    let installed: A | undefined
    let previous: { readonly at: number; readonly error: Error } | undefined
    return Effect.suspend(() => {
      if (installed !== undefined) return Effect.succeed(installed)
      return admission.withPermit(Effect.gen(function* () {
        if (installed !== undefined) return installed
        const existing = yield* probe
        if (existing !== undefined) {
          installed = existing
          previous = undefined
          return existing
        }
        if (previous && performance.now() - previous.at < cooldownMs)
          return yield* Effect.fail(previous.error)

        const outcome = yield* Effect.exit(install)
        if (Exit.isSuccess(outcome)) {
          installed = outcome.value
          previous = undefined
          return outcome.value
        }
        if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.failCause(outcome.cause)
        const original = Cause.squash(outcome.cause)
        const error = original instanceof Error ? original : new Error(String(original))
        previous = { at: performance.now(), error }
        return yield* Effect.fail(error)
      })).pipe(Effect.interruptible)
    })
  })
}