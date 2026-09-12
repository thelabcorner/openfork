import { describe, expect, test } from "bun:test"
import {
  ParameterizedFingerprintBuilder,
  equalParameterizedFingerprint,
  hashParameterizedFingerprint,
} from "@/session/spad/parameterized-fast"
import { parameterizedMatchCode } from "@/session/spad/parameterized"

describe("SPAD fast parameterized fingerprint proposal", () => {
  test("proposes consistent renaming that the terminal verifier confirms", () => {
    const a = `function parseA(input) { const node = scan(input); if (!node) return null; return parseA(node.value) }`
    const b = `function parseB(source) { const item = scan(source); if (!item) return null; return parseB(item.value) }`
    const leftBuilder = new ParameterizedFingerprintBuilder()
    const rightBuilder = new ParameterizedFingerprintBuilder()
    const proposal = equalParameterizedFingerprint(leftBuilder.build(a), rightBuilder.build(b))
    expect(proposal).toBe(true)
    expect(parameterizedMatchCode(a, b).matched).toBe(true)
  })

  test("changing numeric constants fail at the proposal stage", () => {
    const a = `function handlerA(x) { return { id: 17, value: x + 3 } }`
    const b = `function handlerB(y) { return { id: 18, value: y + 4 } }`
    const leftBuilder = new ParameterizedFingerprintBuilder()
    const rightBuilder = new ParameterizedFingerprintBuilder()
    expect(equalParameterizedFingerprint(leftBuilder.build(a), rightBuilder.build(b))).toBe(false)
  })

  test("reports repeated-parameter density for evidence strength", () => {
    const builder = new ParameterizedFingerprintBuilder()
    const strong = builder.build(`function f(x) { const y = x + x; return f(y) }`)
    expect(strong.repeatedParameterClasses).toBeGreaterThan(0)
    expect(strong.repeatedParameterDensity).toBeGreaterThan(0.5)
    const weak = builder.build(`alpha + beta + gamma + delta`)
    expect(weak.repeatedParameterClasses).toBe(0)
    expect(weak.repeatedParameterDensity).toBe(0)
  })

  test("builder is bounded", () => {
    const builder = new ParameterizedFingerprintBuilder(32)
    expect(() => builder.build("x".repeat(33))).toThrow()
  })

  test("equivalent fingerprints have the same proposal hash", () => {
    const left = new ParameterizedFingerprintBuilder()
    const right = new ParameterizedFingerprintBuilder()
    const a = left.build(`function f(x) { const y = x + x; return f(y) }`)
    const b = right.build(`function g(a) { const b = a + a; return g(b) }`)
    expect(equalParameterizedFingerprint(a, b)).toBe(true)
    expect(hashParameterizedFingerprint(a)).toEqual(hashParameterizedFingerprint(b))
  })
})
