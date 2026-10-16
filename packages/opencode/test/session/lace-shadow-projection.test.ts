import { describe, expect, test } from "bun:test"
import { buildShadowProjection, type ProjectionSource } from "../../src/session/lace-shadow-projection"

const sources: ProjectionSource[] = [
  { id: "sys", revision: "r1", raw: "Privileged policy", privileged: true, required: true },
  { id: "goal", revision: "r1", raw: "Do not change output format", privileged: false, required: true },
  { id: "tool-call", revision: "r1", raw: "call: compile", privileged: false, required: false, atomicGroup: "pending" },
  { id: "tool-result", revision: "r1", raw: "pending tool result", privileged: false, required: false, atomicGroup: "pending" },
  { id: "old-output", revision: "r4", raw: "Long historical output with many lines", privileged: false, required: false },
]

describe("LACE v14.7 reversible shadow projection guards", () => {
  test("defaults to exact raw source and does not modify durable input", () => {
    const prior = JSON.stringify(sources)
    const out = buildShadowProjection(sources, [], 1000)
    expect(out.parts.map((part) => part.text)).toEqual(sources.map((source) => source.raw))
    expect(out.projectedCharacters).toBe(out.originalCharacters)
    expect(JSON.stringify(sources)).toBe(prior)
  })

  test("supports validated abstraction and recoverable references only for eligible history", () => {
    const out = buildShadowProjection(sources, [{
      id: "old-output", mode: "reference", text: "[older compiler output available via source id]", validatedRevision: "r4", retrievable: true,
    }], 1000)
    expect(out.parts[4]?.mode).toBe("reference")
    expect(out.parts[0]?.text).toBe("Privileged policy")
    const abstracted = buildShadowProjection(sources, [{
      id: "old-output", mode: "abstract", text: "Compiler log summary", validatedRevision: "r4", independentlyVerified: true,
    }], 1000)
    expect(abstracted.projectedCharacters).toBeLessThan(abstracted.originalCharacters)
  })

  test("rejects downgrade or omission of required, privileged, or atomic history", () => {
    for (const id of ["sys", "goal", "tool-call", "tool-result"]) {
      expect(() => buildShadowProjection(sources, [{ id, mode: "omit" }], 1000)).toThrow()
    }
  })

  test("rejects stale, unverified and unavailable historical evidence", () => {
    expect(() => buildShadowProjection(sources, [
      { id: "old-output", mode: "abstract", text: "text", validatedRevision: "old", independentlyVerified: true },
    ], 1000)).toThrow()
    expect(() => buildShadowProjection(sources, [
      { id: "old-output", mode: "abstract", text: "text", validatedRevision: "r4", independentlyVerified: false },
    ], 1000)).toThrow()
    expect(() => buildShadowProjection(sources, [
      { id: "old-output", mode: "reference", text: "ref", validatedRevision: "r4", retrievable: false },
    ], 1000)).toThrow()
  })

  test("can omit only unprotected history while retaining complete original input", () => {
    const out = buildShadowProjection(sources, [{ id: "old-output", mode: "omit" }], 1000)
    expect(out.omittedSourceIDs).toEqual(["old-output"])
    expect(out.sourceCount).toBe(5)
    expect(sources[4]?.raw).toContain("Long historical output")
  })

  test("rejects insufficient budgets and ambiguous identity", () => {
    expect(() => buildShadowProjection(sources, [], 1)).toThrow(RangeError)
    expect(() => buildShadowProjection(sources, [], -1)).toThrow(RangeError)
    expect(() => buildShadowProjection(sources, [{ id: "unknown", mode: "omit" }], 1000)).toThrow()
    expect(() => buildShadowProjection(sources, [{ id: "old-output", mode: "omit" }, { id: "old-output", mode: "omit" }], 1000)).toThrow()
    expect(() => buildShadowProjection([sources[0]!, sources[0]!], [], 1000)).toThrow()
  })
})
