import { describe, expect, test } from "bun:test"
import { usageSummaryCacheKey } from "./use-usage-summary"

describe("usageSummaryCacheKey", () => {
  test("includes the authoritative server owner", () => {
    expect(usageSummaryCacheKey("server-a", "7d", "project")).not.toBe(
      usageSummaryCacheKey("server-b", "7d", "project"),
    )
  })

  test("preserves window and project identity within one server", () => {
    expect(usageSummaryCacheKey("server-a", "7d", "project-a")).not.toBe(
      usageSummaryCacheKey("server-a", "30d", "project-a"),
    )
    expect(usageSummaryCacheKey("server-a", "7d", "project-a")).not.toBe(
      usageSummaryCacheKey("server-a", "7d", "project-b"),
    )
  })
})
