import { describe, expect, test } from "bun:test"
import {
  compact,
  finite,
  isLive,
  planeMix,
  relativeStamp,
  shouldRefreshAttribution,
  sumPlaneMix,
} from "./chat-sidebar-oxp-model"

describe("finite", () => {
  test("coerces strings and rejects non-finite", () => {
    expect(finite("12")).toBe(12)
    expect(finite("NaN")).toBe(0)
    expect(finite("Infinity")).toBe(0)
    expect(finite(undefined)).toBe(0)
    expect(finite(3)).toBe(3)
  })
})

describe("compact", () => {
  test("formats magnitudes", () => {
    expect(compact(0)).toBe("0")
    expect(compact(2.5)).toBe("2.5")
    expect(compact(999)).toBe("999")
    expect(compact(2341)).toBe("2.34k")
    expect(compact(23_410)).toBe("23.4k")
    expect(compact(1_500_000)).toBe("1.50M")
    expect(compact("NaN")).toBe("0")
  })
})

describe("planeMix", () => {
  test("proportions", () => {
    const mix = planeMix({ augmentationCalls: 50, supervisionCalls: 30, delegationCalls: 20 })
    expect(mix.total).toBe(100)
    expect(mix.augmentationShare).toBeCloseTo(0.5)
    expect(mix.delegationShare).toBeCloseTo(0.2)
  })
  test("zero total yields zero shares", () => {
    const mix = planeMix({ augmentationCalls: 0, supervisionCalls: 0, delegationCalls: 0 })
    expect(mix.total).toBe(0)
    expect(mix.augmentationShare + mix.supervisionShare + mix.delegationShare).toBe(0)
  })
  test("NaN strings and negatives are ignored", () => {
    const mix = planeMix({ augmentationCalls: "NaN", supervisionCalls: -4, delegationCalls: 3 })
    expect(mix.total).toBe(3)
    expect(mix.delegationShare).toBe(1)
  })
  test("sums across activities", () => {
    const mix = sumPlaneMix([
      { augmentationCalls: 1, supervisionCalls: 2, delegationCalls: "NaN" },
      { augmentationCalls: 3, supervisionCalls: 0, delegationCalls: 4 },
    ])
    expect([mix.augmentation, mix.supervision, mix.delegation]).toEqual([4, 2, 4])
  })
})

describe("relativeStamp", () => {
  const now = 1_000_000_000_000
  test("units", () => {
    expect(relativeStamp(undefined, now)).toBe("")
    expect(relativeStamp(now - 30_000, now)).toBe("now")
    expect(relativeStamp(now - 5 * 60_000, now)).toBe("5m")
    expect(relativeStamp(now - 2 * 3_600_000, now)).toBe("2h")
    expect(relativeStamp(now - 3 * 86_400_000, now)).toBe("3d")
  })
  test("live window", () => {
    expect(isLive(now - 60_000, now)).toBe(true)
    expect(isLive(now - 121_000, now)).toBe(false)
    expect(isLive("NaN", now)).toBe(false)
  })
})

describe("shouldRefreshAttribution", () => {
  const base = { collapsed: false, inflight: false, now: 200_000, reexpanded: false, newestSeenAt: 10 }
  test("never while collapsed or in flight", () => {
    expect(shouldRefreshAttribution({ ...base, collapsed: true })).toBe(false)
    expect(shouldRefreshAttribution({ ...base, inflight: true })).toBe(false)
  })
  test("first expansion fetches", () => {
    expect(shouldRefreshAttribution(base)).toBe(true)
  })
  test("throttled within 60s", () => {
    expect(
      shouldRefreshAttribution({
        ...base,
        lastFetchAt: 150_000,
        reexpanded: true,
        newestSeenAt: 99,
        lastFetchedNewestSeenAt: 1,
      }),
    ).toBe(false)
  })
  test("after 60s needs re-expand or newer activity", () => {
    const old = { ...base, lastFetchAt: 100_000, lastFetchedNewestSeenAt: 10 }
    expect(shouldRefreshAttribution(old)).toBe(false)
    expect(shouldRefreshAttribution({ ...old, reexpanded: true })).toBe(true)
    expect(shouldRefreshAttribution({ ...old, newestSeenAt: 11 })).toBe(true)
  })
})
