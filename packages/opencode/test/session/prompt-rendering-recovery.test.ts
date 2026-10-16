import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { SessionPromptRenderingRecovery as Recovery } from "@/session/prompt-rendering-recovery"

const route = { providerID: "opencode-go", api: { npm: "@ai-sdk/openai-compatible" } } as const

describe("hosted prompt-rendering recovery", () => {
  test("matches only upstream response codes or bracketed gateway error messages", () => {
    expect(Recovery.isPromptRenderingRejection({
      message: "Upstream request failed: [prompt_rendering_failed] The request could not be rendered.",
      responseBody: undefined,
    })).toBe(true)
    expect(Recovery.isPromptRenderingRejection({
      message: "Bad gateway",
      responseBody: JSON.stringify({ error: { code: "prompt_rendering_failed" } }),
    })).toBe(true)
    expect(Recovery.isPromptRenderingRejection({
      data: { message: "Bad gateway", responseBody: JSON.stringify({ error: { code: "prompt_rendering_failed" } }) },
    })).toBe(true)
    expect(Recovery.isPromptRenderingRejection({
      message: "Bad gateway",
      responseBody: JSON.stringify({ error: { code: "server_error" }, echoedUserText: "[prompt_rendering_failed]" }),
    })).toBe(false)
    expect(Recovery.isPromptRenderingRejection({ message: "User typed prompt_rendering_failed" })).toBe(false)
    expect(Recovery.isPromptRenderingRejection({ message: "502 upstream failure" })).toBe(false)
  })

  test("strips only old assistant reasoning and keeps tool causality, order, and canonical input intact", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: [{ type: "text", text: "Inspect the repo" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "private reasoning" }] },
      { role: "assistant", content: [
        { type: "reasoning", text: "prior provider reasoning" },
        { type: "text", text: "Checking repository." },
        { type: "tool-call", toolCallId: "call_001", toolName: "read", input: { path: "AGENTS.md" } },
      ] },
      { role: "tool", content: [{
        type: "tool-result",
        toolCallId: "call_001",
        toolName: "read",
        output: { type: "text", value: "Repository architecture" },
      }] },
      { role: "user", content: [{ type: "text", text: "Continue exhaustively" }] },
    ]
    const snapshot = structuredClone(messages)
    const result = Recovery.stripRejectedReasoning(messages, route)!
    expect(result.removedReasoningParts).toBe(2)
    expect(result.removedReasoningOnlyMessages).toBe(1)
    expect(result.messages).toHaveLength(5)
    expect(result.messages[2]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking repository." },
        { type: "tool-call", toolCallId: "call_001", toolName: "read", input: { path: "AGENTS.md" } },
      ],
    })
    expect(result.messages[3]).toEqual(messages[4])
    expect(result.messages[4]).toEqual(messages[5])
    expect(messages).toEqual(snapshot)
    expect(Recovery.stripRejectedReasoning(result.messages, route)).toBeUndefined()
  })

  test("refuses identical retries and never touches non-hosted or non-chat-completions routes", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }, { type: "reasoning", text: "reason" }] },
    ]
    expect(Recovery.stripRejectedReasoning([{ role: "user", content: "hi" }], route)).toBeUndefined()
    expect(Recovery.stripRejectedReasoning(messages, { ...route, providerID: "openrouter" })).toBeUndefined()
    expect(Recovery.stripRejectedReasoning(messages, {
      ...route,
      api: { npm: "@ai-sdk/anthropic" },
    })).toBeUndefined()
    expect(Recovery.stripRejectedReasoning(messages, {
      ...route,
      api: { npm: "@ai-sdk/openai" },
    })).toBeUndefined()
  })
})
