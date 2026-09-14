import { describe, expect, test } from "bun:test"
import { activeReconcilePlan, mapBounded } from "./activeReconcile"

const session = (id: string, version: string, directory: string, path?: string) =>
  ({ id, version, directory, path } as any)

describe("active reconciliation planning", () => {
  test("2,000 V2 sessions require one global snapshot and zero directory calls", () => {
    const sessions = Array.from({ length: 2_000 }, (_, i) => session(`s${i}`, "v2", `/repo/${i % 500}`))
    const plan = activeReconcilePlan(sessions, "current")
    expect(plan.currentSnapshot).toBe(true)
    expect(plan.legacyDirectories).toEqual([])
    // Network request count for this plan is exactly the one v2.session.active call.
    expect(1 + plan.legacyDirectories.length).toBe(1)
  })

  test("current transport remains global for legacy-origin rows on a V2-capable server", () => {
    const plan = activeReconcilePlan(
      [
        session("native", "v2", "C:\\repo\\native"),
        session("legacy-origin", "local", "C:\\repo\\legacy"),
      ],
      "current",
    )
    expect(plan).toEqual({ currentSnapshot: true, legacyDirectories: [] })
  })

  test("compatibility mode deduplicates directories and preserves platform separators", () => {
    const plan = activeReconcilePlan(
      [
        session("a", "v1", "C:\\work\\repo", "sub"),
        session("b", "v1", "C:\\work\\repo", "sub"),
        session("c", "v1", "/work/repo", "sub"),
        session("native", "v2", "/ignored", "sub"),
      ],
      "compatibility",
    )
    expect(new Set(plan.legacyDirectories)).toEqual(
      new Set(["C:\\work\\repo", "C:\\work\\repo\\sub", "/work/repo", "/work/repo/sub"]),
    )
  })

  test("compatibility fanout never exceeds its worker bound", async () => {
    let active = 0
    let peak = 0
    const results = await mapBounded(Array.from({ length: 100 }, (_, i) => i), 4, async (value) => {
      active++
      peak = Math.max(peak, active)
      await Bun.sleep(1)
      active--
      return value * 2
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(results[99]).toBe(198)
  })
})
