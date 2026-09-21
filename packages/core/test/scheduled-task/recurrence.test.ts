import { describe, expect, test } from "bun:test"
import {
  SEARCH_HORIZON_DAYS,
  describeSchedule,
  jitterFor,
  nextOccurrence,
  occurrencesBetween,
  parseCron,
  preview,
  resolveScheduleInput,
  validateSchedule,
} from "@opencode-ai/core/scheduled-task/recurrence"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"

const NY = "America/New_York"
const KYIV = "Europe/Kyiv"

const daily = (...times: Array<[number, number]>): ScheduledTask.Schedule => ({
  kind: "daily",
  times: times.map(([hour, minute]) => ({ hour, minute })),
})

const weekly = (weekdays: number[], ...times: Array<[number, number]>): ScheduledTask.Schedule => ({
  kind: "weekly",
  weekdays,
  times: times.map(([hour, minute]) => ({ hour, minute })),
})

const cron = (expression: string): ScheduledTask.Schedule => ({ kind: "cron", expression })

const at = (
  schedule: ScheduledTask.Schedule,
  after: string,
  timezone: string | undefined = NY,
): number | undefined => nextOccurrence({ schedule, timezone, after: Date.parse(after) })

describe("recurrence engine — 02 § 8 acceptance fixtures", () => {
  test("normalizes relative, timestamp, and recurring input without persisting moving relative state", () => {
    const now = Date.parse("2026-06-01T12:00:00Z")
    expect(resolveScheduleInput({ kind: "relative", delayMs: 90_000 }, now)).toEqual({
      ok: true,
      schedule: { kind: "once", at: now + 90_000 },
    })
    expect(resolveScheduleInput({ kind: "timestamp", at: now + 120_000 }, now)).toEqual({
      ok: true,
      schedule: { kind: "once", at: now + 120_000 },
    })
    expect(
      resolveScheduleInput(
        { kind: "recurring", schedule: { kind: "daily", times: [{ hour: 9, minute: 30 }] } },
        now,
      ),
    ).toEqual({
      ok: true,
      schedule: { kind: "daily", times: [{ hour: 9, minute: 30 }] },
    })
  })

  test("rejects non-positive and non-finite relative delays", () => {
    const now = Date.parse("2026-06-01T12:00:00Z")
    expect(resolveScheduleInput({ kind: "relative", delayMs: 0 }, now)).toMatchObject({ ok: false })
    expect(resolveScheduleInput({ kind: "relative", delayMs: Number.POSITIVE_INFINITY }, now)).toMatchObject({ ok: false })
  })

  test("E1: daily @ 09:00 fires once at 09:00 local", () => {
    expect(at(daily([9, 0]), "2026-06-01T00:00:00Z")).toBe(Date.parse("2026-06-01T13:00:00Z"))
  })

  test("E2: daily @ 02:30 on spring-forward fires at the 03:00 gap boundary, flagged shifted", () => {
    const result = preview({ schedule: daily([2, 30]), timezone: NY, after: Date.parse("2026-03-07T12:00:00Z"), count: 1 })
    expect(result.next).toEqual([Date.parse("2026-03-08T07:00:00Z")])
    expect(result.warnings[0]).toContain("does not exist")
    expect(result.warnings[0]).toContain("2026-03-08 03:00")
  })

  test("E3: daily @ 01:30 on fall-back fires exactly once, on the first occurrence", () => {
    const first = at(daily([1, 30]), "2026-10-31T12:00:00Z")
    expect(first).toBe(Date.parse("2026-11-01T05:30:00Z"))
    // The exclusive bound advances by instant: the second 01:30 is skipped.
    const second = at(daily([1, 30]), "2026-11-01T05:30:00Z")
    expect(second).toBe(Date.parse("2026-11-02T06:30:00Z"))
    const result = preview({ schedule: daily([1, 30]), timezone: NY, after: Date.parse("2026-10-31T12:00:00Z"), count: 1 })
    expect(result.warnings[0]).toContain("occurs twice")
    expect(result.warnings[0]).toContain("first occurrence")
  })

  test("E4: daily @ 09:00 and 17:30 is MIN over the set, not a broken cron lowering", () => {
    const first = at(daily([9, 0], [17, 30]), "2026-06-01T00:00:00Z")
    expect(first).toBe(Date.parse("2026-06-01T13:00:00Z"))
    const second = at(daily([17, 30], [9, 0]), "2026-06-01T13:00:00Z")
    expect(second).toBe(Date.parse("2026-06-01T21:30:00Z"))
  })

  test("E8: once fires and then reports no next occurrence", () => {
    const schedule: ScheduledTask.Schedule = { kind: "once", at: Date.parse("2026-06-01T13:00:00Z") }
    expect(at(schedule, "2026-06-01T12:59:59Z")).toBe(Date.parse("2026-06-01T13:00:00Z"))
    expect(at(schedule, "2026-06-01T13:00:00Z")).toBeUndefined()
    expect(at(schedule, "2026-06-02T00:00:00Z")).toBeUndefined()
  })

  test("E9: once in the past is rejected at validation, not silently fired", () => {
    const schedule: ScheduledTask.Schedule = { kind: "once", at: Date.parse("2026-06-01T13:00:00Z") }
    const validation = validateSchedule(schedule, { now: Date.parse("2026-06-01T13:00:00Z") })
    expect(validation.ok).toBe(false)
    expect(validation.ok ? "" : validation.reason).toContain("past")
  })

  test("E10: impossible cron (Feb 30) never spins and is rejected", () => {
    expect(at(cron("0 0 30 2 *"), "2026-01-01T00:00:00Z")).toBeUndefined()
    const validation = validateSchedule(cron("0 0 30 2 *"))
    expect(validation.ok).toBe(false)
  })

  test("E11: leap-day cron is valid and returns a ~4-year occurrence", () => {
    expect(at(cron("0 0 29 2 *"), "2026-01-01T00:00:00Z")).toBe(Date.parse("2028-02-29T05:00:00Z"))
    expect(validateSchedule(cron("0 0 29 2 *")).ok).toBe(true)
  })

  test("E14: zone is interpreted per computation, not cached as an offset", () => {
    const after = "2026-06-01T00:00:00Z"
    expect(at(daily([9, 0]), after, NY)).toBe(Date.parse("2026-06-01T13:00:00Z"))
    expect(at(daily([9, 0]), after, KYIV)).toBe(Date.parse("2026-06-01T06:00:00Z"))
  })
})

