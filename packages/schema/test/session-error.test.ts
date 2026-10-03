import { describe, expect, test } from "bun:test"
import { SessionError } from "../src/session-error"

describe("SessionError.summary", () => {
  test("extracts useful fields from a plain structured object without object stringification", () => {
    const value = SessionError.summary({
      name: "ProviderRequestError",
      message: "request failed",
      kind: "rate_limit",
      providerID: "openai",
      accountID: "acct-team",
      modelID: "gpt-test",
      stack: "secret stack blob",
      responseBody: "sensitive provider response",
    })

    expect(value).toEqual({
      name: "ProviderRequestError",
      message: "request failed",
      kind: "rate_limit",
      providerID: "openai",
      accountID: "acct-team",
      modelID: "gpt-test",
    })
    expect(SessionError.serialize({ data: { message: "x" } })).toBe('{"name":"Error","message":"x"}')
    expect(SessionError.serialize({ message: "api_key=private-value" })).not.toContain("private-value")
  })

  test("preserves Error name/message without leaking its stack", () => {
    const error = new TypeError("connection failed Authorization: Bearer top-secret")
    error.stack = "private stack"
    expect(SessionError.summary(error)).toEqual({
      name: "TypeError",
      message: "connection failed Authorization: Bearer [REDACTED]",
    })
    expect(SessionError.serialize(error)).not.toContain("private stack")
  })

  test("extracts provider context from provider-shaped nested data and bounds values", () => {
    const result = SessionError.summary({
      _tag: "AI_APICallError",
      data: {
        message: "provider rejected request",
        kind: "authentication",
        providerID: "anthropic",
        accountID: "account-1",
        modelID: "claude-test",
        headers: { authorization: "secret" },
      },
    })
    expect(result).toEqual({
      name: "AI_APICallError",
      message: "provider rejected request",
      kind: "authentication",
      providerID: "anthropic",
      accountID: "account-1",
      modelID: "claude-test",
    })
    expect(SessionError.summary({ message: "m".repeat(2_000) }).message.length).toBe(1_024)
  })
})
