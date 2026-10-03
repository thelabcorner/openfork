import { describe, expect, test } from "bun:test"
import {
  CAPACITY_DASH,
  capacityPercentOnly,
  capacityWindowKindFor,
  formatRequestCount,
  formatRequestRange,
  formatRemainingPercent,
  resolveCapacityRange,
  resolveCapacitySection,
  type CapacityBandInput,
  type CapacityWindowView,
} from "./model-tooltip-capacity"

describe("capacityWindowKindFor", () => {
  test("recognizes the two windows the inspector renders", () => {
    expect(capacityWindowKindFor("5h")).toBe("5h")
    expect(capacityWindowKindFor(" 5H ")).toBe("5h")
    expect(capacityWindowKindFor("5hours")).toBe("5h")
    expect(capacityWindowKindFor("week")).toBe("week")
    expect(capacityWindowKindFor("weekly")).toBe("week")
    expect(capacityWindowKindFor("7d")).toBe("week")
  })

  test("drops unknown labels instead of guessing at a window", () => {
    expect(capacityWindowKindFor("month")).toBeUndefined()
    expect(capacityWindowKindFor("")).toBeUndefined()
    expect(capacityWindowKindFor(undefined)).toBeUndefined()
    expect(capacityWindowKindFor(null)).toBeUndefined()
  })
})

describe("resolveCapacityRange", () => {
  test("a calibrated remaining range is ordered low-to-high", () => {
    expect(resolveCapacityRange({ status: "calibrated", effectiveSamples: 24, lowerRequests: 900, upperRequests: 300 }, 540)).toEqual(
      { state: "calibrated", lower: 300, upper: 900, point: 540, samples: 24 },
    )
  })

  test("a calibrated label with an unpaired bound falls back to the point count", () => {
    expect(resolveCapacityRange({ status: "calibrated", lowerRequests: 412 } as never, 540)).toMatchObject({
      state: "ready",
      point: 540,
    })
  })

  test("learning keeps samples and an optional budget for n/m progress", () => {
    expect(resolveCapacityRange({ status: "learning", effectiveSamples: 3, calibrationBudget: 20 }, undefined)).toEqual({
      state: "learning",
      samples: 3,
      budget: 20,
    })
    // Older servers publish maturity as a timestamp only; the budget is additive.
    expect(resolveCapacityRange({ status: "learning", effectiveSamples: 3 }, undefined)).toEqual({
      state: "learning",
      samples: 3,
    })
  })

  test("an owner-declared unavailable state beats a stale point count", () => {
    expect(resolveCapacityRange({ status: "unavailable", reason: "incomplete-local-accounting" }, 540)).toEqual({
      state: "unavailable",
      reason: "incomplete-local-accounting",
    })
  })

  test("a bare point count is its own state, and nothing is never a number", () => {
    expect(resolveCapacityRange(undefined, 540)).toEqual({ state: "ready", point: 540 })
    expect(resolveCapacityRange(undefined, undefined)).toEqual({ state: "unavailable" })
    expect(resolveCapacityRange(undefined, Number.NaN)).toEqual({ state: "unavailable" })
  })
})

const band = (overrides: Partial<CapacityBandInput> & { window: string }): CapacityBandInput => ({
  point: 5_100,
  lower: 2_400,
  upper: 10_400,
  ...overrides,
})

