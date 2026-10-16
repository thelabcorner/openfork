import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "../src"
import { Auth, LLMClient } from "../src/route"
import * as OpenAI from "../src/providers/openai"
import * as Anthropic from "../src/protocols/anthropic-messages"
import {
  compareRequestWitness,
  createRequestWitnessObserver,
  witnessCompiledRequest,
  type CompiledRequestInput,
} from "../src/cache-request-witness"
import { it } from "./lib/effect"

const openAI = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "fake" }).responses("gpt-5.6")
const anthropic = Anthropic.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "fake") })
  .model({ id: "claude-opus-4-8" })

const shape = (body: unknown, overrides: Partial<CompiledRequestInput> = {}): CompiledRequestInput => ({
  owner: "server-A/account-A/workspace-A",
  session: "session-A",
  provider: "openai",
  model: "gpt-5.6",
  runtime: "native",
  route: "direct/responses",
  protocol: "openai-responses",
  body: body as Record<string, unknown>,
  ...overrides,
})

const openAIRequest = (system: string, messages: Array<ReturnType<typeof Message.user> | ReturnType<typeof Message.assistant>>, tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>, extra: Record<string, unknown> = {}) =>
  LLMClient.prepare(LLM.request({
    model: openAI, system, messages, tools, cache: "none",
    providerOptions: { openai: { promptCacheKey: "cache-isolation-A", ...extra } },
  }))

