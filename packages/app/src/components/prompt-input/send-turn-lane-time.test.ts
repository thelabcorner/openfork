import { describe, expect, test } from "bun:test"
import { promptTurnElapsedLabel, promptTurnElapsedMs, promptTurnLocalStartedAt } from "./send-turn-lane-time"

describe("promptTurnLocalStartedAt", () => {
  test("translates server timestamps into the renderer clock domain", () => {
    // Server and renderer wall clocks can be ~97 minutes apart. Only same-domain
    // deltas are meaningful; absolute wall-clock subtraction would recreate the
    // bogus 97m counter.
    expect(
      promptTurnLocalStartedAt({
        turnStartedAt: 1_000,
        sampledAt: 6_000,
        receivedAt: 50_000,
        observedAt: 50_250,
      }),
    ).toBe(45_000)
  })

  test("never moves the same live turn start forward on a delayed frame", () => {
    expect(
      promptTurnLocalStartedAt({
        turnStartedAt: 1_000,
        sampledAt: 11_000,
        receivedAt: 21_200,
        observedAt: 21_300,
        previousTurnStartedAt: 1_000,
        previousLocalStartedAt: 10_000,
      }),
    ).toBe(10_000)
  })

  test("resets the local mapping when the producer starts a fresh turn", () => {
    expect(
      promptTurnLocalStartedAt({
        turnStartedAt: 20_000,
        sampledAt: 21_000,
        receivedAt: 30_000,
        observedAt: 30_100,
        previousTurnStartedAt: 1_000,
        previousLocalStartedAt: 10_000,
      }),
    ).toBe(29_000)
  })

  test("does not confuse a stale semantic updatedAt with the projection sample time", () => {
    expect(
      promptTurnLocalStartedAt({
        turnStartedAt: 1_000,
        updatedAt: 11_000,
        sampledAt: 41_000,
        receivedAt: 100_000,
        observedAt: 100_500,
      }),
    ).toBe(60_000)
  })
})

describe("promptTurnElapsedMs", () => {
  test("uses producer-owned telemetry while a turn is live", () => {
    expect(
      promptTurnElapsedMs({
        working: true,
        liveStartedAt: 8_000,
        presentationStartedAt: 1_000,
        now: 10_500,
      }),
    ).toBe(2_500)
  })

  test("does not carry a previous turn clock through a live telemetry gap", () => {
    expect(
      promptTurnElapsedMs({
        working: true,
        presentationStartedAt: 1_000,
        completedAt: 2_000,
        now: 5_821_000,
      }),
    ).toBe(0)
  })

  test("freezes the just-completed turn during settled presentation", () => {
    expect(
      promptTurnElapsedMs({
        working: false,
        presentationStartedAt: 1_000,
        completedAt: 5_250,
        now: 9_000,
      }),
    ).toBe(4_250)
  })

  test("clamps future and invalid timestamps", () => {
    expect(promptTurnElapsedMs({ working: true, liveStartedAt: 2_000, now: 1_000 })).toBe(0)
    expect(promptTurnElapsedMs({ working: true, liveStartedAt: Number.NaN, now: 1_000 })).toBe(0)
  })
})

describe("promptTurnElapsedLabel", () => {
  test("keeps sub-minute precision compact", () => {
    expect(promptTurnElapsedLabel(340)).toBe("0.3s")
    expect(promptTurnElapsedLabel(12_340)).toBe("12.3s")
  })

  test("formats minutes without unbounded minute growth", () => {
    expect(promptTurnElapsedLabel(59 * 60_000 + 5_000)).toBe("59m 05s")
    expect(promptTurnElapsedLabel(97 * 60_000 + 5_000)).toBe("1h 37m")
  })

  test("remains bounded for very long turns", () => {
    expect(promptTurnElapsedLabel(27 * 60 * 60_000 + 4 * 60_000)).toBe("1d 03h")
    expect(promptTurnElapsedLabel(99 * 24 * 60 * 60_000 + 23 * 60 * 60_000)).toBe("99d 23h")
    expect(promptTurnElapsedLabel(100 * 24 * 60 * 60_000)).toBe("99d+")
  })
})