describe("recurrence engine — 05 § 2 Tier A omitted cases", () => {
  test("month-end: `31st of every month` skips February", () => {
    expect(at(cron("0 0 31 * *"), "2026-02-01T00:00:00Z")).toBe(Date.parse("2026-03-31T04:00:00Z"))
    expect(at(cron("0 0 31 * *"), "2026-04-01T00:00:00Z")).toBe(Date.parse("2026-05-31T04:00:00Z"))
  })

  test("DOM/DOW OR rule: `noon on the 1st OR any Monday`", () => {
    // 2026-06-01 is a Monday; 2026-07-01 is a Wednesday.
    expect(at(cron("0 12 1 * 1"), "2026-06-02T00:00:00Z")).toBe(Date.parse("2026-06-08T16:00:00Z"))
    expect(at(cron("0 12 1 * 1"), "2026-06-30T00:00:00Z")).toBe(Date.parse("2026-07-01T16:00:00Z"))
    // When only one field is restricted the other is ANDed as "always match".
    expect(at(cron("0 12 * * 1"), "2026-06-06T00:00:00Z")).toBe(Date.parse("2026-06-08T16:00:00Z"))
  })

  test("weekday sugar handles Sunday as 0 and the weekly horizon", () => {
    const schedule = weekly([0], [9, 0])
    // 2026-06-01 is a Monday; next Sunday is 2026-06-07.
    expect(at(schedule, "2026-06-01T00:00:00Z")).toBe(Date.parse("2026-06-07T13:00:00Z"))
    // Monday..Friday sugar via cron.
    expect(at(cron("0 9 * * 1-5"), "2026-06-05T13:00:00Z")).toBe(Date.parse("2026-06-08T13:00:00Z"))
  })

  test("malformed input returns undefined instead of throwing", () => {
    expect(nextOccurrence({ schedule: cron("not a cron"), timezone: NY, after: 0 })).toBeUndefined()
    expect(nextOccurrence({ schedule: cron("0 0 1 1"), timezone: NY, after: 0 })).toBeUndefined()
    expect(nextOccurrence({ schedule: cron("*/0 * * * *"), timezone: NY, after: 0 })).toBeUndefined()
    expect(nextOccurrence({ schedule: daily([9, 0]), timezone: "Not/AZone", after: 0 })).toBeUndefined()
    expect(nextOccurrence({ schedule: daily(), timezone: NY, after: 0 })).toBeUndefined()
    expect(nextOccurrence({ schedule: daily([9, 0]), timezone: NY, after: Number.NaN })).toBeUndefined()
  })

  test("explicit rejections: seconds field, @reboot, L/W/#", () => {
    expect(validateSchedule(cron("0 0 9 * * *")).ok).toBe(false)
    expect(validateSchedule(cron("@reboot")).ok).toBe(false)
    expect(validateSchedule(cron("0 0 L * *")).ok).toBe(false)
    expect(validateSchedule(cron("0 0 * * 1#2")).ok).toBe(false)
    expect(validateSchedule(cron("0 0 9 * * *")).ok ? "" : validateSchedule(cron("0 9 * * *")).ok).toBe(true)
  })

  test("search horizon is bounded at four years", () => {
    expect(SEARCH_HORIZON_DAYS).toBeGreaterThanOrEqual(1461)
    // An impossible month/day pair terminates rather than spinning.
    const started = Date.now()
    expect(at(cron("0 0 31 4 *"), "2026-01-01T00:00:00Z")).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("cron parser produces sorted expansions and names", () => {
    const parsed = parseCron("0,30 9-17/2 * JAN,MAR MON-FRI")
    expect(parsed).toBeDefined()
    expect(parsed!.minutes).toEqual([0, 30])
    expect(parsed!.hours).toEqual([9, 11, 13, 15, 17])
    expect([...parsed!.months]).toEqual([1, 3])
    expect([...parsed!.dows].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(parsed!.domRestricted).toBe(false)
    expect(parsed!.dowRestricted).toBe(true)
  })
})

describe("recurrence engine — properties", () => {
  const naiveBetween = (input: {
    schedule: ScheduledTask.Schedule
    timezone: string | undefined
    from: number
    to: number
    limit: number
  }) => {
    const result: number[] = []
    let cursor = input.from - 1
    for (let index = 0; index < input.limit; index++) {
      const next = nextOccurrence({ schedule: input.schedule, timezone: input.timezone, after: cursor })
      if (next === undefined || next > input.to) break
      result.push(next)
      cursor = next
    }
    return result
  }

  test("bulk occurrencesBetween stays byte-for-byte equivalent to iterative nextOccurrence across DST and cron shapes", () => {
    const cases = [
      {
        schedule: daily([2, 30], [3, 0], [17, 30]),
        timezone: NY,
        from: Date.parse("2026-03-07T00:00:00Z"),
        to: Date.parse("2026-03-10T23:59:59Z"),
      },
      {
        schedule: daily([1, 30]),
        timezone: NY,
        from: Date.parse("2026-10-31T00:00:00Z"),
        to: Date.parse("2026-11-03T23:59:59Z"),
      },
      {
        schedule: weekly([1, 3, 5], [9, 0], [17, 30]),
        timezone: KYIV,
        from: Date.parse("2026-06-01T00:00:00Z"),
        to: Date.parse("2026-06-30T23:59:59Z"),
      },
      {
        schedule: cron("*/15 * * * *"),
        timezone: NY,
        from: Date.parse("2026-03-08T05:30:00Z"),
        to: Date.parse("2026-03-08T10:00:00Z"),
      },
      {
        schedule: cron("0 12 1 * 1"),
        timezone: NY,
        from: Date.parse("2026-06-01T00:00:00Z"),
        to: Date.parse("2026-08-01T23:59:59Z"),
      },
    ]
    for (const value of cases) {
      const input = { ...value, limit: 500 }
      expect(occurrencesBetween(input)).toEqual(naiveBetween(input))
    }
  })

  test("nextOccurrence is strictly greater than `after` for recurring schedules", () => {
    const schedules = [
      daily([9, 0]),
      daily([2, 30], [17, 30]),
      weekly([1, 3, 5], [9, 0]),
      cron("*/15 * * * *"),
      cron("0 0 1 * *"),
      cron("0 0 29 2 *"),
    ]
    for (const schedule of schedules) {
      for (const afterIso of ["2026-03-08T06:30:00Z", "2026-11-01T05:00:00Z", "2026-12-31T23:59:00Z"]) {
        const after = Date.parse(afterIso)
        const next = nextOccurrence({ schedule, timezone: NY, after })
        if (next !== undefined && next <= after) {
          throw new Error(`fixed point: ${JSON.stringify(schedule)} after ${afterIso} -> ${next}`)
        }
      }
    }
  })

  test("occurrencesBetween is inclusive at both ends and bounded by limit", () => {
    const from = Date.parse("2026-06-01T00:00:00Z")
    const to = Date.parse("2026-06-03T23:59:59Z")
    const values = occurrencesBetween({ schedule: daily([9, 0]), timezone: NY, from, to, limit: 10 })
    expect(values).toEqual([
      Date.parse("2026-06-01T13:00:00Z"),
      Date.parse("2026-06-02T13:00:00Z"),
      Date.parse("2026-06-03T13:00:00Z"),
    ])
    expect(
      occurrencesBetween({ schedule: cron("0 * * * *"), timezone: NY, from, to, limit: 3 }),
    ).toHaveLength(3)
  })

  test("jitter is deterministic for a (task, fireFor) pair and stays in range", () => {
    const first = jitterFor("stk_a", 1_700_000_000_000, 60_000)
    expect(jitterFor("stk_a", 1_700_000_000_000, 60_000)).toBe(first)
    expect(jitterFor("stk_b", 1_700_000_000_000, 60_000)).not.toBe(first === 0 ? 0 : first)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThanOrEqual(60_000)
    expect(jitterFor("stk_a", 1, 0)).toBe(0)
  })

  test("describeSchedule is total and human readable", () => {
    expect(describeSchedule(daily([17, 30], [9, 0]))).toBe("daily at 09:00, 17:30")
    expect(describeSchedule(weekly([1, 3], [9, 0]))).toBe("weekly on Mon, Wed at 09:00")
    expect(describeSchedule(cron("0 3 * * *"))).toBe("cron 0 3 * * *")
    expect(describeSchedule({ kind: "once", at: 0 })).toContain("once at")
  })
})
