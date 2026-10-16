import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, Message } from "@opencode-ai/llm"
import { LLMClient, type LLMClientShape } from "@opencode-ai/llm/route"
import * as OpenAI from "@opencode-ai/llm/providers/openai"
import { createLaceNativeObserver } from "../../src/session/llm/lace-native-observer"

const model = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "offline" }).responses("gpt-5.6")
const make = (prompt: string) => LLM.request({
  model, system: "Immutable operator instructions",
  messages: [Message.user("Keep task state"), Message.assistant("Acknowledged"), Message.user(prompt)],
  cache: "none", providerOptions: { openai: { promptCacheKey: "offline-test" } },
})

describe("LACE single-compilation native observer seam", () => {
  test("compiles once, returns EXACT compiled stream, and observes provider-native body", async () => {
    let compileCalls = 0
    const stream = Stream.empty
    const client = {
      compile: (request: ReturnType<typeof make>) => {
        compileCalls++
        return Effect.map(LLMClient.prepare(request), (prepared) => ({ prepared, stream }))
      },
    } as unknown as LLMClientShape
    const lace = createLaceNativeObserver(4)
    const scope = { owner: "workspace/account/server", session: "session-A" }
    const a = await Effect.runPromise(lace.compile(client, make("First"), scope))
    const b = await Effect.runPromise(lace.compile(client, make("First"), scope))
    const c = await Effect.runPromise(lace.compile(client, make("Second"), scope))
    expect(compileCalls).toBe(3)
    expect(a.stream).toBe(stream)
    expect(b.stream).toBe(stream)
    expect(c.stream).toBe(stream)
    expect(a.lace.status).toBe("observed")
    expect(b.lace).toMatchObject({ status: "observed", observation: { kind: "prefix-identical" } })
    expect(c.lace).toMatchObject({ status: "observed", observation: { kind: "prefix-rewritten", firstChangedRegion: "input[3]" } })
  })

  test("missing trusted owner, unknown route protocol, and invalid body never interrupt provider stream", async () => {
    const sample = await Effect.runPromise(LLMClient.prepare(make("test")))
    const stream = Stream.empty
    const client = {
      compile: () => Effect.succeed({ prepared: sample, stream }),
    } as unknown as LLMClientShape
    const lace = createLaceNativeObserver(2)
    const badOwner = await Effect.runPromise(lace.compile(client, make("test"), { owner: "", session: "A" }))
    expect(badOwner.lace.status).toBe("invalid-identity")
    expect(badOwner.stream).toBe(stream)
    const unsupported = {
      compile: () => Effect.succeed({ prepared: { ...sample, protocol: "unknown-protocol" }, stream }),
    } as unknown as LLMClientShape
    const skip = await Effect.runPromise(lace.compile(unsupported, make("test"), { owner: "A", session: "B" }))
    expect(skip.lace.status).toBe("unsupported-protocol")
    const malformed = {
      compile: () => Effect.succeed({ prepared: { ...sample, body: { input: "invalid" } }, stream }),
    } as unknown as LLMClientShape
    const ignored = await Effect.runPromise(lace.compile(malformed, make("test"), { owner: "A", session: "B" }))
    expect(ignored.lace.status).toBe("observation-unavailable")
    expect(ignored.stream).toBe(stream)
    expect(lace.count()).toBe(0)
  })

  test("observational state is bounded and restart-safe", async () => {
    const sample = await Effect.runPromise(LLMClient.prepare(make("test")))
    const client = {
      compile: () => Effect.succeed({ prepared: sample, stream: Stream.empty }),
    } as unknown as LLMClientShape
    const lace = createLaceNativeObserver(1)
    await Effect.runPromise(lace.compile(client, make("test"), { owner: "A", session: "1" }))
    await Effect.runPromise(lace.compile(client, make("test"), { owner: "A", session: "2" }))
    expect(lace.count()).toBe(1)
    lace.clear()
    expect(lace.count()).toBe(0)
    const after = await Effect.runPromise(lace.compile(client, make("test"), { owner: "A", session: "2" }))
    expect(after.lace).toMatchObject({ status: "observed", observation: { kind: "first-observation" } })
  })
})
