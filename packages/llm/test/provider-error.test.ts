import { describe, expect, test } from "bun:test"
import { isContextOverflow, isStaleReasoning } from "../src"

describe("provider error classification", () => {
  test("classifies provider token limit messages as context overflow", () => {
    const messages = [
      "tokens in request more than max tokens allowed",
      '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      "Input length (265330) exceeds model's maximum context length (262144).",
      "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
      "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
      "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
      "Too many tokens",
      "Token limit exceeded",
    ]

    expect(messages.every(isContextOverflow)).toBe(true)
  })

  test("does not classify rate limits as context overflow", () => {
    const messages = [
      "Throttling error: Too many tokens, please wait before trying again.",
      "Rate limit exceeded, please retry after 30 seconds.",
      "Too many requests. Please slow down.",
    ]

    expect(messages.some(isContextOverflow)).toBe(false)
  })

  test("classifies caller-bound encrypted reasoning failures", () => {
    const messages = [
      "reasoning `encrypted_content` was not issued to this caller",
      "invalid_encrypted_content",
      "Encrypted content could not be verified",
      "Encrypted content could not be decrypted or parsed",
      "Referenced reasoning item 'rs_123' was not found",
      "Referenced reasoning item 'rs_123' has expired",
      "Item 'rs_123' of type 'reasoning' was provided without its required following item.",
    ]

    expect(messages.every(isStaleReasoning)).toBe(true)
    expect(isStaleReasoning("Output token rate limit exceeded. Please retry after a brief wait.")).toBe(false)
  })
})
