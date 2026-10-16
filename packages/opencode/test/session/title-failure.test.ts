import { describe, expect, test } from "bun:test"
import { titleFailureMessage } from "@/session/title-failure"

describe("title failure explanations are safe and actionable", () => {
  test("identifies authentication without leaking sensitive provider details", () => {
    const message = titleFailureMessage(new Error("401 unauthorized Bearer secret-example-key"))
    expect(message).toContain("authentication")
    expect(message).not.toContain("secret-example-key")
    expect(message).not.toContain("Bearer")
  })

  test("identifies quotas, timeouts, protocol mismatch, model routing, and transport failures", () => {
    expect(titleFailureMessage(new Error("429 rate limit exceeded"))).toContain("limit")
    expect(titleFailureMessage(new Error("deadline exceeded"))).toContain("timed out")
    expect(titleFailureMessage(new Error("Selected title model does not support tool calls"))).toContain("tool")
    expect(titleFailureMessage(new Error("No model is available for session"))).toContain("unavailable")
    expect(titleFailureMessage(new Error("ECONNRESET"))).toContain("reached")
  })

  test("never echoes an unrecognized upstream error", () => {
    expect(titleFailureMessage(new Error("internal private credential token ABC123"))).not.toContain("ABC123")
  })

  test("names the failing provider/model in route-unavailable errors", () => {
    const message = titleFailureMessage(
      new Error("Selected title model opencode/gpt-nano is unavailable for the current provider/account route"),
    )
    expect(message).toContain("opencode/gpt-nano")
    expect(message).toContain("unavailable")
  })

  test("preserves model identity from route errors without leaking key material", () => {
    const message = titleFailureMessage(
      new Error(
        "Provider route unavailable: anthropic/claude-opus-4-1. No eligible subscription account can serve this model.",
      ),
    )
    expect(message).toContain("anthropic/claude-opus-4-1")
    const redacted = titleFailureMessage(new Error("route unavailable sk-ant-secret-key-value"))
    expect(redacted).not.toContain("sk-ant-secret-key-value")
  })
})