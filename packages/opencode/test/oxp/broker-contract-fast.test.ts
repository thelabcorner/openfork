import { describe, expect, test } from "bun:test"
import { make, violation, violationExpected } from "../../src/tool/broker-contract"

const base = {
  broker: "capability",
  target: "symbols",
  description: "Find symbols in approved source paths",
  schema: {
    type: "object",
    properties: { action: { enum: ["search"] }, query: { type: "string" } },
    required: ["action", "query"],
    additionalProperties: false,
  },
} as const

function checked(contract?: string, expected = make(base)) {
  return violationExpected({
    broker: base.broker, target: base.target, expected, contract,
    discovery: 'Call capability with action="describe" and capability="symbols"',
  })
}

describe("OXP immutable descriptor contract replay", () => {
  test("an owner-held digest admits exactly the original descriptor contract", () => {
    const token = make(base)
    expect(checked(token)).toBeUndefined()
    expect(checked(undefined)).toBe(violation({
      ...base, contract: undefined,
      discovery: 'Call capability with action="describe" and capability="symbols"',
    }))
    expect(checked("broker-v1:wrong")).toBe(violation({
      ...base, contract: "broker-v1:wrong",
      discovery: 'Call capability with action="describe" and capability="symbols"',
    }))
  })

  test("changed description or schema invalidates previously described context", () => {
    const token = make(base)
    const changed = make({ ...base, schema: { ...base.schema, required: ["action"] } })
    const renamed = make({ ...base, description: "Changed instructions" })
    expect(token).not.toBe(changed)
    expect(token).not.toBe(renamed)
    expect(checked(token, changed)).toContain("current descriptor contract")
    expect(checked(token, renamed)).toContain("current descriptor contract")
  })

  test("focused action and target tokens are not interchangeable", () => {
    const focusA = make({ ...base, schema: { ...base.schema, properties: { action: { enum: ["search"] } } } })
    const focusB = make({ ...base, schema: { ...base.schema, properties: { action: { enum: ["rewrite"] } } } })
    const otherTool = make({ ...base, target: "edit" })
    expect(checked(focusA, focusB)).toContain("exact returned contract")
    expect(checked(focusA, otherTool)).toContain("exact returned contract")
    expect(checked(focusA, focusA)).toBeUndefined()
  })
})