describe("resolveCapacitySection", () => {
  test("draws a 5h and Week headline row from the band, in that order", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "week", pointRequests: 74_000 }, { id: "5h", pointRequests: 20_000 }],
      bands: [band({ window: "week", point: 18_600, lower: 8_700, upper: 37_900 }), band({ window: "5h" })],
      bandSamples: 16,
    })
    expect(view.hasCapacity).toBe(true)
    expect(view.bandSamples).toBe(16)
    expect(view.windows.map((window) => window.kind)).toEqual(["5h", "week"])
    expect(view.windows[0]!.total).toEqual({ point: 5_100, lower: 2_400, upper: 10_400 })
    expect(view.windows[1]!.total).toEqual({ point: 18_600, lower: 8_700, upper: 37_900 })
  })

  test("keeps remaining (current window) subordinate to the total, never as the headline", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "5h", pointRequests: 20_000, remaining: { remainingPercent: 42, remainingRequests: 412 } }],
      bands: [band({ window: "5h" })],
    })
    const window = view.windows[0]!
    expect(window.total).toEqual({ point: 5_100, lower: 2_400, upper: 10_400 })
    expect(window.remaining).toMatchObject({ state: "ready", point: 412 })
    expect(window.remainingPercent).toBe(42)
  })

  test("an unobserved window reports an unknown remainder, never zero", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "week", pointRequests: 74_000 }],
      bands: [band({ window: "week" })],
    })
    expect(view.windows[0]!.remaining).toBeUndefined()
    expect(view.windows[0]!.total).toBeDefined()
  })

  test("a window that failed closed reports a dash rather than a borrowed count", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "5h", pointRequests: 20_000, remaining: { remainingPercent: 0, remainingRequests: null } }],
      bands: [band({ window: "5h" })],
    })
    expect(view.windows[0]!.remaining).toBeUndefined()
    expect(view.windows[0]!.remainingPercent).toBe(0)
  })

  test("the band always contains its own point, whatever the caller computed", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "5h", pointRequests: 20_000 }],
      bands: [band({ window: "5h", point: 5_100, lower: 9_000, upper: 10_400 })],
    })
    const total = view.windows[0]!.total!
    expect(total.lower).toBeLessThanOrEqual(total.point)
    expect(total.upper).toBeGreaterThanOrEqual(total.point)
  })

  test("no window totals falls back to the single estimate as the current 5h remaining row", () => {
    const view = resolveCapacitySection({ status: "ready", estimatedRequests: 540 })
    expect(view.hasCapacity).toBe(true)
    expect(view.windows).toHaveLength(1)
    expect(view.windows[0]).toMatchObject({ kind: "5h", remaining: { state: "ready", point: 540 } })
    expect(view.windows[0]!.total).toBeUndefined()
  })

  test("never scales the 5h estimate up into a weekly window", () => {
    const view = resolveCapacitySection({ status: "ready", estimatedRequests: 540 })
    expect(view.windows.some((window) => window.kind === "week")).toBe(false)
  })

  test("unlimited models report no capacity at all", () => {
    expect(resolveCapacitySection({ status: "unlimited", estimatedRequests: 540 })).toEqual({
      windows: [],
      hasCapacity: false,
    })
  })

  test("learning surfaces sample progress and still renders its row", () => {
    const view = resolveCapacitySection({
      status: "learning",
      predictiveRange: { status: "learning", effectiveSamples: 3, calibrationBudget: 20 },
    })
    expect(view.learning).toEqual({ samples: 3, budget: 20 })
    expect(view.windows[0]!.remaining).toEqual({ state: "learning", samples: 3, budget: 20 })
    expect(formatRequestRange(view.windows[0]!.remaining!)).toBe(CAPACITY_DASH)
  })

  test("unavailable keeps a row and surfaces the owner's reason", () => {
    const view = resolveCapacitySection({
      status: "unavailable",
      predictiveRange: { status: "unavailable", reason: "incomplete-local-accounting" },
    })
    expect(view.hasCapacity).toBe(true)
    expect(view.unavailableReason).toBe("incomplete-local-accounting")
    expect(formatRequestRange(view.windows[0]!.remaining!)).toBe(CAPACITY_DASH)
  })

  test("no capacity data at all renders no section", () => {
    expect(resolveCapacitySection({})).toEqual({ windows: [], hasCapacity: false })
    expect(resolveCapacitySection({ windows: [{ id: "month", pointRequests: 10 }] })).toEqual({
      windows: [],
      hasCapacity: false,
    })
  })

  test("a duplicate window id collapses to the first published one", () => {
    const view = resolveCapacitySection({
      windows: [
        { id: "5h", pointRequests: 20_000, remaining: { remainingRequests: 540 } },
        { id: "5hours", pointRequests: 20_000, remaining: { remainingRequests: 999 } },
      ],
    })
    expect(view.windows).toHaveLength(1)
    expect(view.windows[0]!.remaining).toMatchObject({ point: 540 })
  })

  /**
   * A window whose local count failed closed still publishes the share it has
   * left. Before the percent-only row that window drew nothing at all, so the
   * section rendered with a heading and no facts under it.
   */
  test("a percent-only window keeps its row instead of rendering the section empty", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "5h", remaining: { remainingPercent: 42, status: "ready" } }],
    })
    expect(view.hasCapacity).toBe(true)
    expect(view.windows).toHaveLength(1)
    const window = view.windows[0]!
    expect(window.remainingPercent).toBe(42)
    // No total and no count: exactly the cell that used to print nothing.
    expect(window.total).toBeUndefined()
    expect(window.remaining).toBeUndefined()
    // The share survives into a drawable row.
    expect(capacityPercentOnly(window)).toBe(42)
  })

  test("a percent-only week window with no total at all still surfaces its share", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "week", remaining: { remainingPercent: 7, remainingRequests: null, status: "unavailable" } }],
    })
    expect(view.hasCapacity).toBe(true)
    expect(view.windows[0]).toMatchObject({ kind: "week", remainingPercent: 7 })
    expect(capacityPercentOnly(view.windows[0]!)).toBe(7)
    expect(view.windows[0]!.remaining).toBeUndefined()
  })

  test("a total plus a share with no count surfaces the share alongside the total", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "5h", pointRequests: 20_000, remaining: { remainingPercent: 42, remainingRequests: null } }],
      bands: [band({ window: "5h" })],
    })
    const window = view.windows[0]!
    expect(window.total).toEqual({ point: 5_100, lower: 2_400, upper: 10_400 })
    expect(window.remaining).toBeUndefined()
    expect(capacityPercentOnly(window)).toBe(42)
  })

  test("the percent-only row never invents a request count to fill the gap", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "5h", remaining: { remainingPercent: 42 } }],
    })
    const window = view.windows[0]!
    expect(capacityPercentOnly(window)).toBe(42)
    // No synthesized cell, and the dash is what an absent count still prints.
    expect(window.remaining).toBeUndefined()
    expect(formatRequestRange(window.remaining ?? { state: "unavailable" })).toBe(CAPACITY_DASH)
  })

  test("a window with a count keeps the percentage on the count row", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "5h", remaining: { remainingPercent: 42, remainingRequests: 412 } }],
    })
    const window = view.windows[0]!
    expect(window.remaining).toMatchObject({ state: "ready", point: 412 })
    expect(capacityPercentOnly(window)).toBeUndefined()
  })

  test("a window with neither a count nor a share draws no percent row", () => {
    const view = resolveCapacitySection({
      windows: [{ id: "5h", pointRequests: 20_000 }],
      bands: [band({ window: "5h" })],
    })
    expect(capacityPercentOnly(view.windows[0]!)).toBeUndefined()
    const learning: CapacityWindowView = {
      kind: "week",
      remaining: { state: "learning" },
      remainingPercent: Number.NaN,
    }
    expect(capacityPercentOnly(learning)).toBeUndefined()
  })
})

