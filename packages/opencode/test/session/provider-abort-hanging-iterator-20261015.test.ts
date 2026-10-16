import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { withProviderProgressDeadline } from "../../src/session/first-content-deadline"
import { abortableProviderIterable } from "../../src/session/llm/abortable-provider-iterable"

/** A hung SDK AsyncIterable must never outlive its request-local host timeout. */
test("host progress watchdog cancels an SDK iterator whose next never resolves", async () => {
  let started = 0
  const iterable: AsyncIterable<{ type: string }> = {
    [Symbol.asyncIterator]() {
      started++
      return {
        next: () => new Promise<IteratorResult<{ type: string }>>(() => {}),
      }
    },
  }
  const result = await Effect.runPromise(withProviderProgressDeadline(
    () => Stream.fromAsyncIterable(iterable, (error) => error instanceof Error ? error : new Error(String(error))).pipe(Stream.runDrain),
    35, undefined, 35,
  ).pipe(Effect.flip, Effect.timeout("750 millis")))
  expect(result).toHaveProperty("name", "ProviderProgressTimeoutError")
  expect(started).toBe(1)
})

test("host progress watchdog cancels an SDK iterator whose return never resolves", async () => {
  let cancelled = 0
  const controller = new AbortController()
  const iterable: AsyncIterable<{ type: string }> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<{ type: string }>>(() => {}),
        return: () => {
          cancelled++
          return new Promise<IteratorResult<{ type: string }>>(() => {})
        },
      }
    },
  }
  const result = await Effect.runPromise(withProviderProgressDeadline(
    () => Stream.fromAsyncIterable(abortableProviderIterable(iterable, controller, 45),
      (error) => error instanceof Error ? error : new Error(String(error))).pipe(Stream.runDrain),
    35, undefined, 35,
  ).pipe(Effect.flip, Effect.timeout("750 millis")))
  expect(result).toHaveProperty("name", "ProviderProgressTimeoutError")
  expect(cancelled).toBe(1)
  expect(controller.signal.aborted).toBe(true)
})
