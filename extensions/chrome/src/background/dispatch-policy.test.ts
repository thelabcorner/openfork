import { describe, expect, test } from "bun:test"
import { operationNeedsDebugger } from "./dispatch-policy"

describe("Chrome debugger attachment policy", () => {
  test("ordinary SnapEye document/CSS operations remain debugger-free", () => {
    expect(operationNeedsDebugger("visual_capture", { target: { kind: "document" } })).toBe(false)
    expect(operationNeedsDebugger("visual_diff", { target: { kind: "css", selector: "#app" } })).toBe(false)
    expect(operationNeedsDebugger("visual_record", {})).toBe(false)
  })

  test("OpenCode-native element targets attach CDP before canonicalization", () => {
    for (const name of ["visual_capture", "visual_diff", "visual_record"]) {
      expect(operationNeedsDebugger(name, { target: { kind: "element", target: { ref: "e1", snapshotVersion: 2 } } })).toBe(true)
    }
  })

  test("existing CDP operations retain their attachment requirement", () => {
    for (const name of ["snapshot", "screenshot", "click", "type", "press", "scroll", "evaluate", "resize", "set_appearance"]) {
      expect(operationNeedsDebugger(name, {})).toBe(true)
    }
    expect(operationNeedsDebugger("status", {})).toBe(false)
    expect(operationNeedsDebugger("query", {})).toBe(false)
  })
})

