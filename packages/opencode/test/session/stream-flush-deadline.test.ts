import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { consumeWithFlushDeadline } from "../../src/session/stream-flush-deadline"

test("publishes one fragment while the provider is silent", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const published = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let pending = false
    const stream = Stream.make("fragment").pipe(
      Stream.concat(Stream.fromEffect(Deferred.await(release)).pipe(Stream.drain)),
    )
    const fiber = yield* consumeWithFlushDeadline(stream, {
      delayMs: 5,
      consume: () => Effect.sync(() => { pending = true }),
      pending: () => pending,
      flush: Effect.gen(function* () {
        if (!pending) return
        pending = false
        yield* Deferred.succeed(published, undefined)
      }),
      stop: () => false,
    }).pipe(Effect.forkChild)
    // Failure is a missing publication, not a brittle latency distribution.
    yield* Deferred.await(published).pipe(Effect.timeout("2 seconds"))
    expect(pending).toBe(false)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)
  }))
})

test("timer publication is serialized with event handling and flushes on completion", async () => {
  const calls: string[] = []
  let pending = false
  let inside = false
  await Effect.runPromise(consumeWithFlushDeadline(Stream.make("first", "boundary"), {
    delayMs: 1,
    consume: (event) => Effect.gen(function* () {
      expect(inside).toBe(false)
      inside = true
      if (event === "first") pending = true
      yield* Effect.sleep(10)
      calls.push(event)
      inside = false
    }),
    pending: () => pending,
    flush: Effect.sync(() => {
      expect(inside).toBe(false)
      if (!pending) return
      calls.push("flush")
      pending = false
    }),
    stop: () => false,
  }))
  expect(calls.filter((item) => item !== "flush")).toEqual(["first", "boundary"])
  expect(calls.filter((item) => item === "flush")).toHaveLength(1)
  expect(pending).toBe(false)
})

test("interruption cancels the alarm and flushes pending content exactly once", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const consumed = yield* Deferred.make<void>()
    let pending = false
    let flushes = 0
    const fiber = yield* consumeWithFlushDeadline(Stream.make("fragment").pipe(Stream.concat(Stream.never)), {
      delayMs: 1000,
      consume: () => Effect.gen(function* () {
        pending = true
        yield* Deferred.succeed(consumed, undefined)
      }),
      pending: () => pending,
      flush: Effect.sync(() => {
        if (!pending) return
        flushes++
        pending = false
      }),
      stop: () => false,
    }).pipe(Effect.forkChild)
    yield* Deferred.await(consumed)
    yield* Fiber.interrupt(fiber)
    expect(flushes).toBe(1)
    expect(pending).toBe(false)
  }))
})
