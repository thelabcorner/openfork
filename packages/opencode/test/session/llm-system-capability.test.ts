import { describe, expect, test } from "bun:test"
import type { Provider } from "@/provider/provider"
import { SessionLLMSystemCapability } from "@/session/llm/system-capability"

const model = (npm: string, id: string): Provider.Model =>
  ({
    id,
    providerID: "test",
    api: { id, npm, url: "https://example.test" },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1_000_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }) as Provider.Model

describe("Session LLM System capability intersection", () => {
  test.each(["claude-opus-4-8", "claude-opus-5", "claude-fable-5-1", "claude-mythos-5"])(
    "direct Anthropic %s is cumulative only on the audited native encoder",
    (id) => {
      const current = model("@ai-sdk/anthropic", id)
      expect(SessionLLMSystemCapability.effectiveSystemMessageCapability(current, "ai-sdk")).toEqual({
        history: "head-only",
        turnScoped: false,
      })
      expect(SessionLLMSystemCapability.effectiveSystemMessageCapability(current, "native")).toEqual({
        history: "cumulative-privileged",
        turnScoped: false,
      })
    },
  )

  test("Sonnet 5 stays head-only even though the installed AI SDK encoder can serialize a later System role", () => {
    const current = model("@ai-sdk/anthropic", "claude-sonnet-5")
    expect(SessionLLMSystemCapability.systemMessageEncoderCapability(current, "ai-sdk")).toEqual({
      chronological: false,
      turnScoped: false,
    })
    expect(SessionLLMSystemCapability.providerSystemMessageCapability(current)).toEqual({
      history: "none",
      turnScoped: false,
    })
    expect(SessionLLMSystemCapability.effectiveSystemMessageCapability(current, "ai-sdk")).toEqual({
      history: "head-only",
      turnScoped: false,
    })
  })

  test.each(["@ai-sdk/google-vertex/anthropic", "@ai-sdk/amazon-bedrock"])(
    "documented Claude platform stays head-only when the installed encoder is not current-safe: %s",
    (npm) => {
      const current = model(npm, "claude-opus-5")
      expect(SessionLLMSystemCapability.providerSystemMessageCapability(current).history).toBe("cumulative-privileged")
      expect(SessionLLMSystemCapability.effectiveSystemMessageCapability(current, "ai-sdk")).toEqual({
        history: "head-only",
        turnScoped: false,
      })
    },
  )

  test("proxy transports do not inherit Anthropic semantics from a Claude-looking model id", () => {
    const current = model("@openrouter/ai-sdk-provider", "anthropic/claude-opus-5")
    expect(SessionLLMSystemCapability.effectiveSystemMessageCapability(current, "ai-sdk")).toEqual({
      history: "head-only",
      turnScoped: false,
    })
  })

  test("turn-scoped semantics stay disabled until the runtime encoder implements clear_at", () => {
    const current = model("@ai-sdk/anthropic", "claude-opus-5")
    expect(SessionLLMSystemCapability.providerSystemMessageCapability(current).turnScoped).toBe(true)
    expect(SessionLLMSystemCapability.effectiveSystemMessageCapability(current, "ai-sdk").turnScoped).toBe(false)
    expect(SessionLLMSystemCapability.effectiveSystemMessageCapability(current, "native").turnScoped).toBe(false)
  })
})
