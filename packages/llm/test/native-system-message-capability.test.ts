import { describe, expect, test } from "bun:test"
import { nativeSystemMessageCapability } from "../src"
import { Auth } from "../src/route"
import * as AnthropicMessages from "../src/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "../src/protocols/openai-compatible-chat"
import * as OpenAIResponses from "../src/protocols/openai-responses"

const anthropic = (id: string) =>
  AnthropicMessages.route
    .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
    .model({ id })

describe("nativeSystemMessageCapability", () => {
  test("uses documented cumulative semantics on the exact native Anthropic protocol", () => {
    expect(nativeSystemMessageCapability(anthropic("claude-opus-4-8"))).toEqual({
      history: "cumulative-privileged",
      turnScoped: false,
    })
  })

  test("fails closed for an unsupported Anthropic model on the native Anthropic protocol", () => {
    expect(nativeSystemMessageCapability(anthropic("claude-sonnet-5"))).toEqual({ history: "head-only", turnScoped: false })
  })

  test("does not infer Anthropic semantics from a Claude-looking id on an OpenAI-compatible route", () => {
    const model = OpenAICompatibleChat.route
      .with({ endpoint: { baseURL: "https://proxy.test/v1/" }, auth: Auth.bearer("test") })
      .model({ provider: "proxy", id: "claude-opus-4-8" })
    expect(nativeSystemMessageCapability(model)).toEqual({ history: "head-only", turnScoped: false })
  })

  test("keeps native OpenAI head-only until exact later privileged semantics are modeled", () => {
    const model = OpenAIResponses.route
      .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
      .model({ id: "gpt-5.6" })
    expect(nativeSystemMessageCapability(model)).toEqual({ history: "head-only", turnScoped: false })
  })
})
