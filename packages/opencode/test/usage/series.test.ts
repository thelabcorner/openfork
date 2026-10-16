import { describe, expect, test } from "bun:test"
import { rollupUsagePeriods, topUsageBy, topUsageSeries, usageBucketFloor, usageModelSeriesBudget } from "../../src/usage/series"

describe("model series wire budget", () => {
  test("counts all three numeric arrays rather than one per model", () => {
    for (const periodCount of [1, 4, 30, 365, 400, 1000]) {
      const models = usageModelSeriesBudget(60_000, periodCount)
      expect(models * periodCount * 3).toBeLessThanOrEqual(60_000)
      expect((models + 1) * periodCount * 3).toBeGreaterThan(60_000)
    }
    expect(usageModelSeriesBudget(60_000, 400)).toBe(50)
    expect(usageModelSeriesBudget(60_000, 30)).toBe(666)
    expect(usageModelSeriesBudget(0, 400)).toBe(0)
    expect(usageModelSeriesBudget(60_000, 0)).toBe(0)
    expect(usageModelSeriesBudget(Number.NaN, 400)).toBe(0)
  })
})

describe("rollupUsagePeriods", () => {
  test("preserves maintenance request totals without introducing a messages field", () => {
    const input = Array.from({ length: 1200 }, (_, i) => ({
      start: 1_000 + i * 60_000,
      requests: i % 4,
      cost: i * 0.25,
      tokens: i * 100,
    }))
    const compact = rollupUsagePeriods(input, 400, "requests")
    expect(compact).toHaveLength(400)
    expect(compact.every((row) => !("messages" in row))).toBe(true)
    expect(compact.reduce((sum, row) => sum + row.requests, 0))
      .toBe(input.reduce((sum, row) => sum + row.requests, 0))
    expect(compact.reduce((sum, row) => sum + row.tokens, 0))
      .toBe(input.reduce((sum, row) => sum + row.tokens, 0))
    expect(compact.reduce((sum, row) => sum + row.cost, 0))
      .toBe(input.reduce((sum, row) => sum + row.cost, 0))
    expect(rollupUsagePeriods(input, 1, "requests"))
      .toEqual([{ start: input[0]!.start, requests: 1800, cost: 179850, tokens: 71940000 }])
  })
  test("is identity at or below the cap", () => {
    const input = Array.from({ length: 400 }, (_, i) => ({ start: i, cost: 0.01, tokens: 10, messages: 1 }))
    expect(rollupUsagePeriods(input, 400, "messages")).toBe(input)
    expect(rollupUsagePeriods(input, 500, "messages")).toBe(input)
  })
  test("conserves cost, tokens, and turns across the 400-to-401 boundary", () => {
    for (const count of [401, 500, 801, 10_000]) {
      const source = Array.from({ length: count }, (_, i) => ({
        start: 1_000 + i * 3_600_000,
        cost: i % 2 === 0 ? 1 : 2,
        tokens: i + 1,
        messages: i % 3,
      }))
      const compact = rollupUsagePeriods(source, 400, "messages")
      expect(compact.length).toBe(400)
      expect(compact[0]?.start).toBe(source[0]?.start)
      expect(compact.at(-1)?.start).toBe(source.at(-1)?.start)
      expect(compact.reduce((sum, row) => sum + row.cost, 0)).toBe(source.reduce((sum, row) => sum + row.cost, 0))
      expect(compact.reduce((sum, row) => sum + row.tokens, 0)).toBe(source.reduce((sum, row) => sum + row.tokens, 0))
      expect(compact.reduce((sum, row) => sum + row.messages, 0)).toBe(source.reduce((sum, row) => sum + row.messages, 0))
      // Provider/model series use the same floor boundary mapping. Every
      // source entry must land in the exact bucket used for the total.
      const expected = Array.from({ length: 400 }, () => ({ cost: 0, tokens: 0, messages: 0 }))
      for (const item of source) {
        const at = usageBucketFloor(compact, item.start)
        expected[at]!.cost += item.cost
        expected[at]!.tokens += item.tokens
        expected[at]!.messages += item.messages
      }
      expect(compact.map(({ cost, tokens, messages }) => ({ cost, tokens, messages }))).toEqual(expected)
    }
  })
  test("handles zero and singleton display budgets", () => {
    const data = [0, 1, 2].map((i) => ({ start: i, cost: 5, tokens: 100, messages: 2 }))
    expect(rollupUsagePeriods(data, 0, "messages")).toEqual([])
    expect(rollupUsagePeriods(data, 1, "messages")).toEqual([{ start: 0, cost: 15, tokens: 300, messages: 6 }])
  })
})

