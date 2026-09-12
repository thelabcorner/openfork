import { describe, expect, test } from "bun:test"
import { parameterizedMatchCode, tokenizeParameterizedCode } from "@/session/spad/parameterized"

describe("SPAD parameterized structural matching prototype", () => {
  test("matches consistent identifier renaming", () => {
    const a = `function parseA(input) { const node = scan(input); if (!node) return null; return parseA(node.value) }`
    const b = `function parseB(source) { const item = scan(source); if (!item) return null; return parseB(item.value) }`
    const hit = parameterizedMatchCode(a, b)
    expect(hit.matched).toBe(true)
    expect(hit.parameterClasses).toBeGreaterThanOrEqual(5)
    expect(hit.repeatedParameterClasses).toBeGreaterThanOrEqual(3)
    expect(hit.repeatedParameterDensity).toBeGreaterThan(0.5)
    expect(hit.renamedParameterClasses).toBeGreaterThan(0)
  })

  test("requires a bijection rather than wildcard identifiers", () => {
    const a = `const left = combine(a, b); return use(left, a)`
    const b = `const result = combine(x, x); return use(result, x)`
    const hit = parameterizedMatchCode(a, b)
    expect(hit.matched).toBe(false)
    expect(hit.firstMismatchToken).toBeGreaterThan(0)
  })

  test("exact constants protect generated code with changing numeric semantics", () => {
    const a = `export function handlerA(x) { return { id: 17, value: x + 3 } }`
    const b = `export function handlerB(y) { return { id: 18, value: y + 4 } }`
    const hit = parameterizedMatchCode(a, b)
    expect(hit.matched).toBe(false)
    expect(hit.constantCoverage).toBeGreaterThan(0.4)
  })

  test("all-fresh identifiers are reported as weak evidence", () => {
    const a = `alpha + beta + gamma + delta`
    const b = `one + two + three + four`
    const hit = parameterizedMatchCode(a, b)
    expect(hit.matched).toBe(true)
    expect(hit.parameterClasses).toBe(4)
    expect(hit.repeatedParameterClasses).toBe(0)
    expect(hit.repeatedParameterDensity).toBe(0)
  })

  test("callee renaming is explicit evidence rather than hidden normalization", () => {
    const a = `const x = decode(input); return validate(x)`
    const b = `const y = parse(source); return check(y)`
    const hit = parameterizedMatchCode(a, b)
    expect(hit.matched).toBe(true)
    expect(hit.renamedCalleeClasses).toBeGreaterThanOrEqual(2)
  })

  test("comments and whitespace do not affect structure", () => {
    const a = `function f(x) { // inspect\n const y = x + x; return y }`
    const b = `function g(a){/* inspect differently */const b=a+a;return b}`
    expect(parameterizedMatchCode(a, b).matched).toBe(true)
  })

  test("template literals fail closed as exact constants", () => {
    const a = "const x = `item-${value}`; return x"
    const b = "const y = `item-${other}`; return y"
    const hit = parameterizedMatchCode(a, b)
    expect(hit.matched).toBe(false)
  })

  test("tokenization preserves keywords as constants", () => {
    const tokens = tokenizeParameterizedCode("function alpha(x) { return x }")
    expect(tokens[0]).toEqual({ kind: "constant", value: "kw:function" })
    expect(tokens[1]).toEqual({ kind: "parameter", value: "alpha", role: "declaration" })
  })
})
