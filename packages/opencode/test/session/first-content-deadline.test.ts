import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  createProviderStreamProbe,
  configuredProviderIdleTimeoutMs,
  configuredProviderFirstResponseTimeoutMs,
  isProviderResponseEvent,
  withProviderProgressDeadline,
} from "../../src/session/first-content-deadline"

test("attempt witnesses retain bounded event types, counts and monotonic timing", () => {
  const probe = createProviderStreamProbe()
  probe.sdk("finish-step")
  probe.normalized("step-finish")
  probe.begin("step-finish")
  const snapshot = probe.snapshot()
  expect(snapshot.sdkEvents).toBe(1)
  expect(snapshot.normalizedEvents).toBe(1)
  expect(snapshot.lastSdkEvent).toBe("finish-step")
  expect(snapshot.lastNormalizedEvent).toBe("step-finish")
  expect(snapshot.consumerEvent).toBe("step-finish")
  expect(snapshot.consumerBusyMs).toBeGreaterThanOrEqual(0)
  probe.end()
  expect(probe.snapshot().consumerEvent).toBeUndefined()
})

test("finished steps cannot strand SDK finalization after their terminal reason", async () => {
  const started = performance.now()
  await expect(Effect.runPromise(withProviderProgressDeadline(
    (observe) => observe({ type: "step-finish", reason: "stop" }).pipe(Effect.andThen(Effect.never)),
    200,
    undefined,
    120,
    createProviderStreamProbe(),
    16,
  ))).rejects.toThrow("Provider response timed out (provider stream idle")
  expect(performance.now() - started).toBeLessThan(110)
})

test("a tool-calling step without a succeeding provider step uses the next-response budget", async () => {
  const start = performance.now()
  await expect(Effect.runPromise(withProviderProgressDeadline(
    (observe) => observe({ type: "step-finish", reason: "tool-calls" }).pipe(Effect.andThen(Effect.never)),
    200,
    undefined,
    15,
  ))).rejects.toThrow("Provider response timed out")
  expect(performance.now() - start).toBeLessThan(150)
})

test("a started subsequent SDK step must produce content within its own first-response budget", async () => {
  const start = performance.now()
  await expect(Effect.runPromise(withProviderProgressDeadline(
    (observe) => observe({ type: "step-finish", reason: "tool-calls" }).pipe(
      Effect.andThen(Effect.sleep("2 millis")),
      Effect.andThen(observe({ type: "step-start" })),
      Effect.andThen(Effect.never),
    ),
    200,
    undefined,
    18,
  ))).rejects.toThrow("Provider response timed out")
  expect(performance.now() - start).toBeLessThan(150)
})

test("a blocked post-step local consumer is diagnosed separately from provider silence", async () => {
  const probe = createProviderStreamProbe()
  probe.sdk("finish-step")
  probe.normalized("step-finish")
  await expect(Effect.runPromise(withProviderProgressDeadline(
    (observe, consumer) => observe({ type: "step-finish" }).pipe(
      Effect.andThen(Effect.sync(() => consumer.begin("step-finish"))),
      Effect.andThen(Effect.never),
    ),
    5,
    undefined,
    5,
    probe,
  ))).rejects.toThrow("Local provider event processing stalled (step-finish, 5ms)")
})

test("provider watchdog is bounded and rejects unsafe environment overrides", () => {
  expect(configuredProviderIdleTimeoutMs({})).toBe(300_000)
  expect(configuredProviderIdleTimeoutMs({ OPENFORK_PROVIDER_IDLE_TIMEOUT_MS: "75" })).toBe(75)
  expect(configuredProviderIdleTimeoutMs({ OPENFORK_PROVIDER_IDLE_TIMEOUT_MS: "0" })).toBe(300_000)
  expect(configuredProviderIdleTimeoutMs({ OPENFORK_PROVIDER_IDLE_TIMEOUT_MS: "Infinity" })).toBe(300_000)
  expect(configuredProviderIdleTimeoutMs({ OPENFORK_PROVIDER_IDLE_TIMEOUT_MS: "1800001" })).toBe(300_000)
})

test("transport start does not disarm the deadline; content, reasoning, tools and terminal events do", () => {
  expect(isProviderResponseEvent({ type: "step-start" })).toBe(false)
  expect(isProviderResponseEvent({ type: "reasoning-start" })).toBe(true)
  expect(isProviderResponseEvent({ type: "text-start" })).toBe(true)
  expect(isProviderResponseEvent({ type: "tool-input-start" })).toBe(true)
  expect(isProviderResponseEvent({ type: "tool-call" })).toBe(true)
  expect(isProviderResponseEvent({ type: "finish" })).toBe(true)
})

test("a provider that silently waits after transport start fails with a bounded error", async () => {
  await expect(
    Effect.runPromise(
      withProviderProgressDeadline(
        (observe) => observe({ type: "step-start" }).pipe(Effect.andThen(Effect.never)),
        1,
      ),
    ),
  ).rejects.toThrow("Provider response timed out (waiting for first content")
})

test("real tool progress disarms the deadline before a long-running tool", async () => {
  const value = await Effect.runPromise(
    withProviderProgressDeadline(
      (observe) => observe({ type: "tool-call", id: "call-long" }).pipe(Effect.andThen(Effect.sleep("15 millis")), Effect.as("ok")),
      1,
      () => "running",
    ),
  )
  expect(value).toBe("ok")
})

test("partial reasoning followed by silence has a deadline too", async () => {
  await expect(
    Effect.runPromise(
      withProviderProgressDeadline(
        (observe) => observe({ type: "reasoning-start" }).pipe(Effect.andThen(Effect.never)),
        1,
      ),
    ),
  ).rejects.toThrow("Provider response timed out (provider stream idle")
})

test("executor settlement clears a lost tool-result and resumes idle detection", async () => {
  let running = true
  await expect(
    Effect.runPromise(
      withProviderProgressDeadline(
        (observe) => observe({ type: "tool-call", id: "call-done" }).pipe(
          Effect.andThen(Effect.sleep("5 millis")),
          Effect.tap(() => Effect.sync(() => { running = false })),
          Effect.andThen(Effect.never),
        ),
        1,
        () => running ? "running" : "settled",
      ),
    ),
  ).rejects.toThrow("Provider response timed out (provider stream idle")
})

test("provider-emitted tool call awaiting host admission cannot mask an idle stream", async () => {
  await expect(
    Effect.runPromise(
      withProviderProgressDeadline(
        (observe) => observe({ type: "tool-call", id: "call-pending" }).pipe(Effect.andThen(Effect.never)),
        3,
        () => "pending",
      ),
    ),
  ).rejects.toThrow("Provider response timed out (provider stream idle")
})