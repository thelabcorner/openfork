import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { summarizeUsageActivity } from "./activity-summary"

const day = (year: number, month: number, date: number) =>
  new Date(year, month - 1, date).getTime()
const active = (year: number, month: number, date: number, messages = 1) =>
  ({ start: day(year, month, date), messages })

describe("summarizeUsageActivity", () => {
  test("summarizes complete history independently of a last-500 heatmap cap", () => {
    const days = Array.from({ length: 620 }, (_, i) => {
      const d = new Date(2024, 0, 1)
      d.setDate(d.getDate() + i)
      return { start: d.getTime(), messages: i === 20 ? 15 : 1 }
    })
    const full = summarizeUsageActivity(days)
    expect(full.activeDays).toBe(620)
    expect(full.longestStreak).toBe(620)
    expect(full.busiestDay).toEqual(days[20])
    expect(summarizeUsageActivity(days.slice(-500)).activeDays).toBe(500)
  })

  test("sparse dates break streaks; identical busiest ties retain first", () => {
    const days = [
      active(2026, 3, 6, 9),
      active(2026, 3, 7, 1),
      active(2026, 3, 9, 9),
      active(2026, 3, 10, 2),
      active(2026, 3, 11, 3),
      active(2026, 3, 15, 1),
    ]
    expect(summarizeUsageActivity(days)).toEqual({
      activeDays: 6, longestStreak: 3, busiestDay: days[0],
    })
  })

  test("successor uses actual local calendar dates across spring and fall DST", () => {
    for (const dates of [[7, 8, 9], [31, 1, 2]]) {
      const rows = dates[0] === 7
        ? dates.map(d => active(2026, 3, d))
        : [active(2026, 10, 31), active(2026, 11, 1), active(2026, 11, 2)]
      expect(summarizeUsageActivity(rows).longestStreak).toBe(3)
    }
  })

  test("23/25-hour DST boundaries under a real Chicago time-zone process", () => {
    // Do not change the parent test runner's TZ: unrelated tests may run in
    // parallel and must not inherit a transient global locale mutation.
    const program = `
      const { summarizeUsageActivity } = await import("./src/usage/activity-summary.ts")
      const midnight = (month,date) => new Date(2026,month,date).getTime()
      const spring = [midnight(2,7),midnight(2,8),midnight(2,9)]
      const fall = [midnight(9,31),midnight(10,1),midnight(10,2)]
      console.log(JSON.stringify({
        springGap: spring[2]-spring[1],
        fallGap: fall[2]-fall[1],
        springStreak: summarizeUsageActivity(spring.map(start=>({start,messages:1}))).longestStreak,
        fallStreak: summarizeUsageActivity(fall.map(start=>({start,messages:1}))).longestStreak
      }))
    `
    const result = spawnSync(process.execPath, ["-e", program], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: "America/Chicago" },
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({
      springGap: 23 * 3_600_000,
      fallGap: 25 * 3_600_000,
      springStreak: 3,
      fallStreak: 3,
    })
  })

  test("empty records do not count active days", () => {
    expect(summarizeUsageActivity([])).toEqual({
      activeDays: 0, longestStreak: 0, busiestDay: null,
    })
    expect(summarizeUsageActivity([active(2026, 1, 1, 0)])).toEqual({
      activeDays: 0, longestStreak: 0, busiestDay: null,
    })
  })

  test("random sparse local calendars agree with an independent ordinal-day oracle", () => {
    let seed = 0xa13f7021
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return seed >>> 0
    }
    for (let sample = 0; sample < 120; sample++) {
      const rows: { start: number; messages: number }[] = []
      let streak = 0
      let longestStreak = 0
      let busiest: { start: number; messages: number } | null = null
      for (let ordinal = 0; ordinal < 365; ordinal++) {
        const timestamp = new Date(2024, 0, 1)
        timestamp.setDate(timestamp.getDate() + ordinal)
        timestamp.setHours(0, 0, 0, 0)
        const count = random() % 5 === 0 ? 0 : 1 + random() % 12
        if (count === 0) {
          streak = 0
          continue
        }
        const row = { start: timestamp.getTime(), messages: count }
        rows.push(row)
        streak++
        longestStreak = Math.max(longestStreak, streak)
        if (!busiest || count > busiest.messages) busiest = row
      }
      expect(summarizeUsageActivity(rows)).toEqual({
        activeDays: rows.length,
        longestStreak,
        busiestDay: busiest,
      })
    }
  })
})
