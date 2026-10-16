import { describe, expect, test } from "bun:test"
import { createContextTotalsRevisionCache } from "./totals-cache"

describe("Context totals revision cache", () => {
  test("requires both the event sequence and the native SQLite data version", () => {
    const cache = createContextTotalsRevisionCache<{ messageCount: number }>(2)
    const connection = {}
    const second = {}
    const totals = { messageCount: 12 }
    cache.store(connection, "s", { eventSeq: 17, dataVersion: 4, totals })
    expect(cache.lookup(connection, "s", 17, 4)).toEqual({ hit: true, totals })
    expect(cache.lookup(connection, "s", 18, 4).hit).toBe(false)
    expect(cache.lookup(connection, "s", 17, 5).hit).toBe(false)
    expect(cache.lookup(second, "s", 17, 4).hit).toBe(false)
    cache.store(connection, "s", { eventSeq: 18, dataVersion: 5, totals: undefined })
    expect(cache.lookup(connection, "s", 18, 5)).toEqual({ hit: true, totals: undefined })
    expect(cache.lookup(connection, "s", 17, 4).hit).toBe(false)
  })

  test("bounds per-connection entries with recency-preserving eviction", () => {
    const cache = createContextTotalsRevisionCache<number>(3)
    const connection = {}
    cache.store(connection, "a", { eventSeq: 1, dataVersion: 1, totals: 1 })
    cache.store(connection, "b", { eventSeq: 1, dataVersion: 1, totals: 2 })
    cache.store(connection, "c", { eventSeq: 1, dataVersion: 1, totals: 3 })
    expect(cache.lookup(connection, "a", 1, 1).hit).toBe(true)
    cache.store(connection, "d", { eventSeq: 1, dataVersion: 1, totals: 4 })
    expect(cache.lookup(connection, "b", 1, 1).hit).toBe(false)
    expect(cache.lookup(connection, "a", 1, 1).hit).toBe(true)
    expect(cache.lookup(connection, "c", 1, 1).hit).toBe(true)
    expect(cache.lookup(connection, "d", 1, 1).hit).toBe(true)
  })

  test("refuses invalid capacities", () => {
    expect(() => createContextTotalsRevisionCache(0)).toThrow("capacity")
    expect(() => createContextTotalsRevisionCache(-1)).toThrow("capacity")
    expect(() => createContextTotalsRevisionCache(NaN)).toThrow("capacity")
  })
})
