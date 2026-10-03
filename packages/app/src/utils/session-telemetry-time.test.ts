import { describe, expect, test } from "bun:test"
import { sessionTelemetryElapsedMs, sessionTelemetryLocalStartedAt } from "./session-telemetry-time"

describe("session telemetry clock domains", () => {
  test("does not turn server/client wall-clock skew into elapsed time", () => {
    // The producer is ~97 minutes behind the client wall clock. Only producer
    // deltas and client-local deltas are meaningful across the boundary.
    expect(
      sessionTelemetryElapsedMs({
        startedAt: 1_000,
        sampledAt: 6_000,
        receivedAt: 50_000,
        now: 50_250,
      }),
    ).toBe(5_250)
  })

  test("uses the projection sample rather than a stale semantic updatedAt", () => {
    // The phase has been quiet for 40 minutes. updatedAt is deliberately old;
    // sampledAt proves how long the producer interval had actually been live
    // when this reconnect snapshot was materialized.
    expect(
      sessionTelemetryElapsedMs({
        startedAt: 1_000,
        updatedAt: 601_000,
        sampledAt: 2_401_000,
        receivedAt: 8_000,
        now: 9_000,
      }),
    ).toBe(2_401_000)
  })

  test("falls back to updatedAt for rolling server/client version skew", () => {
    expect(
      sessionTelemetryElapsedMs({
        startedAt: 1_000,
        updatedAt: 6_000,
        receivedAt: 10_000,
        now: 10_200,
      }),
    ).toBe(5_200)
  })

  test("maps the producer start into the client monotonic clock", () => {
    expect(
      sessionTelemetryLocalStartedAt({
        startedAt: 1_000,
        sampledAt: 6_000,
        receivedAt: 50_000,
        now: 50_300,
      }),
    ).toBe(45_000)
  })

  test("clamps inverted producer and client deltas", () => {
    expect(
      sessionTelemetryElapsedMs({
        startedAt: 2_000,
        sampledAt: 1_000,
        receivedAt: 20_000,
        now: 19_000,
      }),
    ).toBe(0)
  })
})