describe("LACE compiled native request witness", () => {
  it.effect("real OpenAI native requests preserve exact prefix across appended messages", () =>
    Effect.gen(function* () {
      const one = yield* openAIRequest("Operator policy", [Message.user("Task")])
      const two = yield* openAIRequest("Operator policy", [
        Message.user("Task"), Message.assistant("Progress"), Message.user("Continue"),
      ])
      const result = compareRequestWitness(witnessCompiledRequest(shape(one.body)), witnessCompiledRequest(shape(two.body)))
      expect(result.kind).toBe("prefix-extended")
      expect(result.retainedRegionCount).toBeGreaterThan(1)
      expect(result.bodyChanged).toBe(true)
    }),
  )

  it.effect("real OpenAI changed privileged prompt is early invalidation", () =>
    Effect.gen(function* () {
      const a = yield* openAIRequest("Admin A", [Message.user("Task")])
      const b = yield* openAIRequest("Admin B", [Message.user("Task")])
      const result = compareRequestWitness(witnessCompiledRequest(shape(a.body)), witnessCompiledRequest(shape(b.body)))
      expect(result.kind).toBe("prefix-rewritten")
      expect(result.firstChangedRegion).toBe("input[0]")
    }),
  )

  it.effect("tool schema mutation is never concealed by an identical chat history", () =>
    Effect.gen(function* () {
      const tools = (description: string) => [{ name: "read", description, inputSchema: { type: "object", properties: { path: { type: "string" } } } }]
      const a = yield* openAIRequest("Policy", [Message.user("Task")], tools("Read"))
      const b = yield* openAIRequest("Policy", [Message.user("Task")], tools("Read with changed schema"))
      expect(compareRequestWitness(witnessCompiledRequest(shape(a.body)), witnessCompiledRequest(shape(b.body))))
        .toMatchObject({ kind: "prefix-rewritten", firstChangedRegion: "tools", retainedRegionCount: 0 })
    }),
  )

  it.effect("native cache options affect policy; comparison-only diagnostics do not change it", () =>
    Effect.gen(function* () {
      const one = yield* openAIRequest("Policy", [Message.user("Task")], undefined, {
        promptCacheOptions: { mode: "implicit" },
      })
      const diag = yield* openAIRequest("Policy", [Message.user("Task")], undefined, {
        promptCacheOptions: { mode: "implicit", comparisonResponseId: "resp_comparison_only" },
      })
      const explicit = yield* openAIRequest("Policy", [Message.user("Task")], undefined, {
        promptCacheOptions: { mode: "explicit" },
      })
      const base = witnessCompiledRequest(shape(one.body))
      const observation = compareRequestWitness(base, witnessCompiledRequest(shape(diag.body)))
      expect(observation.kind).toBe("prefix-identical")
      expect(observation.bodyChanged).toBe(true)
      expect(compareRequestWitness(base, witnessCompiledRequest(shape(explicit.body))).kind).toBe("cache-policy-changed")
    }),
  )

  it.effect("real Anthropic native messages are projected in tool-system-history order", () =>
    Effect.gen(function* () {
      const options = { model: anthropic, system: "Policy", cache: "none" as const }
      const a = yield* LLMClient.prepare(LLM.request({ ...options, messages: [Message.user("Task")] }))
      const b = yield* LLMClient.prepare(LLM.request({ ...options, messages: [Message.user("Task"), Message.assistant("Progress")] }))
      const witness = (body: unknown) => witnessCompiledRequest(shape(body, {
        protocol: "anthropic-messages", provider: "anthropic", model: "claude-opus-4-8", route: "anthropic/messages",
      }))
      const regions = witness(a.body).regions
      expect(regions.map((r) => r.name)).toEqual(["tools", "system", "messages[0]"])
      expect(compareRequestWitness(witness(a.body), witness(b.body)).kind).toBe("prefix-extended")
    }),
  )

  test("account/route/model changes classify as different cache domains", () => {
    const base = witnessCompiledRequest(shape({ input: [{ role: "user", content: "test" }] }))
    for (const mutation of [
      { owner: "server-A/account-B/workspace-A" },
      { model: "gpt-5.5" },
      { route: "proxied/responses" },
      { runtime: "ai-sdk" },
      { session: "other-session" },
    ]) {
      const current = witnessCompiledRequest(shape({ input: [{ role: "user", content: "test" }] }, mutation))
      expect(compareRequestWitness(base, current).kind).toBe("cache-domain-changed")
    }
  })

  test("generation-only changes remain distinguishable from an actual prefix mutation", () => {
    const base = witnessCompiledRequest(shape({ tools: [], input: [{ role: "user", content: "Task" }], temperature: 0 }))
    const later = witnessCompiledRequest(shape({ tools: [], input: [{ role: "user", content: "Task" }], temperature: 1 }))
    expect(compareRequestWitness(base, later)).toMatchObject({ kind: "prefix-identical", bodyChanged: true, bodyIdentical: false })
  })

  test("observation retention is bounded; source prompts never appear in results", () => {
    const observer = createRequestWitnessObserver(2)
    const make = (session: string) => shape({ input: [{ role: "user", content: "SECRET_PROMPT_DO_NOT_LOG" }] }, { session })
    expect(observer.observe(make("A")).kind).toBe("first-observation")
    expect(observer.observe(make("A")).kind).toBe("prefix-identical")
    observer.observe(make("B"))
    observer.observe(make("C"))
    expect(observer.size()).toBe(2)
    expect(observer.observe(make("A")).kind).toBe("first-observation")
    expect(JSON.stringify(observer.observe(make("A")))).not.toContain("SECRET_PROMPT")
    observer.clear()
    expect(observer.size()).toBe(0)
  })

  test("global retained-region budget evicts oldest witnesses even when session count is low", () => {
    const observer = createRequestWitnessObserver(128, 6)
    const make = (session: string) => shape({ input: [
      { role: "user", content: "one" }, { role: "assistant", content: "two" },
    ] }, { session })
    expect(observer.observe(make("A")).kind).toBe("first-observation")
    observer.observe(make("B"))
    expect(observer.size()).toBe(1)
    expect(observer.observe(make("A")).kind).toBe("first-observation")
    expect(observer.size()).toBe(1)
    observer.clear()
    expect(observer.size()).toBe(0)
    expect(() => createRequestWitnessObserver(10, 0)).toThrow()
  })

  test("unknown protocol, non-JSON body, malformed message shape, and missing owner fail closed", () => {
    const base = shape({ input: [] })
    expect(() => witnessCompiledRequest({ ...base, protocol: "future-protocol" as CompiledRequestInput["protocol"] })).toThrow()
    expect(() => witnessCompiledRequest({ ...base, body: { input: [BigInt(1)] } })).toThrow()
    expect(() => witnessCompiledRequest({ ...base, body: { input: "not-array" } })).toThrow()
    expect(() => witnessCompiledRequest({ ...base, owner: "" })).toThrow()
    expect(() => createRequestWitnessObserver(0)).toThrow()
  })

  test("missing optional instruction cannot collide with literal sentinel-like user content", () => {
    const absent = witnessCompiledRequest(shape({ input: [] }))
    const present = witnessCompiledRequest(shape({ instructions: "<lace:absent>", input: [] }))
    expect(compareRequestWitness(absent, present)).toMatchObject({
      kind: "prefix-rewritten", firstChangedRegion: "instructions",
    })
    const undefinedField = witnessCompiledRequest(shape({ instructions: undefined, input: [] }))
    expect(compareRequestWitness(absent, undefinedField).kind).toBe("prefix-identical")
    expect(compareRequestWitness(absent, undefinedField).bodyIdentical).toBe(true)
  })

  test("pathologically many message regions fail closed instead of allocating unbounded witnesses", () => {
    expect(() => witnessCompiledRequest(shape({ input: Array.from({ length: 8193 }, () => ({ role: "user", content: "" })) })))
      .toThrow("too many observable regions")
  })
})