describe("topUsageBy session ranking", () => {
  test("returns the same stable top K as sorting all sessions", () => {
    const sessions = Array.from({ length: 12_000 }, (_, i) => ({
      id: `session-${i}`,
      tokens: i % 11 === 0 ? 50 : (i * 271) % 1000,
    }))
    for (const count of [0, 1, 10, 50, 500, sessions.length, sessions.length + 1]) {
      let scoreCalls = 0
      const actual = topUsageBy(sessions, count, (session) => {
        scoreCalls++
        return session.tokens
      })
      const expected = [...sessions].sort((a, b) => b.tokens - a.tokens).slice(0, count)
      expect(actual).toEqual(expected)
      expect(scoreCalls).toBe(count === 0 ? 0 : sessions.length)
    }
    expect(sessions[0]?.id).toBe("session-0")
  })
  test("supports empty inputs and stable tie ordering", () => {
    expect(topUsageBy([], 50, () => 0)).toEqual([])
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, score: 4 }))
    expect(topUsageBy(items, 6, (value) => value.score).map((value) => value.id)).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe("usageBucketFloor", () => {
  const starts = [100, 200, 350, 700].map((start) => ({ start }))
  test("preserves legacy left-inclusive bucket boundaries", () => {
    const values = [-1, 0, 99, 100, 101, 199, 200, 349, 350, 699, 700, 701, 9999]
    for (const value of values) {
      let expected = starts.length - 1
      while (expected > 0 && starts[expected]!.start > value) expected--
      if (starts[expected]!.start > value) expected = -1
      expect(usageBucketFloor(starts, value)).toBe(expected)
    }
  })
  test("handles empty and singleton displays", () => {
    expect(usageBucketFloor([], 100)).toBe(-1)
    expect(usageBucketFloor([{ start: 4 }], 3)).toBe(-1)
    expect(usageBucketFloor([{ start: 4 }], 4)).toBe(0)
  })
  test("agrees with reference for randomized sorted input", () => {
    for (let size = 0; size < 140; size++) {
      const list = Array.from({ length: size }, (_, i) => ({ start: 15 * i }))
      for (let stamp = -20; stamp < size * 15 + 20; stamp += 7) {
        const expected = list.reduce((index, period, i) => period.start <= stamp ? i : index, -1)
        expect(usageBucketFloor(list, stamp)).toBe(expected)
      }
    }
  })
})

describe("topUsageSeries", () => {
  function reference(data: Map<string, Map<number, { messages: number }>>, limit: number) {
    return [...data.entries()]
      .sort((a, b) => {
        let am = 0
        let bm = 0
        for (const bucket of a[1].values()) am += bucket.messages
        for (const bucket of b[1].values()) bm += bucket.messages
        return bm - am
      })
      .slice(0, limit)
  }
  test("handles no data, no budget, full budget", () => {
    const rows = new Map([["a", new Map([[0, { messages: 2 }]])], ["b", new Map([[1, { messages: 9 }]])]])
    expect(topUsageSeries(rows, 0)).toEqual([])
    expect(topUsageSeries(new Map(), 10)).toEqual([])
    expect(topUsageSeries(rows, 99)).toEqual(reference(rows, 99))
  })
  test("preserves original order on equal weights", () => {
    const rows = new Map(Array.from({ length: 100 }, (_, i) => [
      `k${i}`,
      new Map([[1, { messages: 1 }], [2, { messages: 5 }]]),
    ] as const))
    expect(topUsageSeries(rows, 8).map(([key]) => key)).toEqual(Array.from({ length: 8 }, (_, i) => `k${i}`))
  })
  test("matches stable full sorting across randomized sizes and ties", () => {
    let seed = 1714
    const random = () => ((seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 4294967296)
    for (const size of [1, 2, 3, 10, 31, 129, 1000]) {
      for (const tieChance of [0, 1]) {
        const rows = new Map<string, Map<number, { messages: number }>>()
        for (let i = 0; i < size; i++) {
          const periods = new Map<number, { messages: number }>()
          for (let j = 0; j < 16; j++) periods.set(j, { messages: tieChance ? i % 5 : Math.floor(random() * 120) })
          rows.set(`model${i}`, periods)
        }
        for (const limit of [0, 1, 3, 8, 50, 2000]) {
          expect(topUsageSeries(rows, limit)).toEqual(reference(rows, limit))
        }
        expect(rows.size).toBe(size)
      }
    }
  })
})
