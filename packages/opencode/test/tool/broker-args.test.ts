import { describe, expect, test } from "bun:test"
import { normalizeBrokerArgs, withObjectBrokerArgsSchema } from "../../src/tool/broker-args"

describe("broker argument normalization", () => {
  test("forces provider-facing args to advertise an object without changing the runtime decoder", () => {
    const schema = withObjectBrokerArgsSchema({
      type: "object",
      properties: { args: { description: "dynamic args" } },
    })
    expect(schema.properties?.args).toEqual({ description: "dynamic args", type: "object" })
  })

  test("preserves real object args", () => {
    const input = { url: "https://example.com", waitUntil: "load" }
    expect(normalizeBrokerArgs(input, { broker: "browser", allowOmitted: true })).toBe(input)
  })

  test("decodes JSON-encoded object args", () => {
    expect(
      normalizeBrokerArgs('{"url":"https://example.com","timeoutMs":5000}', {
        broker: "browser",
        allowOmitted: true,
      }),
    ).toEqual({ url: "https://example.com", timeoutMs: 5000 })
  })

  test("allows omitted args only when the broker supports no-arg calls", () => {
    expect(normalizeBrokerArgs(undefined, { broker: "browser", allowOmitted: true })).toEqual({})
    expect(() => normalizeBrokerArgs(undefined, { broker: "tool" })).toThrow("tool args must be a JSON object")
  })

  test("rejects describe placeholders instead of pretending they are executable args", () => {
    expect(() =>
      normalizeBrokerArgs("<args matching schema>", {
        broker: "browser",
        allowOmitted: true,
      }),
    ).toThrow("do not pass schema text or placeholder strings")
  })

  test("rejects arrays, primitives, and JSON strings that decode to non-objects", () => {
    for (const value of [[], 1, true, "null", "[]", '"text"', "{broken"] as const) {
      expect(() => normalizeBrokerArgs(value, { broker: "browser", allowOmitted: true })).toThrow(
        "browser args must be a JSON object",
      )
    }
  })
})
