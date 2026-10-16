import { describe, expect, test } from "bun:test"
import { sortedUsagePrefix, type UsageSortValue } from "./usage-prefix-sort"

type Row = { id: number; key: UsageSortValue }
const legacy = (rows: Row[], limit: number, direction: "asc" | "desc") => {
  const sign = direction === "asc" ? 1 : -1
  return [...rows]
    .sort((a, b) =>
      (typeof a.key === "string" || typeof b.key === "string"
        ? String(a.key).localeCompare(String(b.key))
        : (a.key - (b.key as number))) * sign,
    )
    .slice(0, limit)
    .map((row) => row.id)
}

describe("sortedUsagePrefix", () => {
  test("never modifies input and handles empty/complete prefixes", () => {
    const rows = [{ id: 0, key: 1 }, { id: 1, key: 4 }, { id: 2, key: 2 }]
    expect(sortedUsagePrefix(rows, 0, (row) => row.key, "desc")).toEqual([])
    expect(sortedUsagePrefix(rows, 99, (row) => row.key, "desc").map((row) => row.id)).toEqual([1, 2, 0])
    expect(rows.map((row) => row.id)).toEqual([0, 1, 2])
  })

  test("preserves original order among equal keys across heap boundaries", () => {
    const rows = Array.from({ length: 10_000 }, (_, id) => ({ id, key: id % 7 }))
    for (const direction of ["asc", "desc"] as const)
      for (const limit of [1, 5, 40, 50, 200, 3000, 9000, 10_000])
        expect(sortedUsagePrefix(rows, limit, (row) => row.key, direction).map((row) => row.id)).toEqual(
          legacy(rows, limit, direction),
        )
  })

  test("agrees with the legacy table comparator for randomized numeric data", () => {
    let state = 42
    const next = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const rows = Array.from({ length: 12_345 }, (_, id) => ({
      id,
      key: Math.floor(next() * 800) / 8,
    }))
    for (const direction of ["asc", "desc"] as const)
      for (const limit of [1, 5, 50, 200, 500, 4000, 12_345])
        expect(sortedUsagePrefix(rows, limit, (row) => row.key, direction).map((row) => row.id)).toEqual(
          legacy(rows, limit, direction),
        )
  })

  test("preserves fully sorted and almost-sorted input without mutating it", () => {
    const rows = Array.from({ length: 20_000 }, (_, id) => ({ id, key: 20_000 - Math.floor(id / 3) }))
    const nearlySorted = rows.slice()
    ;[nearlySorted[5_000], nearlySorted[15_000]] = [nearlySorted[15_000], nearlySorted[5_000]]
    for (const input of [rows, nearlySorted])
      for (const direction of ["asc", "desc"] as const)
        for (const limit of [5, 50, 200, 10_000])
          expect(sortedUsagePrefix(input, limit, (row) => row.key, direction).map((row) => row.id)).toEqual(
            legacy(input, limit, direction),
          )
    expect(rows[0].id).toBe(0)
    expect(nearlySorted[5_000].id).toBe(15_000)
  })

  test("supports collation, string/number crossover, and nonfinite values", () => {
    const strings: Row[] = ["omega", "Álpha", "alpha", "模型", "Beta", "alpha", 4, "4", "10"].map(
      (key, id) => ({ id, key }),
    )
    const numbers: Row[] = [0, Infinity, -Infinity, 9, 9, -5, 10, 1].map((key, id) => ({ id, key }))
    const invalid: Row[] = [4, Number.NaN, 0, 2, Number.NaN, 5].map((key, id) => ({ id, key }))
    for (const rows of [strings, numbers, invalid])
      for (const direction of ["asc", "desc"] as const)
        for (const limit of [1, 3, rows.length - 1, rows.length])
          expect(sortedUsagePrefix(rows, limit, (row) => row.key, direction).map((row) => row.id)).toEqual(
            legacy(rows, limit, direction),
          )
  })

  test("maintains the maintenance table's cost tiebreak when ranking by tokens", () => {
    const rows = Array.from({ length: 2_000 }, (_, id) => ({
      id,
      totalTokens: id % 17,
      cost: (id * 31) % 101,
    })).sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
    const expected = [...rows]
      .sort((a, b) => b.totalTokens - a.totalTokens || b.cost - a.cost)
      .slice(0, 50)
      .map((row) => row.id)
    expect(sortedUsagePrefix(rows, 50, (row) => row.totalTokens, "desc").map((row) => row.id)).toEqual(expected)
  })
})