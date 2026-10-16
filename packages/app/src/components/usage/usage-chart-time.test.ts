import { describe, expect, test } from "bun:test"
import { nearestUsageTimeIndex, usageTimeRatio } from "./usage-chart-time"

describe("chronological Usage chart positions", () => {
  const periods = [0, 10, 11, 90, 100].map((start) => ({ start }))
  test("proportional positions reflect elapsed time instead of entry index", () => {
    expect(usageTimeRatio(0, 100, 10, 1, 5)).toBe(0.1)
    expect(usageTimeRatio(0, 100, 90, 3, 5)).toBe(0.9)
    expect(usageTimeRatio(1, 1, 1, 2, 5)).toBe(0.5)
  })
  test("hover selects chronologically nearest visible bucket", () => {
    expect(nearestUsageTimeIndex(periods, 0)).toBe(0)
    expect(nearestUsageTimeIndex(periods, 0.1)).toBe(1)
    expect(nearestUsageTimeIndex(periods, 0.5)).toBe(2)
    expect(nearestUsageTimeIndex(periods, 1)).toBe(4)
    expect(nearestUsageTimeIndex(periods, -2)).toBe(0)
    expect(nearestUsageTimeIndex(periods, 4)).toBe(4)
  })
  test("matches full nearest-neighbor scans across 1,000 randomized probes", () => {
    const items = Array.from({ length: 1200 }, (_, i) => ({ start: i * i + i }))
    for (let i = 0; i < 1000; i++) {
      const ratio = i / 999
      const target = ratio * items.at(-1)!.start
      let best = 0
      for (let j = 1; j < items.length; j++) {
        const distance = Math.abs(items[j]!.start - target)
        if (distance <= Math.abs(items[best]!.start - target)) best = j
      }
      expect(nearestUsageTimeIndex(items, ratio)).toBe(best)
    }
  })
  test("handles no points, one point, and repeated timestamps", () => {
    expect(nearestUsageTimeIndex([], 0.5)).toBe(-1)
    expect(nearestUsageTimeIndex([{ start: 1 }], 0.7)).toBe(0)
    expect(nearestUsageTimeIndex([{ start: 1 }, { start: 1 }, { start: 1 }], 0.75)).toBe(2)
  })
})
