import { describe, expect, test } from "bun:test"
import * as Admission from "@/code/input-admission"
import * as CodeSchema from "@/code/schema"

describe("Code provider durable input admission", () => {
  test("accepts ordinary bounded Code requests without rewriting them", () => {
    const request = { action: "run", code: "return input.value", input: { value: 1 } }
    const decision = Admission.inspect(request)
    expect(decision.ok).toBe(true)
    expect(Admission.durableInput(request)).toBe(request)
    expect(() => CodeSchema.validate(request as CodeSchema.Parameters)).not.toThrow()
  })

  test("rejects oversized source and persists only a bounded witness", () => {
    const source = "x".repeat(Admission.MAX_SOURCE_BYTES + 1)
    const request = { action: "run", code: source, input: {} }
    const decision = Admission.inspect(request)
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error("expected source rejection")
    expect(decision.reason).toContain("durable source limit")
    expect(decision.witness).toMatchObject({
      action: "run",
      rejected: true,
      sourceBytes: Admission.MAX_SOURCE_BYTES + 1,
    })
    expect(JSON.stringify(decision.witness)).not.toContain(source.slice(0, 256))
    expect(Admission.durableInput(request)).toEqual(decision.witness)
    expect(() => CodeSchema.validate(request as CodeSchema.Parameters)).toThrow("durable source limit")
  })

  test("rejects oversized invocation input without persisting payload bytes", () => {
    const secret = "s".repeat(Admission.MAX_INPUT_BYTES + 1)
    const request = { action: "call", tool: "project/example", input: { secret } }
    const decision = Admission.inspect(request)
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error("expected input rejection")
    expect(decision.reason).toContain("durable input limit")
    expect(decision.witness).toMatchObject({ action: "call", rejected: true })
    expect(JSON.stringify(decision.witness)).not.toContain(secret.slice(0, 256))
    expect(() => CodeSchema.validate(request as CodeSchema.Parameters)).toThrow("durable input limit")
  })

  test("bounds the complete provider request even when no single field exceeds its local cap", () => {
    const request = {
      action: "save",
      runID: "run:prt_example",
      save: {
        name: "example",
        description: "d".repeat(Admission.MAX_REQUEST_BYTES + 1),
      },
    }
    const decision = Admission.inspect(request)
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error("expected request rejection")
    expect(decision.reason).toContain("durable request limit")
    expect(JSON.stringify(decision.witness).length).toBeLessThan(1024)
  })
})
