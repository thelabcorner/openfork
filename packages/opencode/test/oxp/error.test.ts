import { describe, expect, test } from "bun:test"
import { OxpError } from "@/oxp/error"

describe("OXP error contract", () => {
  test("bounds verbose downstream diagnostics before tagged-error construction", () => {
    const source = "x".repeat(OxpError.MAX_DETAIL_LENGTH + 500)
    const detail = OxpError.boundDetail(source)
    expect(detail.length).toBe(OxpError.MAX_DETAIL_LENGTH)
    expect(detail.endsWith("...")).toBe(true)
    const error = new OxpError.Conflict({ detail })
    expect(error.detail).toBe(detail)
    expect(error._tag).toBe("OXP_CONFLICT")
  })

  test("normalizes empty or non-string diagnostics to a valid detail", () => {
    expect(OxpError.boundDetail("", "fallback")).toBe("fallback")
    expect(OxpError.boundDetail(undefined, "fallback")).toBe("fallback")
    expect(OxpError.boundDetail(new Error("boom"))).toBe("boom")
  })
})