import { describe, expect, test } from "bun:test"
import { usageCalendarWindow } from "./usage-calendar-window"

const day = (year: number, month: number, date: number) => new Date(year, month - 1, date).getTime()
const row = (start: number, messages = 1) => ({ start, cost: messages * 0.5, tokens: messages * 40, messages, sessions: 1 })

describe("usageCalendarWindow", () => {
  test("fills missing calendar dates rather than compressing sparse active days", () => {
    const first = day(2026, 9, 1)
    const last = day(2026, 9, 8)
    const result = usageCalendarWindow([row(first), row(last, 2)], first, day(2026, 9, 9), 20)
    expect(result).toHaveLength(8)
    expect(result.map((d) => new Date(d.start).getDate())).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(result.map((d) => d.messages)).toEqual([1, 0, 0, 0, 0, 0, 0, 2])
    expect(result[7]).toEqual(row(last, 2))
  })

  test("takes the most recent N calendar days for all-time ranges", () => {
    const end = day(2026, 10, 10)
    const result = usageCalendarWindow([row(day(2026, 1, 1)), row(day(2026, 10, 9))], 0, end, 120)
    expect(result).toHaveLength(120)
    expect(result.at(-1)?.start).toBe(day(2026, 10, 9))
    expect(result.at(-1)?.messages).toBe(1)
    expect(result[0]!.start).toBeLessThan(result.at(-1)!.start)
  })

  test("preserves local calendar days through DST transitions", () => {
    const start = day(2026, 3, 6)
    const until = day(2026, 3, 11)
    const result = usageCalendarWindow([row(start), row(day(2026, 3, 10))], start, until, 120)
    expect(result).toHaveLength(5)
    expect(result.map((d) => new Date(d.start).getDate())).toEqual([6, 7, 8, 9, 10])
    expect(result.reduce((acc, d) => acc + d.messages, 0)).toBe(2)
  })

  test("rejects empty/out-of-range and bounds partial ranges", () => {
    expect(usageCalendarWindow([], 0, day(2026, 10, 10))).toEqual([])
    expect(usageCalendarWindow([row(day(2026, 10, 9))], 5, 5)).toEqual([])
    expect(usageCalendarWindow([row(day(2026, 10, 9))], day(2026, 10, 9), day(2026, 10, 10))).toHaveLength(1)
  })
})
