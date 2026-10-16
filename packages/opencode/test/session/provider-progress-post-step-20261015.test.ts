import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { consumeWithFlushDeadline } from "../../src/session/stream-flush-deadline"
import {
  createProviderStreamProbe,
  ProviderConsumerStallError,
  ProviderProgressTimeoutError,
  withProviderProgressDeadline,
} from "../../src/session/first-content-deadline"

/** Integration guard for the post-step watchdog incidents of 2026-10-15. */
test("blocked post-step persistence is a local consumer stall, not a provider timeout", async () => {
  const probe = createProviderStreamProbe()
  const error = await Effect.runPromise(
    withProviderProgressDeadline(
      (observe, consumer) => observe({ type: "step-finish" }).pipe(
        Effect.andThen(Effect.sync(() => consumer.begin("step-finish"))),
        Effect.andThen(Effect.never),
      ),
      25, undefined, 25, probe,
    ).pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(ProviderConsumerStallError)
  expect(error).not.toBeInstanceOf(ProviderProgressTimeoutError)
  if (!(error instanceof ProviderConsumerStallError)) throw error
  expect(error.eventType).toBe("step-finish")
  expect(probe.snapshot().consumerEvent).toBe("step-finish")
})

test("a completed post-step handler followed by silence is provider/adapter idle", async () => {
  const probe = createProviderStreamProbe()
  probe.sdk("finish-step")
  probe.normalized("step-finish")
  const error = await Effect.runPromise(
    withProviderProgressDeadline(
      (observe, consumer) => observe({ type: "step-finish" }).pipe(
        Effect.andThen(Effect.sync(() => {
          consumer.begin("step-finish")
          consumer.end()
        })),
        Effect.andThen(Effect.never),
      ),
      25, undefined, 25, probe,
    ).pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(ProviderProgressTimeoutError)
  expect(probe.snapshot()).toMatchObject({
    sdkEvents: 1,
    normalizedEvents: 1,
    lastSdkEvent: "finish-step",
    lastNormalizedEvent: "step-finish",
    consumerBusyMs: 0,
  })
})

test("a raw SDK event is not mistaken for a consumer-visible model response", async () => {
  const probe = createProviderStreamProbe()
  const error = await Effect.runPromise(
    withProviderProgressDeadline(
      () => Effect.sync(() => probe.sdk("raw-response")).pipe(Effect.andThen(Effect.never)),
      25, undefined, 25, probe,
    ).pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(ProviderProgressTimeoutError)
  if (!(error instanceof ProviderProgressTimeoutError)) throw error
  expect(error.phase).toBe("waiting for first content")
  expect(probe.snapshot().sdkEvents).toBe(1)
})

test("a finished local handler can process subsequent provider events", async () => {
  const probe = createProviderStreamProbe()
  const result = await Effect.runPromise(withProviderProgressDeadline(
    (observe, consumer) => Effect.gen(function* () {
      yield* observe({ type: "step-finish" })
      consumer.begin("step-finish")
      yield* Effect.sleep("2 millis")
      consumer.end()
      yield* Effect.sleep("2 millis")
      yield* observe({ type: "finish" })
      consumer.begin("finish")
      consumer.end()
      return "complete"
    }),
    100, undefined, 100, probe,
  ))
  expect(result).toBe("complete")
  expect(probe.snapshot().consumerEvent).toBeUndefined()
})

test("timeout interrupts an outstanding local consumer without waiting for full provider idle twice", async () => {
  const probe = createProviderStreamProbe()
  let finalized = false
  const started = performance.now()
  const result = await Effect.runPromise(withProviderProgressDeadline(
    (observe, consumer) => observe({ type: "step-finish" }).pipe(
      Effect.andThen(Effect.sync(() => consumer.begin("step-finish"))),
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => { finalized = true; consumer.end() })),
    ),
    30, undefined, 30, probe,
  ).pipe(Effect.flip))
  expect(result).toBeInstanceOf(ProviderConsumerStallError)
  expect(finalized).toBe(true)
  expect(performance.now() - started).toBeLessThan(1000)
  expect(probe.snapshot().consumerEvent).toBeUndefined()
})

test("step-start bookkeeping does not falsely appear as a queued local event", async () => {
  const probe = createProviderStreamProbe()
  probe.sdk("start-step")
  probe.normalized("step-start")
  probe.sdk("finish-step")
  probe.normalized("step-finish")
  const result = await Effect.runPromise(withProviderProgressDeadline(
    (observe, consumer) => observe({ type: "step-finish" }).pipe(
      Effect.andThen(Effect.sync(() => { consumer.begin("step-finish"); consumer.end() })),
      Effect.andThen(Effect.never),
    ),
    25, undefined, 25, probe,
  ).pipe(Effect.flip))
  expect(result).toBeInstanceOf(ProviderProgressTimeoutError)
  expect(probe.snapshot()).toMatchObject({ normalizedEvents: 2, normalizedResponseEvents: 1 })
})

test("a queued normalized response is local stream starvation, not an upstream timeout", async () => {
  const probe = createProviderStreamProbe()
  probe.normalized("step-start")
  probe.normalized("reasoning-start")
  probe.normalized("step-finish")
  const result = await Effect.runPromise(withProviderProgressDeadline(
    (observe) => observe({ type: "reasoning-start" }).pipe(Effect.andThen(Effect.never)),
    25, undefined, 25, probe,
  ).pipe(Effect.flip))
  expect(result).toBeInstanceOf(ProviderConsumerStallError)
  if (!(result instanceof ProviderConsumerStallError)) throw result
  expect(result.eventType).toBe("normalized-event-queue")
  expect(probe.snapshot()).toMatchObject({ normalizedEvents: 3, normalizedResponseEvents: 2 })
})

test("local snapshot settlement does not consume the next provider finalization budget", async () => {
  const probe = createProviderStreamProbe()
  const result = await Effect.runPromise(withProviderProgressDeadline(
    (observe, consumer) => Effect.gen(function* () {
      yield* observe({ type: "step-finish", reason: "stop" })
      consumer.begin("step-finish")
      yield* Effect.sleep("22 millis")
      consumer.end()
      // Total attempt exceeds the 30 ms watchdog, but the provider has had
      // only 18 ms to finalize since local snapshot processing completed.
      yield* Effect.sleep("18 millis")
      return "finalized"
    }),
    30, undefined, 30, probe,
  ))
  expect(result).toBe("finalized")
})

test("repeated SDK start markers cannot reset the first content deadline", async () => {
  const probe = createProviderStreamProbe()
  const start = performance.now()
  const result = await Effect.runPromise(withProviderProgressDeadline(
    (observe, consumer) => Effect.gen(function* () {
      for (let i = 0; i < 5; i++) {
        yield* observe({ type: "step-start" })
        consumer.begin("step-start")
        yield* Effect.sleep("10 millis")
        consumer.end()
      }
      return yield* Effect.never
    }),
    100, undefined, 30, probe,
  ).pipe(Effect.flip))
  expect(result).toBeInstanceOf(ProviderProgressTimeoutError)
  expect(result).toHaveProperty("phase", "waiting for first content")
  // The real deadline is measured from request start, not the last start marker.
  expect(performance.now() - start).toBeLessThan(85)
})

test("a blocked final delta publication is local work even after provider finish", async () => {
  const probe = createProviderStreamProbe()
  let terminal = false
  const failure = await Effect.runPromise(withProviderProgressDeadline(
    (observe, consumer) => consumeWithFlushDeadline(
      Stream.make("fragment", "finish").pipe(Stream.concat(Stream.never)),
      {
        delayMs: 1,
        finalFlushTimeoutMs: 40,
        pending: () => true,
        consume: (event) => Effect.gen(function* () {
          yield* observe({ type: event === "finish" ? "finish" : "text-delta" })
          consumer.begin(event)
          terminal = event === "finish"
          consumer.end()
        }),
        flush: Effect.sync(() => consumer.begin("delta-flush")).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => consumer.end())),
        ),
        stop: () => terminal,
      },
    ),
    35, undefined, 35, probe,
  ).pipe(Effect.flip))
  expect(failure).toBeInstanceOf(ProviderConsumerStallError)
  if (!(failure instanceof ProviderConsumerStallError)) throw failure
  expect(failure.eventType).toBe("delta-flush")
  expect(terminal).toBe(true)
})

test("1/3/6 concurrent provider attempts isolate failures and terminate without leaking consumers", async () => {
  for (const count of [1, 3, 6]) {
    const probes = Array.from({ length: count }, () => createProviderStreamProbe())
    const failures = await Effect.runPromise(Effect.all(
      probes.map((probe, index) =>
        withProviderProgressDeadline(
          (observe, consumer) => observe({ type: "step-finish", reason: "stop" }).pipe(
            Effect.andThen(Effect.sync(() => consumer.begin("step-finish"))),
            Effect.andThen(index % 2 ? Effect.never : Effect.sync(() => consumer.end()).pipe(Effect.andThen(Effect.never))),
            Effect.ensuring(Effect.sync(() => consumer.end())),
          ),
          30, undefined, 30, probe, 12,
        ).pipe(Effect.flip),
      ),
      { concurrency: count },
    ))
    expect(failures).toHaveLength(count)
    failures.forEach((failure, index) => {
      expect(failure).toBeInstanceOf(index % 2 ? ProviderConsumerStallError : ProviderProgressTimeoutError)
      expect(probes[index]!.snapshot().consumerEvent).toBeUndefined()
    })
  }
})
