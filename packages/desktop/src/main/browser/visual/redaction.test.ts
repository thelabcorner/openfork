import { describe, expect, test } from "bun:test"
import {
  EMPTY_VISUAL_REDACTION_SHA256,
  normalizeVisualRedaction,
  visualRedactionDigest,
} from "./redaction"

describe("visual redaction policy", () => {
  test("canonicalizes semantically equivalent selector/name ordering", () => {
    const a = visualRedactionDigest({
      blocks: [".secret", "#token", ".secret"],
      attributes: [
        { selector: "input", names: ["VALUE", "data-secret"] },
        { selector: "input", names: ["data-secret"] },
      ],
    })
    const b = visualRedactionDigest({
      blocks: ["#token", ".secret"],
      attributes: [{ selector: "input", names: ["data-secret", "value"] }],
    })
    expect(a).toBe(b)
  })

  test("empty and omitted policies have the same stable digest", () => {
    expect(visualRedactionDigest()).toBe(EMPTY_VISUAL_REDACTION_SHA256)
    expect(visualRedactionDigest({})).toBe(EMPTY_VISUAL_REDACTION_SHA256)
  })

  test("rejects malformed attribute names and overlong selectors", () => {
    expect(() => normalizeVisualRedaction({ attributes: [{ selector: "input", names: ["bad name"] }] })).toThrow()
    expect(() => normalizeVisualRedaction({ blocks: ["x".repeat(1_025)] })).toThrow()
  })
})
