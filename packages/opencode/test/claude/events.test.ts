import { describe, test, expect } from "bun:test"
import { decodeTransportEvent } from "../../src/claude/events"

describe("decodeTransportEvent", () => {
  test("decodes system init", () => {
    const event = decodeTransportEvent({
      type: "system",
      subtype: "init",
      session_id: "s-1",
      model: "claude-sonnet-4-5",
      cwd: "/repo",
      tools: ["Bash", "Read", 42],
    })
    expect(event).toEqual({
      type: "system",
      subtype: "init",
      session_id: "s-1",
      model: "claude-sonnet-4-5",
      cwd: "/repo",
      tools: ["Bash", "Read"],
    })
  })

  test("decodes assistant messages with typed content blocks", () => {
    const event = decodeTransportEvent({
      type: "assistant",
      session_id: "s-1",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-5",
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "/x" } },
          { junk: true },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })
    expect(event.type).toBe("assistant")
    if (event.type !== "assistant" || !("message" in event)) throw new Error("unreachable")
    // Blocks without a type field are fenced out of the decoded content.
    expect(event.message?.content?.length).toBe(2)
    expect(event.message?.content?.[0]).toEqual({ type: "text", text: "hello" })
    expect(event.message?.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  test("decodes result events with usage and error flag", () => {
    const event = decodeTransportEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      duration_ms: 1200,
      usage: { input_tokens: 3, output_tokens: 9 },
    })
    expect(event).toMatchObject({ type: "result", result: "done", is_error: false })
  })

  test("preserves v1.3 terminal error/status metadata", () => {
    const event = decodeTransportEvent({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Prompt is too long", "[ede_diagnostic] internal"],
      terminal_reason: "prompt_too_long",
      api_error_status: 529,
      stop_reason: "max_tokens",
    })
    expect(event).toMatchObject({
      type: "result",
      errors: ["Prompt is too long", "[ede_diagnostic] internal"],
      terminal_reason: "prompt_too_long",
      api_error_status: 529,
      stop_reason: "max_tokens",
    })
  })

  test("decodes api retry and refusal system events instead of fencing them as unknown", () => {
    expect(
      decodeTransportEvent({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 5000,
        error_status: 529,
      }),
    ).toMatchObject({
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 5000,
      error_status: 529,
    })
    expect(
      decodeTransportEvent({
        type: "system",
        subtype: "model_refusal_no_fallback",
        api_refusal_explanation: "policy refused",
        api_refusal_category: "policy",
      }),
    ).toMatchObject({
      type: "system",
      subtype: "model_refusal_no_fallback",
      api_refusal_explanation: "policy refused",
    })
    expect(
      decodeTransportEvent({
        type: "system",
        subtype: "model_refusal_fallback",
        scope: "session",
        original_model: "claude-fable-5-1[1m]",
        fallback_model: "claude-opus-5-5",
        api_refusal_category: "bio",
      }),
    ).toMatchObject({
      type: "system",
      subtype: "model_refusal_fallback",
      scope: "session",
      original_model: "claude-fable-5-1[1m]",
      fallback_model: "claude-opus-5-5",
      api_refusal_category: "bio",
    })
  })

  test("stream_event payload stays opaque but typed", () => {
    const event = decodeTransportEvent({ type: "stream_event", event: { delta: "…" }, session_id: "s-2" })
    expect(event.type).toBe("stream_event")
  })

  test("unknown SDK event kinds pass through with a redacted bounded preview", () => {
    const event = decodeTransportEvent({ type: "future_thing", secret: "sk-ant-supersecretvalue" })
    expect(event.type).toBe("future_thing")
    if (event.type !== "future_thing") throw new Error("unreachable")
    expect(event.preview).toContain("[redacted]")
    expect(event.preview).not.toContain("sk-ant-supersecretvalue")
  })

  test("non-object payloads become unknown without throwing", () => {
    expect(decodeTransportEvent(undefined).type).toBe("unknown")
    expect(decodeTransportEvent(42).type).toBe("unknown")
    expect(decodeTransportEvent([1, 2]).type).toBe("unknown")
    expect(decodeTransportEvent({ noType: true }).type).toBe("unknown")
  })
})
