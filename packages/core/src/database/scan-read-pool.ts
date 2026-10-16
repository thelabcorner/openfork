import { Effect, Semaphore } from "effect"
import { boundedSqlitePermit } from "./sqlite-acquire-timeout"

/**
 * Bound active work and lease a single exclusive reader for the *entire*
 * callback, including all of its SQL statements and read transaction.
 *
 * A semaphore limits active callbacks, while the per-slot reservation keeps
 * connection identities stable even when a callback fails or is interrupted.
 * The producer owns the reader lifetime; this helper never closes readers.
 */
export function makeLeasedReaderPool<Reader>(
  capacity: number,
  open: (slot: number) => Effect.Effect<Reader>,
  admissionTimeoutMs = 3_000,
) {
  return Effect.gen(function* () {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 8)
      return yield* Effect.die(new Error("Reader pool capacity must be an integer from 1 to 8"))

    const admission = yield* Semaphore.make(capacity)
    const slots: Array<{ busy: boolean; reader?: Reader }> =
      Array.from({ length: capacity }, () => ({ busy: false }))

    const withLease = <A, E, R>(body: (reader: Reader) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        // Fail the queued caller promptly: an unconstrained backlog of agent
        // scans must not accumulate behind two expensive running statements.
        // The deadline applies ONLY to acquiring a lease, never its callback.
        boundedSqlitePermit(admission.take(1), admissionTimeoutMs, () =>
          ` scanPoolCapacity=${capacity} busy=${slots.filter((slot) => slot.busy).length}`,
        ).pipe(Effect.orDie),
        () => Effect.acquireUseRelease(
          Effect.sync(() => {
            // Synchronous reservation is atomic in the Effect JS runtime.
            const index = slots.findIndex((slot) => !slot.busy)
            if (index < 0) throw new Error("Reader pool slot invariant violated")
            slots[index]!.busy = true
            return index
          }),
          (index) => Effect.gen(function* () {
            const slot = slots[index]!
            const reader = slot.reader ?? (yield* open(index))
            // If opening fails/interruption occurs, this reservation is
            // released and the next call can retry. No broken reader is cached.
            slot.reader = reader
            return yield* body(reader)
          }),
          (index) => Effect.sync(() => { slots[index]!.busy = false }),
        ),
        () => admission.release(1),
      )

    return { withLease }
  })
}
