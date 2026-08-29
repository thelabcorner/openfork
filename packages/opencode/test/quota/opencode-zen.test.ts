import { describe, expect, test } from "bun:test"
import {
  estimateZenFreeLimit,
  zenFreeProviderResult,
  ZEN_FREE_FALLBACK_LIMIT,
} from "@/quota/providers/opencode-zen"
import { ZEN_FREE_DAY_MS, type ZenFreeSnapshot, zenUtcDayStart } from "@/usage/zen-free"

const NOW = Date.UTC(2026, 7, 28, 18, 0, 0)
const TODAY = zenUtcDayStart(NOW)

function snapshot(input?: Partial<ZenFreeSnapshot>): ZenFreeSnapshot {
  return {
    since: TODAY - 30 * ZEN_FREE_DAY_MS,
    until: NOW,
    currentDayStart: TODAY,
    currentRequests: 0,
    days: [],
    limitHits: [],
    ...input,
  }
}

describe("OpenCode Zen free quota learning", () => {
  test("boots from the 200 request fallback without claiming learned confidence", () => {
    const estimate = estimateZenFreeLimit({
      snapshot: snapshot({ currentRequests: 53 }),
      now: NOW,
    })

    expect(estimate.used).toBe(53)
    expect(estimate.limit).toBe(ZEN_FREE_FALLBACK_LIMIT)
    expect(estimate.source).toBe("fallback")
    expect(estimate.confidence).toBeLessThan(0.5)
  })

  test("treats successful historical days as lower bounds rather than exact caps", () => {
    const estimate = estimateZenFreeLimit({
      snapshot: snapshot({
        currentRequests: 40,
        days: [{ start: TODAY - ZEN_FREE_DAY_MS, requests: 287 }],
      }),
      now: NOW,
    })

    expect(estimate.limit).toBeNull()
    expect(estimate.knownAtLeast).toBe(287)
    expect(estimate.source).toBe("lower-bound")
  })

  test("one fresh structured limit hit outweighs the weak fallback prior", () => {
    const estimate = estimateZenFreeLimit({
      snapshot: snapshot({
        currentRequests: 180,
        limitHits: [{ at: NOW - 60_000, requests: 180, modelID: "mimo-v2.5-free" }],
      }),
      now: NOW,
    })

    expect(estimate.limit).toBe(180)
    expect(estimate.source).toBe("learned")
    expect(estimate.hitSamples).toBe(1)
  })

  test("recent hits dominate stale evidence when the hidden policy changes", () => {
    const estimate = estimateZenFreeLimit({
      snapshot: snapshot({
        currentRequests: 110,
        limitHits: [
          { at: NOW - 42 * ZEN_FREE_DAY_MS, requests: 400, modelID: "mimo-v2.5-free" },
          { at: NOW - 28 * ZEN_FREE_DAY_MS, requests: 400, modelID: "mimo-v2.5-free" },
          { at: NOW - 60_000, requests: 120, modelID: "mimo-v2.5-free" },
        ],
      }),
      now: NOW,
    })

    expect(estimate.limit).toBe(120)
    expect(estimate.lastLimitHitAt).toBe(NOW - 60_000)
  })

  test("pre-hit high-usage days do not prevent a legitimate downward regime change", () => {
    const hitAt = NOW - 30_000
    const estimate = estimateZenFreeLimit({
      snapshot: snapshot({
        currentRequests: 90,
        days: [{ start: TODAY - ZEN_FREE_DAY_MS, requests: 310 }],
        limitHits: [{ at: hitAt, requests: 100, modelID: "deepseek-v4-flash-free" }],
      }),
      now: NOW,
    })

    expect(estimate.limit).toBe(100)
    expect(estimate.knownAtLeast).toBe(100)
  })

  test("successful usage above a learned cap invalidates false precision", () => {
    const estimate = estimateZenFreeLimit({
      snapshot: snapshot({
        currentRequests: 235,
        limitHits: [{ at: NOW - ZEN_FREE_DAY_MS, requests: 200, modelID: "big-pickle" }],
      }),
      now: NOW,
    })

    expect(estimate.limit).toBeNull()
    expect(estimate.knownAtLeast).toBe(235)
    expect(estimate.source).toBe("lower-bound")
  })

  test("projects learned usage into the normal Limits provider contract with UTC reset", () => {
    const result = zenFreeProviderResult(
      {
        used: 50,
        limit: 200,
        knownAtLeast: 200,
        source: "learned",
        confidence: 0.8,
        hitSamples: 2,
        lastLimitHitAt: NOW - ZEN_FREE_DAY_MS,
      },
      NOW,
    )

    expect(result.providerId).toBe("opencode-zen")
    expect(result.providerName).toBe("OpenCode Zen")
    expect(result.planLabel).toBe("50/200 req")
    expect(result.usage?.windows["daily learned"]?.usedPercent).toBe(25)
    expect(result.usage?.windows["daily learned"]?.remainingPercent).toBe(75)
    expect(result.usage?.windows["daily learned"]?.resetAt).toBe(TODAY + ZEN_FREE_DAY_MS)
  })
})
