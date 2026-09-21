import { Effect, Ref, Scope, Semaphore } from "effect"

export interface CoalescedDrain {
  /** Level-triggered wake: concurrent/burst wakes collapse into one fresh drain. */
  readonly wake: () => Effect.Effect<void>
  /** 0 or 1 — this primitive never overlaps drains. */
  readonly active: () => Effect.Effect<number>
}

/**
 * Process-local latency primitive only. Correctness must remain in durable
 * state queried by `drain`; this helper merely coalesces wake storms and
 * guarantees one active drain at a time.
 */
export const make = Effect.fn("CoalescedDrain.make")(function* (input: {
  readonly name: string
  readonly drain: Effect.Effect<void, never, never>
  readonly onCause?: (cause: unknown) => Effect.Effect<void, never, never>
}) {
  const scope = yield* Scope.Scope
  const state = yield* Ref.make({ running: false, wakePending: false })
  const wakeLock = Semaphore.makeUnsafe(1)

  const execute = input.drain.pipe(
    Effect.catchCause((cause) =>
      input.onCause
        ? input.onCause(cause)
        : Effect.logError(`${input.name} drain failed`, { cause }),
    ),
  )

  const wake: () => Effect.Effect<void> = Effect.fn(`${input.name}.wake`)(function* () {
    yield* wakeLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.running) {
          yield* Ref.update(state, (value) => ({ ...value, wakePending: true }))
          return
        }
        yield* Ref.set(state, { running: true, wakePending: false })
        yield* Effect.gen(function* () {
          while (true) {
            yield* execute
            const repeat = yield* Ref.modify(state, (value) => {
              if (!value.wakePending) return [false, { running: false, wakePending: false }] as const
              return [true, { running: true, wakePending: false }] as const
            })
            if (!repeat) return
          }
        }).pipe(Effect.forkIn(scope, { startImmediately: true }))
      }),
    )
  })

  const active = Effect.fn(`${input.name}.active`)(function* () {
    return (yield* Ref.get(state)).running ? 1 : 0
  })
  return { wake, active } satisfies CoalescedDrain
})
