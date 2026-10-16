import { describe, expect, test } from "bun:test"
import { APICallError, type ModelMessage } from "ai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderError } from "@/provider/error"
import { SessionStaleReasoning } from "@/session/stale-reasoning"
import { Effect } from "effect"

describe("provider stream errors", () => {
  test("treats an upstream model prompt-rendering rejection as terminal, including gateway 5xx", () => {
    const text = "Upstream request failed: [prompt_rendering_failed] The request could not be rendered into a prompt for this model."
    const error = new APICallError({
      message: text,
      url: "https://opencode.ai/zen/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 502,
      responseHeaders: {},
      responseBody: JSON.stringify({ error: { code: "prompt_rendering_failed" }, secret: "not-for-display" }),
      isRetryable: true,
    })
    const parsed = ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("opencode-go"), error })
    expect(parsed).toMatchObject({ type: "api_error", isRetryable: false, statusCode: 502 })
    expect(parsed.message).toContain("Choose another model")
    expect(parsed.message).toContain("prompt_rendering_failed")
    expect(parsed.message).not.toContain("not-for-display")

    const streamed = ProviderError.parseStreamError({
      type: "error",
      error: { code: "prompt_rendering_failed", message: "The request could not be rendered into a prompt for this model." },
    })
    expect(streamed).toMatchObject({ type: "api_error", isRetryable: false })
    expect(streamed?.message).toContain("Choose another model")
  })

  test("does not misclassify ordinary provider 5xx or requests mentioning the code", () => {
    const transient = new APICallError({
      message: "Bad gateway",
      url: "https://opencode.ai/zen/v1/chat/completions",
      requestBodyValues: { userText: "prompt_rendering_failed" },
      statusCode: 502,
      responseHeaders: {},
      responseBody: JSON.stringify({ error: { code: "server_error" } }),
      isRetryable: true,
    })
    const parsed = ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("opencode-go"), error: transient })
    expect(parsed).toMatchObject({ type: "api_error", isRetryable: true, statusCode: 502 })
  })

  test("does not retry a streamed Muse validation failure", () => {
    for (const error of [
      { type: "invalid_request_error", message: "The request contains invalid parameters." },
      { code: "invalid_tool_schema", message: "Function parameter schema is too deep." },
    ]) {
      const body = { type: "error", error }
      expect(ProviderError.parseStreamError(body)).toEqual({
        type: "api_error",
        message: error.message,
        isRetryable: false,
        responseBody: JSON.stringify(body),
      })
    }
  })

  test("surfaces upstream Go validation detail without serializing response data", () => {
    const error = new APICallError({
      message: "The request contains invalid parameters. Check the request body for any errors or inconsistencies.",
      url: "https://opencode.ai/zen/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: JSON.stringify({
        error: { message: "Function tool schema depth exceeds 10", param: "tools[0].parameters" },
        secret: "not-for-display",
      }),
      isRetryable: false,
    })
    const parsed = ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("opencode-go"), error })
    expect(parsed.type).toBe("api_error")
    expect(parsed.message).toContain("tools[0].parameters")
    expect(parsed.message).toContain("schema depth exceeds 10")
    expect(parsed.message).not.toContain("not-for-display")
    expect(parsed.type === "api_error" && parsed.isRetryable).toBe(false)
  })

  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })

  test("classifies invalid encrypted reasoning as stale_reasoning", () => {
    const withType = ProviderError.parseStreamError({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "invalid_encrypted_content",
        message: "The encrypted content could not be verified",
      },
    })
    expect(withType?.type).toBe("stale_reasoning")
    expect(
      ProviderError.parseStreamError({
        type: "error",
        error: {
          code: "invalid_encrypted_content",
          message: "The encrypted content could not be verified",
        },
      }),
    ).toEqual({
      type: "stale_reasoning",
      message: "The encrypted content could not be verified",
      responseBody: JSON.stringify({
        type: "error",
        error: {
          code: "invalid_encrypted_content",
          message: "The encrypted content could not be verified",
        },
      }),
    })

    const error = new APICallError({
      message:
        "Error from provider (Console): Upstream request failed: [invalid_request_error] reasoning `encrypted_content` was not issued to this caller",
      url: "https://opencode.ai/zen/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: { "content-type": "application/json" },
      isRetryable: false,
    })
    expect(ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("opencode"), error }).type).toBe(
      "stale_reasoning",
    )
  })

  test("does not conflate output rate limiting with stale reasoning", () => {
    const error = new APICallError({
      message: "Output token rate limit exceeded. Please retry after a brief wait.",
      url: "https://opencode.ai/zen/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      isRetryable: true,
    })

    expect(ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make("opencode"), error }).type).toBe("api_error")
  })
})

