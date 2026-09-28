import { describe, expect, test } from "bun:test"
import { buildRetryPolicy, busyBuildRetryDelay, failedBuildRetryDelay } from "./node-sidecar-build-retry"

describe("node sidecar build retry policy", () => {
  test("backs off a busy runtime transaction without hot-looping", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(busyBuildRetryDelay)).toEqual([
      250,
      500,
      1_000,
      2_000,
      4_000,
      5_000,
      5_000,
      5_000,
    ])
    expect(busyBuildRetryDelay(buildRetryPolicy.busyRetries - 1)).toBe(5_000)
    expect(busyBuildRetryDelay(buildRetryPolicy.busyRetries)).toBeUndefined()
    expect(busyBuildRetryDelay(-1)).toBeUndefined()
    expect(buildRetryPolicy.busyMaxDelayMs).toBe(5_000)
    expect(buildRetryPolicy.busyRetries).toBe(24)
  })

  test("bounds ordinary failure retries and then waits for a source change", () => {
    expect([0, 1, 2, 3, 4].map(failedBuildRetryDelay)).toEqual([1_000, 5_000, 15_000, undefined, undefined])
    expect(failedBuildRetryDelay(-1)).toBeUndefined()
    expect(failedBuildRetryDelay(0.5)).toBeUndefined()
    expect(buildRetryPolicy.failureRetries).toBe(3)
  })
})
