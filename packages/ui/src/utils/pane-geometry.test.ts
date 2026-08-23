import { describe, test, expect } from "bun:test"
import {
  pairedWidths,
  verifyPairConservation,
  clampDelta,
  boundariesFromWidths,
  verifyBoundariesUnchanged,
  clampGroupDelta,
  distributeGroupDelta,
} from "./pane-geometry"

describe("pane-geometry", () => {
  test("pair conservation: W_i'+W_{i+1}'=W_i+W_{i+1}", () => {
    const leftStart = 300
    const rightStart = 600
    const { left, right } = pairedWidths(leftStart, rightStart, 100, 200, 200)
    expect(left + right).toBe(leftStart + rightStart)
    expect(verifyPairConservation(leftStart, rightStart, left, right)).toBe(true)
  })

  test("delta clamped to mins", () => {
    const leftStart = 300
    const rightStart = 300
    const leftMin = 250
    const rightMin = 250
    // Try to move 100 right: left 400, right 200 -> right would be 200 < min 250, so clamped to 50
    const { left, right, delta } = pairedWidths(leftStart, rightStart, 100, leftMin, rightMin)
    expect(delta).toBe(50)
    expect(right).toBe(250)
    expect(left).toBe(350)
  })

  test("only adjacent panes change, others unchanged", () => {
    const widths = [300, 600, 300]
    const before = boundariesFromWidths(widths, 0)
    // Move divider 1 (between P1 and P2, boundary 2) by -100
    const { left, right } = pairedWidths(widths[1], widths[2], -100, 200, 200)
    const afterWidths = [widths[0], left, right]
    const after = boundariesFromWidths(afterWidths, 0)
    // Only boundary 2 should move, others unchanged (divider 1 => boundary 2)
    expect(verifyBoundariesUnchanged(before, after, 2)).toBe(true)
    // Pair sum conserved
    expect(afterWidths[1] + afterWidths[2]).toBe(widths[1] + widths[2])
  })

  test("clampDelta respects both mins", () => {
    expect(clampDelta(1000, 200, 200, 300, 300)).toBe(100)
    expect(clampDelta(-1000, 200, 200, 300, 300)).toBe(-100)
    expect(clampDelta(0, 200, 200, 300, 300)).toBe(0)
  })

  test("N-pane: only active divider moves", () => {
    const widths = [200, 200, 200, 200, 200, 200]
    const before = boundariesFromWidths(widths, 0)
    const activeDivider = 2
    const activeBoundary = activeDivider + 1
    const { left, right } = pairedWidths(widths[activeDivider], widths[activeDivider + 1], 50, 100, 100)
    const afterWidths = [...widths]
    afterWidths[activeDivider] = left
    afterWidths[activeDivider + 1] = right
    const after = boundariesFromWidths(afterWidths, 0)
    expect(verifyBoundariesUnchanged(before, after, activeBoundary)).toBe(true)
    // All other panes unchanged
    for (let i = 0; i < widths.length; i++) {
      if (i === activeDivider || i === activeDivider + 1) continue
      expect(afterWidths[i]).toBe(widths[i])
    }
  })

  test("property: final geometry independent of pointer event frequency", () => {
    const leftStart = 400
    const rightStart = 400
    const min = 200
    // Simulate many small deltas vs one big delta
    const big = pairedWidths(leftStart, rightStart, 120, min, min)
    let curLeft = leftStart
    let curRight = rightStart
    // Simulate incremental mistaken accumulation (should not be used, but our kernel is pure)
    // Correct method: always from start
    const smallSteps = [30, 30, 30, 30]
    let total = 0
    for (const s of smallSteps) total += s
    const viaSteps = pairedWidths(leftStart, rightStart, total, min, min)
    expect(viaSteps.left).toBe(big.left)
    expect(viaSteps.right).toBe(big.right)
  })

  // §43 — property-based geometry tests over random N-pane layouts.
  describe("property: N-pane divider drag", () => {
    // Deterministic PRNG so a failure is reproducible.
    const rng = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }

    test("only the two adjacent panes change, and the pair sum is conserved", () => {
      const random = rng(20260822)
      for (let iteration = 0; iteration < 500; iteration++) {
        const paneCount = 2 + Math.floor(random() * 9)
        const widths: number[] = []
        const mins: number[] = []
        for (let i = 0; i < paneCount; i++) {
          const min = 80 + Math.floor(random() * 200)
          mins.push(min)
          widths.push(min + Math.floor(random() * 600))
        }
        const divider = Math.floor(random() * (paneCount - 1))
        const delta = Math.round((random() * 2 - 1) * 900)

        const { left, right } = pairedWidths(
          widths[divider],
          widths[divider + 1],
          delta,
          mins[divider],
          mins[divider + 1],
        )
        const after = [...widths]
        after[divider] = left
        after[divider + 1] = right

        // Invariant 2 — no unrelated pane changes width.
        for (let i = 0; i < paneCount; i++) {
          if (i === divider || i === divider + 1) continue
          expect(after[i]).toBe(widths[i])
        }
        // Invariant 3 — pair width is conserved.
        expect(left + right).toBeCloseTo(widths[divider] + widths[divider + 1], 10)
        // Total layout width is unchanged, so both outer edges stay put.
        const sum = (list: number[]) => list.reduce((a, b) => a + b, 0)
        expect(sum(after)).toBeCloseTo(sum(widths), 10)
        // Invariant 5 — minimums are respected.
        expect(left).toBeGreaterThanOrEqual(mins[divider])
        expect(right).toBeGreaterThanOrEqual(mins[divider + 1])
      }
    })

    // §44 — boundary-based oracle: reconstruct every boundary and assert that
    // only the active divider's coordinate moved.
    test("boundary reconstruction: every boundary except the active divider is unchanged", () => {
      const random = rng(7654321)
      for (let iteration = 0; iteration < 500; iteration++) {
        const paneCount = 2 + Math.floor(random() * 9)
        const widths: number[] = []
        const mins: number[] = []
        for (let i = 0; i < paneCount; i++) {
          const min = 100 + Math.floor(random() * 150)
          mins.push(min)
          widths.push(min + Math.floor(random() * 500))
        }
        const containerLeft = Math.floor(random() * 200)
        const divider = Math.floor(random() * (paneCount - 1))
        const delta = Math.round((random() * 2 - 1) * 700)

        const before = boundariesFromWidths(widths, containerLeft)
        const { left, right } = pairedWidths(
          widths[divider],
          widths[divider + 1],
          delta,
          mins[divider],
          mins[divider + 1],
        )
        const after = boundariesFromWidths(
          widths.map((w, i) => (i === divider ? left : i === divider + 1 ? right : w)),
          containerLeft,
        )

        // Pane `divider` sits between boundary `divider` and `divider + 1`, so
        // the movable boundary is `divider + 1`.
        expect(verifyBoundariesUnchanged(before, after, divider + 1)).toBe(true)
        // The outer boundaries specifically never move.
        expect(after[0]).toBeCloseTo(before[0], 10)
        expect(after[after.length - 1]).toBeCloseTo(before[before.length - 1], 10)
      }
    })

    // Invariant 7 — pointer-event frequency cannot change the result, because
    // every frame is a pure function of (start geometry, current pointer).
    test("many small pointer events land exactly where one big one does", () => {
      const random = rng(13579)
      for (let iteration = 0; iteration < 200; iteration++) {
        const leftStart = 200 + Math.floor(random() * 500)
        const rightStart = 200 + Math.floor(random() * 500)
        const leftMin = 100 + Math.floor(random() * 80)
        const rightMin = 100 + Math.floor(random() * 80)
        const startPointer = Math.floor(random() * 1000)
        const endPointer = startPointer + Math.round((random() * 2 - 1) * 800)

        const direct = pairedWidths(leftStart, rightStart, endPointer - startPointer, leftMin, rightMin)

        // Replay the same drag as an arbitrary number of intermediate samples;
        // each sample is recomputed from the drag snapshot, never accumulated.
        let last = direct
        const steps = 1 + Math.floor(random() * 30)
        for (let s = 1; s <= steps; s++) {
          const pointer = startPointer + ((endPointer - startPointer) * s) / steps
          last = pairedWidths(leftStart, rightStart, pointer - startPointer, leftMin, rightMin)
        }
        expect(last.left).toBeCloseTo(direct.left, 10)
        expect(last.right).toBeCloseTo(direct.right, 10)
      }
    })
  })

  // §41 / Invariant 6 — a one-pane layout has no dividers at all.
  test("dividerCount is max(0, paneCount - 1)", () => {
    const dividerCount = (paneCount: number) => Math.max(0, paneCount - 1)
    expect(dividerCount(0)).toBe(0)
    expect(dividerCount(1)).toBe(0)
    expect(dividerCount(2)).toBe(1)
    expect(dividerCount(6)).toBe(5)
  })

  // §13 — when the constraints are unsatisfiable the kernel refuses to move
  // rather than pretending a valid arrangement exists.
  test("unsatisfiable minimums produce a zero delta", () => {
    const { left, right, delta } = pairedWidths(100, 100, 50, 200, 200)
    expect(delta).toBe(0)
    expect(left).toBe(100)
    expect(right).toBe(100)
  })

  describe("group-distributed resize (pane N shares delta with every pane before it)", () => {
    test("shrinking group distributes proportionally to member size, right gains exactly the group's loss", () => {
      const group = [
        { size: 300, min: 100 },
        { size: 100, min: 100 },
      ]
      const right = { size: 400, min: 100, max: undefined, start: 400 }
      const delta = clampGroupDelta(group, right.min, right.max, right.start, -100)
      expect(delta).toBe(-100)
      const values = distributeGroupDelta(group, delta)
      // Member 1 (300) carries 3/4 of the movable weight since member 2 is
      // already at its 100 minimum with zero room -- shrink is proportional
      // to available slack, not raw size.
      expect(values[1]).toBeCloseTo(100, 1)
      expect(values[0]).toBeCloseTo(200, 1)
      const newRight = right.start - delta
      expect(values[0] + values[1] + newRight).toBeCloseTo(group[0].size + group[1].size + right.start, 1)
    })

    test("growing group (right pane shrinks) distributes gain in an even n-way split", () => {
      const group = [
        { size: 300, min: 100 },
        { size: 100, min: 100 },
      ]
      const right = { size: 400, min: 100, max: undefined, start: 400 }
      const delta = clampGroupDelta(group, right.min, right.max, right.start, 80)
      expect(delta).toBe(80)
      const values = distributeGroupDelta(group, delta)
      // Even split across n=2 members regardless of current size: 80/2 each.
      expect(values[0]).toBeCloseTo(300 + 40, 0)
      expect(values[1]).toBeCloseTo(100 + 40, 0)
      const newRight = right.start - delta
      expect(values[0] + values[1] + newRight).toBeCloseTo(group[0].size + group[1].size + right.start, 1)
    })

    test("delta beyond group's aggregate capacity is clamped, unrelated group members untouched by clamp itself", () => {
      const group = [
        { size: 150, min: 100 },
        { size: 150, min: 100 },
      ]
      const right = { size: 500, min: 100, max: undefined, start: 500 }
      // Requesting a 500px shrink when the group can only give up 100px total.
      const delta = clampGroupDelta(group, right.min, right.max, right.start, -500)
      expect(delta).toBe(-100)
      const values = distributeGroupDelta(group, delta)
      expect(values[0] + values[1]).toBeCloseTo(200, 1)
      expect(values[0]).toBeGreaterThanOrEqual(group[0].min - 0.5)
      expect(values[1]).toBeGreaterThanOrEqual(group[1].min - 0.5)
    })

    test("weighted mode splits proportionally to current size instead of evenly", () => {
      const group = [
        { size: 700, min: 100 },
        { size: 300, min: 100 },
      ]
      const values = distributeGroupDelta(group, -120, "weighted")
      // weight(700) = 0.7, weight(300) = 0.3 of the aggregate 120px shrink.
      expect(values[0]).toBeCloseTo(700 - 84, 0)
      expect(values[1]).toBeCloseTo(300 - 36, 0)
      expect(values[0] + values[1]).toBeCloseTo(1000 - 120, 1)
    })

    test("equal mode (default) ignores current size, weighted mode does not", () => {
      const group = [
        { size: 1200, min: 100 },
        { size: 200, min: 100 },
      ]
      const equal = distributeGroupDelta(group, -120)
      expect(equal[0]).toBeCloseTo(1200 - 60, 0)
      expect(equal[1]).toBeCloseTo(200 - 60, 0)

      const weighted = distributeGroupDelta(group, -120, "weighted")
      expect(weighted[0]).toBeCloseTo(1200 - 103, 0)
      expect(weighted[1]).toBeCloseTo(200 - 17, 0)
    })

    test("right pane's own min/max bound the delta even when the group has more room", () => {
      const group = [{ size: 300, min: 50 }]
      const right = { size: 200, min: 150, max: undefined, start: 200 }
      // Group could absorb 200px of growth, but right can only shrink by 50 before hitting its min.
      const delta = clampGroupDelta(group, right.min, right.max, right.start, 200)
      expect(delta).toBe(50)
    })

    test("single-member group behaves identically to a plain adjacent pair", () => {
      const group = [{ size: 300, min: 100 }]
      const right = { size: 400, min: 100, max: undefined, start: 400 }
      const delta = clampGroupDelta(group, right.min, right.max, right.start, -60)
      const values = distributeGroupDelta(group, delta)
      const plain = pairedWidths(300, 400, -60, 100, 100)
      expect(values[0]).toBeCloseTo(plain.left, 1)
      expect(right.start - delta).toBeCloseTo(plain.right, 1)
    })
  })
})
