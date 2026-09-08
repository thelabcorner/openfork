import { describe, expect, test } from "bun:test"
import { changedFingerprints, toolReloadNeedsPolling, type Fingerprint } from "../../src/tool/reload"

const fp = (size: number, hash: string): Fingerprint => ({ size, hash })

describe("tool reload watcher safety", () => {
  test("full native watcher coverage disables fallback polling", () => {
    expect(toolReloadNeedsPolling(true, 2, 2)).toBe(false)
  })

  test("missing or partial native coverage enables fallback polling", () => {
    expect(toolReloadNeedsPolling(false, 2, 0)).toBe(true)
    expect(toolReloadNeedsPolling(true, 2, 1)).toBe(true)
    expect(toolReloadNeedsPolling(true, 0, 0)).toBe(true)
  })

  test("seeded fingerprint baseline does not mark existing unchanged files dirty", () => {
    const baseline = new Map([
      ["a.ts", fp(10, "aaa")],
      ["b.js", fp(20, "bbb")],
    ])
    const current = new Map(baseline)
    expect(changedFingerprints(baseline, current)).toEqual([])
  })

  test("fingerprint diff reports additions, changes, and removals once", () => {
    const previous = new Map([
      ["same.ts", fp(10, "same")],
      ["changed.ts", fp(10, "old")],
      ["removed.ts", fp(5, "gone")],
    ])
    const current = new Map([
      ["same.ts", fp(10, "same")],
      ["changed.ts", fp(11, "new")],
      ["added.ts", fp(7, "add")],
    ])

    expect(new Set(changedFingerprints(previous, current))).toEqual(new Set(["changed.ts", "added.ts", "removed.ts"]))
  })
})
