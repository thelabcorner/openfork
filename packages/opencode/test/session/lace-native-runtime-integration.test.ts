import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLMClient, type LLMClientShape } from "@opencode-ai/llm/route"
import type { LLMRequest } from "@opencode-ai/llm"
import type { Provider } from "@/provider/provider"
import { LLMNativeRuntime } from "../../src/session/llm/native-runtime"

const model = {
  id: "gpt-5-mini",
  providerID: "openai",
  api: { id: "gpt-5-mini", url: "https://api.openai.test/v1", npm: "@ai-sdk/openai" },
  limit: { context: 128000, input: 128000, output: 32000 },
  capabilities: {
    temperature: true, reasoning: true, attachment: true, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  headers: {}, options: {},
} as unknown as Provider.Model
const provider = {
  id: "openai", options: { apiKey: "offline" }, key: "offline",
} as unknown as Provider.Info
const owner = { owner: "workspace/account/session", session: "session-A" }
const input = {
  model, provider, auth: undefined, tools: {}, messages: [
    { role: "system" as const, content: "Keep this instruction unchanged" },
    { role: "user" as const, content: "Say hello" },
  ],
  headers: {}, abort: new AbortController().signal,
}

describe("LACE observed native production-stream seam", () => {
  test("disabled observer uses original stream method without compiling or dispatching HTTP", async () => {
    let streams = 0
    let compiles = 0
    const client = {
      stream: () => { streams++; return Stream.empty },
      compile: () => { compiles++; throw new Error("unexpected compile") },
    } as unknown as LLMClientShape
    const result = LLMNativeRuntime.stream({ ...input, llmClient: client })
    expect(result.type).toBe("supported")
    if (result.type !== "supported") return
    await Effect.runPromise(Stream.runCollect(result.stream))
    expect(streams).toBe(1)
    expect(compiles).toBe(0)
  })

  test("enabled observer compiles once and consumes that EXACT compiled stream, no second compilation", async () => {
    let streams = 0
    let compiles = 0
    const stream = Stream.empty
    const client = {
      stream: () => { streams++; throw new Error("stream() would recompile") },
      compile: (request: LLMRequest) => {
        compiles++
        return Effect.map(LLMClient.prepare(request), (prepared) => ({ prepared, stream }))
      },
    } as unknown as LLMClientShape
    const result = LLMNativeRuntime.stream({ ...input, llmClient: client, lace: owner })
    expect(result.type).toBe("supported")
    if (result.type !== "supported") return
    await Effect.runPromise(Stream.runCollect(result.stream))
    expect(compiles).toBe(1)
    expect(streams).toBe(0)
  })

  test("invalid observation does not prevent transport stream completion", async () => {
    let compiles = 0
    const client = {
      compile: (request: LLMRequest) => {
        compiles++
        return Effect.map(LLMClient.prepare(request), (prepared) => ({
          prepared: { ...prepared, protocol: "unsupported-future-protocol" },
          stream: Stream.empty,
        }))
      },
    } as unknown as LLMClientShape
    const result = LLMNativeRuntime.stream({ ...input, llmClient: client, lace: owner })
    expect(result.type).toBe("supported")
    if (result.type !== "supported") return
    await Effect.runPromise(Stream.runCollect(result.stream))
    expect(compiles).toBe(1)
  })

  test("100 independently scoped concurrent offline streams compile exactly once each", async () => {
    let compiles = 0
    let legacyStreams = 0
    const client = {
      stream: () => { legacyStreams++; throw new Error("unexpected legacy recompile") },
      compile: (request: LLMRequest) => {
        compiles++
        return Effect.map(LLMClient.prepare(request), (prepared) => ({
          prepared, stream: Stream.empty,
        }))
      },
    } as unknown as LLMClientShape
    const streams = Array.from({ length: 100 }, (_, i) => {
      const scoped = LLMNativeRuntime.stream({
        ...input, llmClient: client,
        lace: { owner: "workspace/owner-" + i, session: "session-" + i },
      })
      if (scoped.type !== "supported") throw new Error(scoped.reason)
      return Effect.runPromise(Stream.runCollect(scoped.stream))
    })
    await Promise.all(streams)
    expect(compiles).toBe(100)
    expect(legacyStreams).toBe(0)
  })
})
