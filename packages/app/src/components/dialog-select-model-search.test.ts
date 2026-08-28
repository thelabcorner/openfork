import { describe, expect, test } from "bun:test"
import { createModelSearchMatcher, matchesModelSearch } from "./dialog-select-model-search"

describe("matchesModelSearch", () => {
  test("does not match when prepared fields are temporarily unavailable", () => {
    expect(createModelSearchMatcher("claude")(undefined)).toBe(false)
  })
  test("matches model names across separators", () => {
    expect(matchesModelSearch("gpt 5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt-5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt5", ["GPT-5.5"])).toBe(true)
  })

  test("matches any searchable model field", () => {
    expect(matchesModelSearch("open ai", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
    expect(matchesModelSearch("gpt 5", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
  })

  test("matches tokens in any order across model fields", () => {
    expect(matchesModelSearch("sonnet anthropic", ["Claude 3.7 Sonnet", "anthropic"])).toBe(true)
    expect(matchesModelSearch("vertex gemini", ["Gemini 2.5 Pro", "Google Vertex"])).toBe(true)
  })

  test("matches compact identifiers and punctuation independently", () => {
    expect(matchesModelSearch("claude 37", ["Claude-3.7-Sonnet"])).toBe(true)
    expect(matchesModelSearch("open ai o3", ["o3-mini", "OpenAI"])).toBe(true)
  })

  test("ignores accents and repeated whitespace", () => {
    expect(matchesModelSearch("  mistral   large ", ["Místral-Large-2"])).toBe(true)
  })

  test("does not match unrelated searches", () => {
    expect(matchesModelSearch("claude", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(false)
  })
})
