import { describe, expect, test } from "bun:test"
import {
  chooseCompactionArm,
  estimateCompactionCost,
  type CompactionArm,
} from "../../src/session/lace-compaction-plan"

function arm(kind: CompactionArm["kind"], overrides: Partial<CompactionArm> = {}): CompactionArm {
  return {
    kind,
    authorized: true,
    fitsContext: true,
    authorityPreserved: true,
    toolHistoryClosed: true,
    reasoningCompatible: true,
    parentRouteCompatible: true,
    input: {
      historicalTokens: 80000,
      newTokens: 1000,
      hitProbability: kind === "isolated" ? 0 : 0.95,
      ordinaryPrice: 1,
      cacheReadPrice: 0.1,
      cacheMissPrice: 1,
    },
    output: { expectedTokens: 2000, price: 1 },
    ...overrides,
  }
}

describe("LACE v14.7 competing compaction strategies", () => {
  test("prefers actual parent-prefix reuse when route and model support it", () => {
    const result = chooseCompactionArm(arm("isolated"), arm("parent-prefix-fork"))
    expect(result.choice).toBe("parent-prefix-fork")
    expect(result.forkCost).toBeLessThan(result.isolatedCost!)
  })

  test("a cheaper isolated compaction model can defeat a warm parent fork", () => {
    const isolated = arm("isolated", {
      input: { ...arm("isolated").input, historicalTokens: 20000, ordinaryPrice: 0.2, cacheMissPrice: 0.2 },
      output: { expectedTokens: 2000, price: 0.3 },
    })
    expect(chooseCompactionArm(isolated, arm("parent-prefix-fork")).choice).toBe("isolated")
  })

  test("incompatible route, reasoning, unsettled tools, or overflow reject parent fork", () => {
    const base = arm("parent-prefix-fork")
    for (const mutation of [
      { parentRouteCompatible: false },
      { reasoningCompatible: false },
      { authorityPreserved: false },
      { toolHistoryClosed: false },
      { fitsContext: false },
      { authorized: false },
    ]) {
      const result = chooseCompactionArm(arm("isolated"), { ...base, ...mutation })
      expect(result.choice).toBe("isolated")
      expect(result.forkCost).toBe(null)
    }
  })

  test("default strategy is stable under insufficient savings", () => {
    const base = chooseCompactionArm(arm("isolated"), arm("parent-prefix-fork"))
    const savings = base.isolatedCost! - base.forkCost!
    expect(chooseCompactionArm(arm("isolated"), arm("parent-prefix-fork"), savings).choice).toBe("isolated")
  })

  test("both invalid means no request may be issued", () => {
    const isolated = arm("isolated", { authorized: false })
    const fork = arm("parent-prefix-fork", { authorized: false })
    expect(chooseCompactionArm(isolated, fork).choice).toBe("none")
    expect(estimateCompactionCost(fork)).toBeUndefined()
  })

  test("nonfinite prices and impossible hit probabilities fail closed", () => {
    const fork = arm("parent-prefix-fork")
    expect(() => estimateCompactionCost({ ...fork, input: { ...fork.input, hitProbability: 1.1 } })).toThrow(RangeError)
    expect(() => estimateCompactionCost({ ...fork, input: { ...fork.input, cacheReadPrice: Infinity } })).toThrow(RangeError)
    expect(() => chooseCompactionArm(arm("isolated"), fork, -1)).toThrow(RangeError)
  })
})
