import { describe, expect, test } from "bun:test"
import { stretchHeadroom, stretchTone } from "./model-stretch-bar"

describe("stretchHeadroom", () => {
  test("unknown headroom draws no bar and never reads as a depleted quota", () => {
    // Capacity reports this exact shape for `learning` / `unavailable` rows:
    // no request count, no remaining percentage.
    const unknown = stretchHeadroom({})
    expect(unknown.state).toBe("unknown")
    expect(unknown.fraction).toBeNull()
    expect(unknown.tone).toBe("muted")

    // A NaN count is not a measurement either, and must not become a red bar.
    const notANumber = stretchHeadroom({ requests: Number.NaN })
    expect(notANumber.state).toBe("unknown")
    expect(notANumber.fraction).toBeNull()
  })

  test("a real zero request count is an empty danger bar, not an unknown one", () => {
    // Exhausted credits/quota genuinely reports 0. It must stay distinguishable
    // from "we have no idea", so it gets the real empty danger fill.
    const zero = stretchHeadroom({ requests: 0 })
    expect(zero.state).toBe("requests")
    expect(zero.fraction).toBe(0)
    expect(zero.tone).toBe("danger")
  })

  test("remainingPercent wins over a request count when both are present", () => {
    const fromPercent = stretchHeadroom({ remainingPercent: 42 })
    expect(fromPercent.state).toBe("percent")
    expect(fromPercent.fraction).toBeCloseTo(0.42, 10)
    expect(fromPercent.tone).toBe("success")

    // Quota percentage is the authoritative fact even when the request
    // estimate disagrees, including when the count is 0.
    const both = stretchHeadroom({ remainingPercent: 8, requests: 0 })
    expect(both.state).toBe("percent")
    expect(both.fraction).toBeCloseTo(0.08, 10)
    expect(both.tone).toBe("danger")

    // Percentages outside 0-100 are clamped, never extrapolated.
    expect(stretchHeadroom({ remainingPercent: 140 }).fraction).toBe(1)
    expect(stretchHeadroom({ remainingPercent: -5 }).fraction).toBe(0)
  })

  test("an Infinity request count is a real unlimited claim, not unknown", () => {
    const unlimited = stretchHeadroom({ requests: Number.POSITIVE_INFINITY })
    expect(unlimited.state).toBe("unlimited")
    expect(unlimited.fraction).toBe(1)
    expect(unlimited.tone).toBe("success")
  })

  test("stretchTone is only ever called with a real count", () => {
    // Guards the reason the bar exists as a separate concept: tiers must be
    // derived from a measured count, never from a substituted zero.
    expect(stretchTone(0)).toBe("danger")
    expect(stretchTone(8)).toBe("danger")
    expect(stretchTone(9)).toBe("warning")
    expect(stretchTone(40)).toBe("warning")
    expect(stretchTone(41)).toBe("success")
    // A caller that passes a real count through still gets monotone tiers, so
    // the unknown case is the only thing that must bypass stretchTone.
    expect(stretchHeadroom({ requests: 5 }).tone).toBe(stretchTone(5))
  })
})
