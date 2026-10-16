import { describe, expect, test } from "bun:test"
import { usageSummaryServerCacheKey } from "../../src/usage/summary-cache-key"

const now = 1_800_000_000_000
const base = {
  database: "/tmp/openfork.db",
  resolution: "hour",
  projectID: null,
  ttlMs: 30_000,
  now,
}

describe("usage summary server cache identity", () => {
  test("reuses nearby rolling windows for their bounded TTL", () => {
    const a = usageSummaryServerCacheKey({ ...base, since: now - 3_600_000, until: now })
    const b = usageSummaryServerCacheKey({ ...base, since: now - 3_599_850, until: now + 150 })
    expect(a).toBe(b)
    expect(a).not.toBe(usageSummaryServerCacheKey({ ...base, since: 0, until: now }))
  })
  test("does not conflate equal-length fixed historical windows", () => {
    const a = usageSummaryServerCacheKey({ ...base, since: now - 120_000, until: now - 90_000 })
    const b = usageSummaryServerCacheKey({ ...base, since: now - 90_000, until: now - 60_000 })
    expect(a).not.toBe(b)
    const c = usageSummaryServerCacheKey({ ...base, since: now - 3_600_000, until: now - 60_000 })
    expect(a).not.toBe(c)
  })
  test("isolates database, project, and resolution", () => {
    const request = { ...base, since: 0, until: now }
    const key = usageSummaryServerCacheKey(request)
    expect(key).not.toBe(usageSummaryServerCacheKey({ ...request, database: "/tmp/other.db" }))
    expect(key).not.toBe(usageSummaryServerCacheKey({ ...request, projectID: "prj-2" }))
    expect(key).not.toBe(usageSummaryServerCacheKey({ ...request, resolution: "day" }))
    expect(key).not.toBe(usageSummaryServerCacheKey({ ...request, since: now - 86_400_000 }))
  })
  test("does not round fixed intervals outside the live horizon", () => {
    const request = { ...base, since: now - 10_000_000, until: now - 100_000 }
    expect(usageSummaryServerCacheKey(request))
      .not.toBe(usageSummaryServerCacheKey({ ...request, until: request.until + 1, since: request.since + 1 }))
  })
})
