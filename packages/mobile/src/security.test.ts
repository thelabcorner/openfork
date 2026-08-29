import { describe, expect, test } from "bun:test"
import { safeExternalUrl } from "./security"

describe("safeExternalUrl", () => {
  test("allows web URLs", () => {
    expect(safeExternalUrl("https://example.com/path")).toBe("https://example.com/path")
    expect(safeExternalUrl("http://localhost:3000/")).toBe("http://localhost:3000/")
  })

  test("rejects executable and malformed URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined()
    expect(safeExternalUrl("data:text/html,unsafe")).toBeUndefined()
    expect(safeExternalUrl("not a url")).toBeUndefined()
  })
})
