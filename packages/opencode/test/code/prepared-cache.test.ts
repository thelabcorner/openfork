import { beforeEach, describe, expect, test } from "bun:test"
import { PreparedProgramCache } from "@/code/prepared"

beforeEach(() => PreparedProgramCache.resetForTest())

describe("prepared Code program cache bounds", () => {
  test("enforces 128-entry LRU eviction and refreshes recency on hit", () => {
    for (let index = 0; index < 128; index++) {
      PreparedProgramCache.get(`return ${index}`, `entry-${index}`)
    }
    expect(PreparedProgramCache.stats()).toMatchObject({
      entries: 128,
      hits: 0,
      misses: 128,
      prepares: 128,
    })

    // Refresh entry 0, then force one eviction. Entry 1 becomes the oldest.
    PreparedProgramCache.get("return 0", "entry-0")
    expect(PreparedProgramCache.stats().prepares).toBe(128)
    PreparedProgramCache.get("return 128", "entry-128")
    expect(PreparedProgramCache.stats().entries).toBe(128)
    expect(PreparedProgramCache.stats().prepares).toBe(129)

    const before = PreparedProgramCache.stats()
    PreparedProgramCache.get("return 1", "entry-1")
    const after = PreparedProgramCache.stats()
    expect(after.misses).toBe(before.misses + 1)
    expect(after.prepares).toBe(before.prepares + 1)
    expect(after.entries).toBe(128)
  })

  test("keeps retained source bytes within the 4 MiB aggregate cap", () => {
    const payload = "x".repeat(64 * 1024)
    for (let index = 0; index < 70; index++) {
      // A large comment exercises cache accounting without generating a huge AST.
      PreparedProgramCache.get(`/* ${payload}${index} */\nreturn ${index}`, `large-${index}`)
    }

    const stats = PreparedProgramCache.stats()
    expect(stats.sourceBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(stats.entries).toBeLessThan(70)
    expect(stats.entries).toBeGreaterThan(0)
  })
})
