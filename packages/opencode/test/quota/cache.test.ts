import { describe, expect, test } from "bun:test"
import { buildResult } from "../../src/quota/format"
import { createQuotaCache, NEXT_REFRESH_NOW } from "../../src/quota/providers/http"

type Cached = ReturnType<typeof buildResult>

describe("QuotaCache.nextRefreshAt", () => {
  test("an empty cache is re-readable immediately", () => {
    const cache = createQuotaCache<Cached>("probe")
    expect(cache.nextRefreshAt()).toBe(NEXT_REFRESH_NOW)
  })

  test("a freshly stored result is blocked for the TTL", () => {
    const cache = createQuotaCache<Cached>("probe")
    const before = Date.now()
    cache.store(buildResult({ providerId: "probe", providerName: "Probe", ok: true, configured: true }))
    const next = cache.nextRefreshAt()
    expect(next).toBeGreaterThanOrEqual(before + 300_000)
    expect(next).toBeLessThanOrEqual(Date.now() + 300_000)
  })

  test("a 429 cooldown outlasts the TTL when Retry-After is longer", () => {
    const cache = createQuotaCache<Cached>("probe")
    cache.coolDown(buildResult({ providerId: "probe", providerName: "Probe", ok: false, configured: true, error: "429" }), 1_200_000)
    const next = cache.nextRefreshAt()
    // 20 min backoff, not the 5 min TTL — this is the case a flat client-side
    // constant gets wrong.
    expect(next).toBeGreaterThanOrEqual(Date.now() + 1_199_000)
    expect(next).toBeLessThanOrEqual(Date.now() + 1_200_000)
  })

  test("Retry-After is capped at the configured maximum", () => {
    const cache = createQuotaCache<Cached>("probe")
    cache.coolDown(buildResult({ providerId: "probe", providerName: "Probe", ok: false, configured: true, error: "429" }), 9_999_999_999)
    expect(cache.nextRefreshAt()).toBeLessThanOrEqual(Date.now() + 3_600_000)
  })

  test("storing a fresh success clears an earlier cooldown", () => {
    const cache = createQuotaCache<Cached>("probe")
    cache.coolDown(buildResult({ providerId: "probe", providerName: "Probe", ok: false, configured: true, error: "429" }), 1_200_000)
    cache.store(buildResult({ providerId: "probe", providerName: "Probe", ok: true, configured: true }))
    expect(cache.nextRefreshAt()).toBeLessThanOrEqual(Date.now() + 300_000)
  })

  test("reset returns to immediately re-readable", () => {
    const cache = createQuotaCache<Cached>("probe")
    cache.store(buildResult({ providerId: "probe", providerName: "Probe", ok: true, configured: true }))
    cache.reset()
    expect(cache.nextRefreshAt()).toBe(NEXT_REFRESH_NOW)
  })

  test("honours custom ttl and cooldown defaults", () => {
    const cache = createQuotaCache<Cached>("probe", { ttlMs: 1_000, cooldownDefaultMs: 2_000 })
    cache.store(buildResult({ providerId: "probe", providerName: "Probe", ok: true, configured: true }))
    expect(cache.nextRefreshAt()).toBeLessThanOrEqual(Date.now() + 1_000)
  })
})
