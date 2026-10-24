import { expect, test } from "bun:test"
import { Effect, Fiber, Option } from "effect"
import { awaitOptionalStepEnrichment } from "../../src/session/optional-step-enrichment"

test("optional step enrichment preserves a completed snapshot", async () => {
  const result = await Effect.runPromise(awaitOptionalStepEnrichment(Effect.succeed("tree"), 30))
  expect(result).toEqual(Option.some("tree"))
})

test("optional step enrichment propagates a real snapshot failure", async () => {
  await expect(Effect.runPromise(
    awaitOptionalStepEnrichment(Effect.fail(new Error("broken git index")), 30),
  )).rejects.toThrow("broken git index")
})

test("uninterruptible Git cleanup cannot delay the provider event", async () => {
  const started = performance.now()
  const result = await Effect.runPromise(awaitOptionalStepEnrichment(
    Effect.uninterruptible(Effect.sleep("220 millis").pipe(Effect.as("late tree"))),
    20,
  ))
  expect(Option.isNone(result)).toBe(true)
  expect(performance.now() - started).toBeLessThan(170)
})

test("timeout requests cancellation of abandoned snapshot work", async () => {
  let cancelled = false
  const result = await Effect.runPromise(awaitOptionalStepEnrichment(
    Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { cancelled = true }))),
    15,
  ))
  expect(Option.isNone(result)).toBe(true)
  await Bun.sleep(30)
  expect(cancelled).toBe(true)
})

test("parent interruption cancels detached snapshot work", async () => {
  let cancelled = false
  await Effect.runPromise(Effect.gen(function* () {
    const parent = yield* Effect.forkDetach(awaitOptionalStepEnrichment(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { cancelled = true }))),
      30_000,
    ))
    yield* Effect.sleep("10 millis")
    yield* Fiber.interrupt(parent)
  }))
  await Bun.sleep(30)
  expect(cancelled).toBe(true)
})