describe("stale reasoning request sanitizer", () => {
  test("drops caller-bound replay state while preserving reasoning text", () => {
    const part = {
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "reasoning",
      text: "thinking",
      time: { start: 1 },
      metadata: {
        openai: {
          itemId: "rs_1",
          reasoningEncryptedContent: "blob",
        },
      },
    } as unknown as SessionV1.ReasoningPart
    const next = SessionStaleReasoning.stripPart(part)
    expect(next.metadata?.openai).toBeUndefined()
    expect(next.text).toBe("thinking")

    const messages = [
      {
        role: "assistant" as const,
        content: [
          {
            type: "reasoning" as const,
            text: "thinking",
            id: "rs_1",
            providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "blob" } },
          },
        ],
      },
    ] as unknown as ModelMessage[]
    SessionStaleReasoning.stripRequest(messages)
    expect(messages[0]?.content[0]).toEqual({ type: "reasoning", text: "thinking" })
  })

  test("drops flat caller-bound metadata keys without mutating the stored part", () => {
    const part = {
      id: "prt_2",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "reasoning",
      text: "thinking",
      time: { start: 1 },
      metadata: {
        itemId: "rs_2",
        reasoningEncryptedContent: "blob",
        providerNote: "keep",
      },
    } as unknown as SessionV1.ReasoningPart

    const next = SessionStaleReasoning.stripPart(part)
    expect(next.metadata).toEqual({ providerNote: "keep" })
    expect(next.text).toBe("thinking")
    expect(part.metadata).toEqual({
      itemId: "rs_2",
      reasoningEncryptedContent: "blob",
      providerNote: "keep",
    })
  })

  test("preserves non-caller-bound keys beside the openai box", () => {
    const part = {
      id: "prt_3",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "reasoning",
      text: "thinking",
      time: { start: 1 },
      metadata: {
        source: "model",
        openai: { itemId: "rs_3", reasoningEncryptedContent: "blob", trace: "keep" },
      },
    } as unknown as SessionV1.ReasoningPart

    expect(SessionStaleReasoning.stripPart(part).metadata).toEqual({
      source: "model",
      openai: { trace: "keep" },
    })
  })

  test("returns the original part when no caller-bound keys are present", () => {
    const part = {
      id: "prt_4",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "reasoning",
      text: "thinking",
      time: { start: 1 },
      metadata: { openai: { trace: "keep" } },
    } as unknown as SessionV1.ReasoningPart
    expect(SessionStaleReasoning.stripPart(part)).toBe(part)
  })

  test("clears metadata entirely when only caller-bound keys exist", () => {
    const part = {
      id: "prt_5",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "reasoning",
      text: "thinking",
      time: { start: 1 },
      metadata: { encrypted_content: "blob" },
    } as unknown as SessionV1.ReasoningPart
    const next = SessionStaleReasoning.stripPart(part)
    expect(next.metadata).toBeUndefined()
    expect(next.text).toBe("thinking")
  })

  test("repairs only the supplied durable history without hydrating the transcript", async () => {
    let hydrated = false
    const updates: SessionV1.Part[] = []
    const session = {
      messages: () => {
        hydrated = true
        return Effect.die(new Error("persist must not hydrate the transcript"))
      },
      updatePart: (part: SessionV1.Part) => {
        updates.push(part)
        return Effect.succeed(part)
      },
    } as unknown as Parameters<typeof SessionStaleReasoning.persist>[0]

    const reasoning = {
      id: "prt_persist",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "reasoning",
      text: "thinking",
      time: { start: 1 },
      metadata: {
        openai: { itemId: "rs_1", reasoningEncryptedContent: "blob", trace: "keep" },
        providerNote: "keep",
      },
    } as unknown as SessionV1.ReasoningPart
    const text = {
      id: "prt_text",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "visible",
    } as SessionV1.TextPart
    const messages = [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } },
        parts: [reasoning, text],
      },
    ] as unknown as SessionV1.WithParts[]

    await Effect.runPromise(SessionStaleReasoning.persist(session, messages))

    expect(hydrated).toBe(false)
    expect(updates).toHaveLength(1)
    const updated = updates[0] as SessionV1.ReasoningPart
    expect(updated).toMatchObject({ id: "prt_persist", type: "reasoning", text: "thinking" })
    expect(updated.metadata).toEqual({ openai: { trace: "keep" }, providerNote: "keep" })
    expect(reasoning.metadata).toEqual({
      openai: { itemId: "rs_1", reasoningEncryptedContent: "blob", trace: "keep" },
      providerNote: "keep",
    })
  })
})
