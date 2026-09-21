import { describe, expect, test } from "bun:test"
import { PairRateLimiter, sourceKey } from "../../src/ofxp/pair-rate-limit"

describe("OFXP public pairing rate limiter", () => {
  test("keys the source bucket only on normalized network address", () => {
    expect(sourceKey("192.0.2.10")).toBe("192.0.2.10")
    expect(sourceKey("::ffff:192.0.2.10")).toBe("192.0.2.10")
    expect(sourceKey("FE80::ABCD%eth0")).toBe("fe80::abcd")
    expect(sourceKey(undefined)).toBe("unknown")
    expect(sourceKey("  ")).toBe("unknown")
  })

  test("enforces the per-source limit independently of peer identity", () => {
    const limiter = new PairRateLimiter(60_000, 3, 100, 512)
    expect(limiter.allow("192.0.2.10", 1_000)).toBe(true)
    expect(limiter.allow("::ffff:192.0.2.10", 1_001)).toBe(true)
    expect(limiter.allow("192.0.2.10", 1_002)).toBe(true)
    expect(limiter.allow("192.0.2.10", 1_003)).toBe(false)
  })

  test("uses one fail-safe bucket when the transport has no remote address", () => {
    const limiter = new PairRateLimiter(60_000, 2, 100, 512)
    expect(limiter.allow(undefined, 1_000)).toBe(true)
    expect(limiter.allow("", 1_001)).toBe(true)
    expect(limiter.allow(undefined, 1_002)).toBe(false)
  })

  test("enforces an independent process-global cap across many sources", () => {
    const limiter = new PairRateLimiter(60_000, 100, 4, 512)
    expect(limiter.allow("192.0.2.1", 1_000)).toBe(true)
    expect(limiter.allow("192.0.2.2", 1_001)).toBe(true)
    expect(limiter.allow("192.0.2.3", 1_002)).toBe(true)
    expect(limiter.allow("192.0.2.4", 1_003)).toBe(true)
    expect(limiter.allow("192.0.2.5", 1_004)).toBe(false)
  })

  test("resets windows deterministically", () => {
    const limiter = new PairRateLimiter(100, 1, 10, 512)
    expect(limiter.allow("192.0.2.10", 1_000)).toBe(true)
    expect(limiter.allow("192.0.2.10", 1_099)).toBe(false)
    expect(limiter.allow("192.0.2.10", 1_100)).toBe(true)
  })

  test("keeps source memory bounded under attacker churn", () => {
    const limiter = new PairRateLimiter(60_000, 100, 10_000, 8)
    for (let index = 0; index < 50; index++) {
      expect(limiter.allow("192.0.2." + index, 1_000 + index)).toBe(true)
      expect(limiter.sourceCount).toBeLessThanOrEqual(8)
    }
  })
})
