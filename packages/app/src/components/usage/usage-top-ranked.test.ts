import { describe, expect, test } from "bun:test"
import { topRanked } from "./usage-top-ranked"

describe("topRanked", () => {
  test("matches stable descending sort and filter across many items and ties", () => {
    const rows = Array.from({ length: 10_000 }, (_, id) => ({ id, score: (id * 7919) % 97 }))
    for (const limit of [0, 1, 5, 50, 20_000]) {
      const expected = rows
        .filter((row) => row.score > 4)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      expect(topRanked(rows, limit, (row) => row.score, (row) => row.score > 4)).toEqual(expected)
    }
  })

  test("preserves the original input and filters before ranking", () => {
    const rows = [{ score: 2 }, { score: 10 }, { score: 10 }, { score: 1 }]
    expect(topRanked(rows, 2, (row) => row.score, (row) => row.score < 10)).toEqual([rows[0], rows[3]])
    expect(rows.map((row) => row.score)).toEqual([2, 10, 10, 1])
  })
})