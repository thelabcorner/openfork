import { describe, expect, test } from "bun:test"
import { sessionTitleErrorMessage } from "./session-title-error"

describe("session title error detail", () => {
  test("accepts only trusted service-scoped messages", () => {
    const error = { data: { service: "session-title", message: "Title model hit a limit" } }
    expect(sessionTitleErrorMessage(error)).toBe("Title model hit a limit")
  })

  test("does not expose raw provider, transport, or other-service errors", () => {
    expect(sessionTitleErrorMessage(new Error("Bearer private"))).toBeUndefined()
    expect(sessionTitleErrorMessage({ data: { service: "other", message: "secret" } })).toBeUndefined()
    expect(sessionTitleErrorMessage({ data: { service: "session-title", message: "x".repeat(301) } })).toBeUndefined()
  })
})