describe("request count formatting", () => {
  test("stays exact while it fits and compacts once it would wrap", () => {
    expect(formatRequestCount(540)).toBe("540")
    expect(formatRequestCount(9_999)).toBe("9,999")
    expect(formatRequestCount(15_240)).toBe("15.2K")
  })

  test("prints a dash rather than NaN for a missing number", () => {
    expect(formatRequestCount(undefined)).toBe(CAPACITY_DASH)
    expect(formatRequestCount(null)).toBe(CAPACITY_DASH)
    expect(formatRequestCount(Number.POSITIVE_INFINITY)).toBe(CAPACITY_DASH)
  })

  test("a remaining range reads low-to-high and a lone count reads as itself", () => {
    expect(formatRequestRange({ state: "calibrated", lower: 412, upper: 688 })).toBe("412–688")
    expect(formatRequestRange({ state: "ready", point: 540 })).toBe("540")
  })

  test("a remaining share reads as a percentage and a missing one as a dash", () => {
    expect(formatRemainingPercent(42, "en-US")).toBe("42%")
    expect(formatRemainingPercent(0, "en-US")).toBe("0%")
    expect(formatRemainingPercent(7.4, "en-US")).toBe("7%")
    expect(formatRemainingPercent(undefined)).toBe(CAPACITY_DASH)
    expect(formatRemainingPercent(Number.NaN)).toBe(CAPACITY_DASH)
  })
})