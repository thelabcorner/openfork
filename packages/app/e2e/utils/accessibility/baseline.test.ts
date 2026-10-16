import { describe, expect, test } from "bun:test"
import type { A11yViolation } from "./axe"
import { KNOWN_ACCESSIBILITY_DEBT, normalizeBaselineTarget, partitionViolations } from "./baseline"

function violation(rule: string, ...targets: string[]): A11yViolation {
  return {
    rule,
    impact: "serious",
    help: "",
    helpUrl: "",
    targets,
    nodes: targets.length,
  }
}

describe("accessibility debt baseline", () => {
  test("acknowledges a reviewed finding and reports no regression", () => {
    const known = KNOWN_ACCESSIBILITY_DEBT[0]
    const result = partitionViolations([violation(known.rule, known.target)])
    expect(result.acknowledged).toHaveLength(1)
    expect(result.regressed).toEqual([])
  })

  test("treats the same rule on a different element as a regression", () => {
    const known = KNOWN_ACCESSIBILITY_DEBT[0]
    const result = partitionViolations([violation(known.rule, 'button[data-component="something-else"]')])
    expect(result.regressed).toHaveLength(1)
    expect(result.acknowledged).toEqual([])
  })

  test("treats an unreviewed rule as a regression", () => {
    const result = partitionViolations([violation("label", "div")])
    expect(result.regressed).toHaveLength(1)
    expect(result.acknowledged).toEqual([])
  })

  test("survives sibling reordering without masking a move", () => {
    const result = partitionViolations([
      violation(
        "button-name",
        'div[data-component="tooltip-v2-trigger"][data-closed=""]:nth-child(9) > button[data-size="normal"][data-component="icon-button-v2"]',
      ),
    ])
    expect(result.regressed).toEqual([])
    expect(result.acknowledged).toHaveLength(1)
  })

  test("strips the Solid prop-serialization artifact from targets", () => {
    expect(
      normalizeBaselineTarget('button[data-size="normal"][icon="[object SVGSVGElement]"][data-component="icon-button-v2"]'),
    ).toBe('button[data-size="normal"][data-component="icon-button-v2"]')
    expect(
      partitionViolations([
        violation(
          "button-name",
          'div[data-component="tooltip-v2-trigger"][data-closed=""]:nth-child(3) > button[data-size="normal"][icon="[object SVGSVGElement]"][data-component="icon-button-v2"]',
        ),
      ]).regressed,
    ).toEqual([])
  })

  test("every baseline entry is written in already-normalized form", () => {
    // A stored target that normalization would rewrite could never match, which
    // would silently turn into a false green.
    for (const entry of KNOWN_ACCESSIBILITY_DEBT) {
      expect(normalizeBaselineTarget(entry.target)).toBe(entry.target)
      expect(entry.reason.trim().length).toBeGreaterThan(0)
      expect(entry.observedIn.length).toBeGreaterThan(0)
    }
  })

  test("partitions an empty audit into empty results", () => {
    expect(partitionViolations([])).toEqual({ regressed: [], acknowledged: [] })
  })
})