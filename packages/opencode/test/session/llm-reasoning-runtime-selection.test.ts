import { describe, expect, test } from "bun:test"
import { needsNativeReasoningTransport } from "../../src/session/llm/reasoning-runtime-selection"

const candidate = (
  providerID: string,
  npm: string,
  interleaved: boolean | { field: string },
) => ({ providerID, api: { npm }, capabilities: { interleaved } })

describe("hosted native reasoning parser selection", () => {
  test("selects native only for a hosted compatible model declaring reasoning_text", () => {
    expect(needsNativeReasoningTransport(candidate("opencode-go", "@ai-sdk/openai-compatible", { field: "reasoning_text" }))).toBe(true)
    expect(needsNativeReasoningTransport(candidate("opencode", "@ai-sdk/openai-compatible", { field: "reasoning_text" }))).toBe(true)
  })

  test("does not change default transport for normal hosted reasoning", () => {
    for (const value of [false, true, { field: "reasoning_content" }, { field: "reasoning" }]) {
      expect(needsNativeReasoningTransport(candidate("opencode-go", "@ai-sdk/openai-compatible", value))).toBe(false)
    }
  })

  test("does not force unrelated model providers onto native runtime", () => {
    expect(needsNativeReasoningTransport(candidate("openrouter", "@ai-sdk/openai-compatible", { field: "reasoning_text" }))).toBe(false)
    expect(needsNativeReasoningTransport(candidate("opencode-go", "@ai-sdk/anthropic", { field: "reasoning_text" }))).toBe(false)
    expect(needsNativeReasoningTransport(candidate("opencode-go", "@ai-sdk/openai", { field: "reasoning_text" }))).toBe(false)
  })
})
