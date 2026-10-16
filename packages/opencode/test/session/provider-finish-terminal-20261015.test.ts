import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { consumeWithFlushDeadline } from "../../src/session/stream-flush-deadline"

test("semantic finish terminates request when underlying provider transport remains open", async () => {
  const seen: string[] = []
  let finished = false
  const upstream = Stream.make("step-finish", "finish").pipe(
    Stream.concat(Stream.never),
  )
  const result = await Effect.runPromise(
    consumeWithFlushDeadline(upstream, {
      delayMs: 10,
      consume: (event) => Effect.sync(() => {
        seen.push(event)
        if (event === "finish") finished = true
      }),
      pending: () => false,
      flush: Effect.void,
      stop: () => finished,
    }).pipe(Effect.timeout("1 second"), Effect.as("completed")),
  )
  expect(result).toBe("completed")
  expect(seen).toEqual(["step-finish", "finish"])
})

test("a nonterminal step-finish does not make the session falsely successful", async () => {
  let finished = false
  const upstream = Stream.make("step-finish").pipe(Stream.concat(Stream.never))
  await expect(
    Effect.runPromise(consumeWithFlushDeadline(upstream, {
      delayMs: 5,
      consume: () => Effect.void,
      pending: () => false,
      flush: Effect.void,
      stop: () => finished,
    }).pipe(Effect.timeout("35 millis"))),
  ).rejects.toThrow()
  expect(finished).toBe(false)
})
