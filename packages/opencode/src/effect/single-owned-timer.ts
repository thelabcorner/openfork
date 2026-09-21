import { Deferred, Effect, Fiber, Option, Ref, Scope, Semaphore } from "effect"

export interface SingleOwnedTimer {
  /** Replace any existing timer with exactly one new owned timer. */
  readonly arm: (delayMs: number, onExpire: Effect.Effect<void, never, never>) => Effect.Effect<void>
  /** Cancel the current timer, if any. */
  readonly cancel: () => Effect.Effect<void>
  /** 0 or 1 by construction. */
  readonly active: () => Effect.Effect<number>
}

/**
 * Process-local latency primitive only. Durable state must remain sufficient to
 * reconstruct the next deadline after restart. Epoch fencing prevents an old
 * callback from clearing/replacing a newer timer.
 */
export const make = Effect.fn("SingleOwnedTimer.make")(function* (name: string) {
  const scope = yield* Scope.Scope
  const state = yield* Ref.make({
    timer: Option.none<Fiber.Fiber<void>>(),
    epoch: 0,
  })
  const lock = Semaphore.makeUnsafe(1)

  const cancelUnlocked = Effect.fnUntraced(function* () {
    const previous = yield* Ref.get(state)
    yield* Ref.update(state, (current) => ({
      timer: Option.none(),
      epoch: current.epoch + 1,
    }))
    if (Option.isSome(previous.timer)) yield* Fiber.interrupt(previous.timer.value)
  })

  const cancel: SingleOwnedTimer["cancel"] = () => lock.withPermit(cancelUnlocked())

  const arm: SingleOwnedTimer["arm"] = (delayMs, onExpire) =>
    lock.withPermit(
      Effect.gen(function* () {
        const previous = yield* Ref.get(state)
        const epoch = previous.epoch + 1
        if (Option.isSome(previous.timer)) yield* Fiber.interrupt(previous.timer.value)

        // Prevent a zero-delay child from winning before its handle/epoch are
        // committed into State.
        const ready = yield* Deferred.make<void>()
        const fiber: Fiber.Fiber<void> = yield* Effect.gen(function* () {
          yield* Deferred.await(ready)
          yield* Effect.sleep(Math.max(0, delayMs))
          const owns = yield* Ref.modify(state, (current) => {
            if (current.epoch !== epoch) return [false, current] as const
            return [true, { ...current, timer: Option.none() }] as const
          })
          if (owns) yield* onExpire
        }).pipe(
          Effect.catchCause((cause) => Effect.logError(name + " timer failed", { cause })),
          Effect.forkIn(scope, { startImmediately: true }),
        )

        yield* Ref.set(state, { timer: Option.some(fiber), epoch })
        yield* Deferred.succeed(ready, undefined)
      }),
    )

  const active: SingleOwnedTimer["active"] = Effect.fn(name + ".activeTimerCount")(function* () {
    return Option.isSome((yield* Ref.get(state)).timer) ? 1 : 0
  })

  yield* Effect.addFinalizer(cancel)
  return { arm, cancel, active } satisfies SingleOwnedTimer
})
