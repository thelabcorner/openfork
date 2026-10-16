import { describe, expect, test } from "bun:test"
import { createToolMetadataThrottle } from "../../src/session/tool-metadata-throttle"

describe("tool metadata lifecycle throttling", () => {
  test("never drops the queued -> executing transition of a silent foreground shell", () => {
    const accept = createToolMetadataThrottle(500)
    const queued = { queueStartedAt: 1_000, output: "" }
    const executing = { ...queued, startedAt: 1_004 }

    expect(accept("shell-call", queued, 1_000)).toBe(true)
    expect(accept("shell-call", executing, 1_004)).toBe(true)
    // No stdout is required for execution to become visible.
    expect(accept("shell-call", { ...executing, output: "progress" }, 1_005)).toBe(false)
    expect(accept("shell-call", { ...executing, output: "later" }, 1_505)).toBe(true)
  })

  test("repeated previews remain bounded even when they carry startedAt", () => {
    const accept = createToolMetadataThrottle(500)
    const meta = { queueStartedAt: 1, startedAt: 2 }
    expect(accept("shell", { queueStartedAt: 1 }, 1)).toBe(true)
    expect(accept("shell", meta, 2)).toBe(true)
    let published = 0
    for (let t = 3; t < 500; t++) {
      if (accept("shell", { ...meta, output: `chunk-${t}` }, t)) published++
    }
    expect(published).toBe(0)
    expect(accept("shell", meta, 502)).toBe(true)
  })

  test("unrelated call IDs are independent; ordinary tool metadata still throttles", () => {
    const accept = createToolMetadataThrottle(500)
    expect(accept("first", { output: "one" }, 10)).toBe(true)
    expect(accept("first", { output: "two" }, 15)).toBe(false)
    expect(accept("second", { output: "one" }, 15)).toBe(true)
    expect(accept(undefined, { output: "no identity" }, 16)).toBe(true)
    expect(accept("first", { output: "three" }, 510)).toBe(true)
  })

  test("does not trust invalid timestamps or throttle indefinitely after a clock jump", () => {
    const accept = createToolMetadataThrottle(500)
    expect(accept("shell", { queueStartedAt: Number.NaN }, 1_000)).toBe(true)
    expect(accept("shell", { queueStartedAt: Number.NaN, startedAt: 1_001 }, 1_002)).toBe(false)
    expect(accept("shell", { queueStartedAt: 1_005 }, 1_005)).toBe(true)
    expect(accept("shell", { queueStartedAt: 1_005, startedAt: 1_006 }, 1_006)).toBe(true)
    expect(accept("shell", { queueStartedAt: 1_005, startedAt: 1_006 }, 20)).toBe(true)
  })
})
