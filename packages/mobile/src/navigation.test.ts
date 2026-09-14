import { describe, expect, test } from "bun:test"
import { sessionIDFromNavigationUrl } from "./navigation"

describe("push/deep-link navigation", () => {
  test("extracts the same session from cold relative and warm absolute URLs", () => {
    expect(sessionIDFromNavigationUrl("/?session=ses_abc", "https://mobile.example/")).toBe("ses_abc")
    expect(sessionIDFromNavigationUrl("/session/ses_abc", "https://mobile.example/")).toBe("ses_abc")
    expect(sessionIDFromNavigationUrl("https://mobile.example/session/ses_abc?from=push", "https://mobile.example/")).toBe(
      "ses_abc",
    )
  })

  test("decodes path components and accepts the canonical trailing slash", () => {
    expect(sessionIDFromNavigationUrl("/session/ses_%E2%9C%93/", "https://mobile.example/")).toBe("ses_✓")
  })

  test("ignores unrelated or malformed navigation targets", () => {
    expect(sessionIDFromNavigationUrl("/sessions", "https://mobile.example/")).toBeUndefined()
    expect(sessionIDFromNavigationUrl("/project/a/session/ses_abc", "https://mobile.example/")).toBeUndefined()
    expect(sessionIDFromNavigationUrl("http://[", "https://mobile.example/")).toBeUndefined()
  })
})
