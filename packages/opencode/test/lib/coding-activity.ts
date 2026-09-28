import { Effect, Fiber, Ref, Stream } from "effect"
import * as Scope from "effect/Scope"
import { CodingActivity } from "@opencode-ai/core/coding-activity"
import { pollWithTimeout } from "./effect"

export interface CodingActivityLog {
  readonly events: Ref.Ref<readonly CodingActivity.Activity[]>
  readonly fiber: Fiber.Fiber<void>
}

/**
 * Subscribes to the canonical process-global CodingActivity bus before the
 * operation under test runs. The subscription fiber is scoped to the caller.
 */
export const subscribeCodingActivity: Effect.Effect<CodingActivityLog, never, Scope.Scope> = Effect.gen(function* () {
  const events = yield* Ref.make<readonly CodingActivity.Activity[]>([])
  const fiber = yield* CodingActivity.stream().pipe(
    Stream.runForEach((event) => Ref.update(events, (current) => [...current, event])),
    Effect.forkScoped,
  )
  yield* Effect.yieldNow
  return { events, fiber }
})

/**
 * Publishes a FIFO sentinel on the same canonical bus and waits until the
 * subscriber has drained it. Once the sentinel is observed, every event
 * published before it has been processed, making "no event was emitted"
 * assertions deterministic instead of sleep-based.
 */
export const drainCodingActivity = (log: CodingActivityLog, marker: string) =>
  Effect.gen(function* () {
    yield* CodingActivity.record({ entity: marker, kind: "read", source: "core", sourceRef: marker })
    return yield* pollWithTimeout(
      Effect.map(Ref.get(log.events), (all) => (all.some((event) => event.sourceRef === marker) ? all : undefined)),
      `coding activity sentinel ${marker} never arrived`,
    )
  })
