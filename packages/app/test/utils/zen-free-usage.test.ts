import { describe, expect, test } from "bun:test"
import {
  appendZenLimitHit,
  estimateZenFreeLimit,
  zenEstimateToProviderResult,
  ZEN_FREE_FALLBACK_LIMIT,
  ZEN_FREE_WINDOW_MS,
  type ZenLimitObservation,
} from "../../src/utils/zen-free-usage"

const DAY = ZEN_FREE_WINDOW_MS

function estimate(input?: { now?: number; used?: number; observations?: ZenLimitObservation[] }) {
  return estimateZenFreeLimit({
    now: input?.now ?? 100 * DAY,
    used: input?.used ?? 0,
    observations: input?.observations ?? [],
  })
}

describe("ZenFreeUsage", () => {
  test("uses 200 requests as the bootstrap fallback", () => {
    const result = estimate({ used: 50 })
    expect(result.source).toBe("fallback")
    expect(result.limit).toBe(ZEN_FREE_FALLBACK_LIMIT)
    expect(result.knownAtLeast).toBe(ZEN_FREE_FALLBACK_LIMIT)
  })

  test("successful history is a lower bound, never an exact learned cap", () => {
    const now = 100 * DAY
    const result = estimate({
      now,
      used: 80,
      observations: [{ at: now - DAY, requests: 260, kind: "lower-bound" }],
    })
    expect(result.source).toBe("lower-bound")
    expect(result.limit).toBe(null)
    expect(result.knownAtLeast).toBe(260)
  })

  test("a recent structured limit hit outweighs the weak 200-request prior", () => {
    const now = 100 * DAY
    const result = estimate({
      now,
      used: 70,
      observations: [{ at: now - DAY, requests: 240, kind: "limit-hit" }],
    })
    expect(result.source).toBe("learned")
    expect(result.limit).toBe(240)
    expect(result.hitSamples).toBe(1)
  })

  test("recent limit hits have more weight than stale hits", () => {
    const now = 100 * DAY
    const result = estimate({
      now,
      used: 50,
      observations: [
        { at: now - DAY, requests: 180, kind: "limit-hit" },
        { at: now - 56 * DAY, requests: 300, kind: "limit-hit" },
      ],
    })
    expect(result.limit).toBe(180)
  })

  test("new successful usage can invalidate a stale learned cap", () => {
    const now = 100 * DAY
    const result = estimate({
      now,
      used: 230,
      observations: [{ at: now - 10 * DAY, requests: 200, kind: "limit-hit" }],
    })
    expect(result.source).toBe("lower-bound")
    expect(result.limit).toBe(null)
    expect(result.knownAtLeast).toBe(230)
  })

  test("pre-hit lower bounds do not block learning a newer lower cap", () => {
    const now = 100 * DAY
    const result = estimate({
      now,
      used: 20,
      observations: [
        { at: now - 4 * DAY, requests: 280, kind: "lower-bound" },
        { at: now - DAY, requests: 180, kind: "limit-hit" },
      ],
    })
    expect(result.source).toBe("learned")
    expect(result.limit).toBe(180)
  })

  test("nearby retry events collapse into one exhaustion episode", () => {
    const now = 10 * DAY
    const once = appendZenLimitHit([], now)
    const duplicate = appendZenLimitHit(once, now + 30 * 60 * 1000)
    const later = appendZenLimitHit(duplicate, now + 3 * 60 * 60 * 1000)
    expect(once).toHaveLength(1)
    expect(duplicate).toHaveLength(1)
    expect(later).toHaveLength(2)
  })

  test("projects exact and lower-bound estimates into normal Limits providers", () => {
    const exact = zenEstimateToProviderResult(estimate({ used: 50 }), 1_000)
    const exactWindow = Object.values(exact.usage!.windows)[0]
    expect(exact.providerId).toBe("opencode")
    expect(exact.providerName).toBe("OpenCode Zen")
    expect(exactWindow.usedPercent).toBe(25)
    expect(exactWindow.remainingPercent).toBe(75)

    const lowerBound = zenEstimateToProviderResult(
      estimate({
        now: 100 * DAY,
        used: 250,
        observations: [{ at: 99 * DAY, requests: 260, kind: "lower-bound" }],
      }),
      1_000,
    )
    const lowerWindow = Object.values(lowerBound.usage!.windows)[0]
    expect(lowerWindow.usedPercent).toBe(null)
    expect(lowerWindow.valueLabel).toContain("cap ≥260")
  })
})
