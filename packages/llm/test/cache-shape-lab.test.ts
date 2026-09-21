import { createHash } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CacheHint, LLM, Message } from "../src"
import { Auth, LLMClient } from "../src/route"
import * as OpenAI from "../src/providers/openai"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import * as AnthropicMessages from "../src/protocols/anthropic-messages"
import { it } from "./lib/effect"

type Region = {
  readonly name: string
  readonly bytes: number
  readonly digest: string
  readonly cumulativeBytes: number
  readonly cumulativeDigest: string
  readonly value: unknown
  readonly encoded: string
}

const utf8 = new TextEncoder()

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry) => entry[1] !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

type RawRegion = Omit<Region, "cumulativeBytes" | "cumulativeDigest">

const region = (name: string, value: unknown): RawRegion => {
  // JSON.stringify(undefined) itself returns undefined. Keep absence explicit so
  // a region that is not present has a stable identity distinct from null/empty.
  const encoded = value === undefined ? "<absent>" : JSON.stringify(canonical(value))
  return {
    name,
    bytes: utf8.encode(encoded).byteLength,
    digest: createHash("sha256").update(encoded).digest("hex"),
    value,
    encoded,
  }
}

const frame = (value: string) => `${utf8.encode(value).byteLength}:${value}`

const sealRegions = (regions: ReadonlyArray<RawRegion>): Region[] => {
  let prefix = ""
  let cumulativeBytes = 0
  return regions.map((item) => {
    prefix += frame(item.name) + frame(item.encoded)
    cumulativeBytes += item.bytes
    return {
      ...item,
      cumulativeBytes,
      cumulativeDigest: createHash("sha256").update(prefix).digest("hex"),
    }
  })
}

const firstDifference = (left: ReadonlyArray<Region>, right: ReadonlyArray<Region>) => {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index]
    const b = right[index]
    if (!a || !b || a.name !== b.name || a.digest !== b.digest) return { index, left: a, right: b }
  }
  return undefined
}

const openAIRegions = (body: OpenAIResponses.OpenAIResponsesBody): Region[] => sealRegions([
  region("route/model", body.model),
  region("cache-isolation", body.prompt_cache_key),
  region("cache-mechanics", {
    mode: body.prompt_cache_options?.mode,
    ttl: body.prompt_cache_options?.ttl,
  }),
  region("cache-diagnostics", body.prompt_cache_options?.comparison_response_id),
  region("tools", body.tools),
  ...body.input.map((item, index) => region(`input[${index}]`, item)),
  region("generation", {
    tool_choice: body.tool_choice,
    reasoning: body.reasoning,
    text: body.text,
    max_output_tokens: body.max_output_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
  }),
])

const anthropicRegions = (body: AnthropicMessages.AnthropicMessagesBody): Region[] => sealRegions([
  region("route/model", body.model),
  region("tools", body.tools),
  region("privileged-head", body.system),
  ...body.messages.map((message, index) => region(`messages[${index}]`, message)),
  region("generation", {
    tool_choice: body.tool_choice,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    stop_sequences: body.stop_sequences,
    thinking: body.thinking,
  }),
])

const openAI = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.6")
const anthropic = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-opus-4-8" })

const prepareOpenAI = (input: Parameters<typeof LLM.request>[0]) =>
  LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(LLM.request(input))

const prepareAnthropic = (input: Parameters<typeof LLM.request>[0]) =>
  LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(LLM.request(input))

describe("deterministic cache request-shape lab", () => {
  it.effect("OpenAI append-only conversation preserves every prior model-input region", () =>
    Effect.gen(function* () {
      const common = {
        model: openAI,
        system: "Stable operator policy.",
        tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
        providerOptions: { openai: { promptCacheKey: "isolation-A" } },
        cache: "none" as const,
      }
      const base = yield* prepareOpenAI({ ...common, messages: [Message.user("Turn A")] })
      const next = yield* prepareOpenAI({
        ...common,
        messages: [Message.user("Turn A"), Message.assistant("Turn B"), Message.user("Turn C")],
      })

      expect(Array.from(next.body.input.slice(0, base.body.input.length))).toEqual(Array.from(base.body.input))
      expect(next.body.tools).toEqual(base.body.tools)
      const baseRegions = openAIRegions(base.body)
      const nextRegions = openAIRegions(next.body)
      const retainedBoundary = baseRegions.find((item) => item.name === "input[1]")!
      const nextRetainedBoundary = nextRegions.find((item) => item.name === "input[1]")!
      expect(nextRetainedBoundary.cumulativeDigest).toBe(retainedBoundary.cumulativeDigest)
      expect(nextRetainedBoundary.cumulativeBytes).toBe(retainedBoundary.cumulativeBytes)
      const diff = firstDifference(baseRegions, nextRegions)
      expect(diff?.left?.name).toBe("generation")
      expect(diff?.right?.name).toBe("input[2]")
    }),
  )

  it.effect("OpenAI privileged-head mutation is an early model-input bust", () =>
    Effect.gen(function* () {
      const first = yield* prepareOpenAI({
        model: openAI,
        system: "Policy A",
        prompt: "Same user turn",
        providerOptions: { openai: { promptCacheKey: "isolation-A" } },
        cache: "none",
      })
      const second = yield* prepareOpenAI({
        model: openAI,
        system: "Policy B",
        prompt: "Same user turn",
        providerOptions: { openai: { promptCacheKey: "isolation-A" } },
        cache: "none",
      })
      const diff = firstDifference(openAIRegions(first.body), openAIRegions(second.body))
      expect(diff?.left?.name).toBe("input[0]")
      expect(diff?.right?.name).toBe("input[0]")
    }),
  )

  it.effect("OpenAI isolation-key mutation changes cache domain without changing model-visible input", () =>
    Effect.gen(function* () {
      const requestFor = (promptCacheKey: string) =>
        prepareOpenAI({
          model: openAI,
          system: "Stable operator policy.",
          prompt: "Stable user turn.",
          providerOptions: { openai: { promptCacheKey } },
          cache: "none",
        })
      const left = yield* requestFor("isolation-A")
      const right = yield* requestFor("isolation-B")

      expect(left.body.input).toEqual(right.body.input)
      expect(left.body.tools).toEqual(right.body.tools)
      expect(left.body.prompt_cache_key).not.toBe(right.body.prompt_cache_key)
      expect(firstDifference(openAIRegions(left.body), openAIRegions(right.body))?.left?.name).toBe("cache-isolation")
    }),
  )

  it.effect("OpenAI cache mode changes provider cache mechanics without changing semantic input", () =>
    Effect.gen(function* () {
      const requestFor = (mode: "implicit" | "explicit") =>
        prepareOpenAI({
          model: openAI,
          system: "Stable operator policy.",
          prompt: "Stable user turn.",
          providerOptions: { openai: { promptCacheKey: "isolation-A", promptCacheOptions: { mode } } },
          cache: "none",
        })
      const implicit = yield* requestFor("implicit")
      const explicit = yield* requestFor("explicit")

      expect(implicit.body.input).toEqual(explicit.body.input)
      expect(firstDifference(openAIRegions(implicit.body), openAIRegions(explicit.body))?.left?.name).toBe("cache-mechanics")
    }),
  )

  it.effect("OpenAI diagnostic comparison is observational and leaves cache mechanics + semantic input unchanged", () =>
    Effect.gen(function* () {
      const requestFor = (comparisonResponseId?: string) =>
        prepareOpenAI({
          model: openAI,
          system: "Stable operator policy.",
          prompt: "Stable user turn.",
          providerOptions: {
            openai: {
              promptCacheKey: "isolation-A",
              promptCacheOptions: {
                mode: "implicit",
                ...(comparisonResponseId ? { comparisonResponseId } : {}),
              },
            },
          },
          cache: "none",
        })
      const plain = yield* requestFor()
      const diagnostic = yield* requestFor("resp_reference")

      expect(plain.body.input).toEqual(diagnostic.body.input)
      expect(plain.body.tools).toEqual(diagnostic.body.tools)
      const plainRegions = openAIRegions(plain.body)
      const diagnosticRegions = openAIRegions(diagnostic.body)
      expect(plainRegions.find((item) => item.name === "cache-isolation")?.digest).toBe(
        diagnosticRegions.find((item) => item.name === "cache-isolation")?.digest,
      )
      expect(plainRegions.find((item) => item.name === "cache-mechanics")?.digest).toBe(
        diagnosticRegions.find((item) => item.name === "cache-mechanics")?.digest,
      )
      expect(firstDifference(plainRegions, diagnosticRegions)?.left?.name).toBe("cache-diagnostics")
    }),
  )

  it.effect("OpenAI explicit System breakpoint preserves the stable privileged region across a dynamic suffix", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const requestFor = (prompt: string) =>
        prepareOpenAI({
          model: openAI,
          system: [{ type: "text", text: "Stable operator policy.", cache }],
          prompt,
          providerOptions: {
            openai: { promptCacheKey: "isolation-A", promptCacheOptions: { mode: "explicit", ttl: "30m" } },
          },
          cache: "none",
        })
      const left = yield* requestFor("Dynamic A")
      const right = yield* requestFor("Dynamic B")
      const leftRegions = openAIRegions(left.body)
      const rightRegions = openAIRegions(right.body)
      const diff = firstDifference(leftRegions, rightRegions)

      expect(left.body.input[0]).toEqual(right.body.input[0])
      const leftSystemRegion = leftRegions.find((item) => item.name === "input[0]")!
      const rightSystemRegion = rightRegions.find((item) => item.name === "input[0]")!
      expect(leftSystemRegion.digest).toBe(rightSystemRegion.digest)
      expect(left.body.input[0]).toMatchObject({
        role: "system",
        content: [expect.objectContaining({ prompt_cache_breakpoint: { mode: "explicit" } })],
      })
      expect(diff?.left?.name).toBe("input[1]")
    }),
  )

  it.effect("OpenAI tool-manifest mutation changes the cache-relevant tool region before conversation history", () =>
    Effect.gen(function* () {
      const requestFor = (description: string) =>
        prepareOpenAI({
          model: openAI,
          system: "Stable policy.",
          prompt: "Stable user turn.",
          tools: [{ name: "read", description, inputSchema: { type: "object", properties: {} } }],
          providerOptions: { openai: { promptCacheKey: "isolation-A" } },
          cache: "none",
        })
      const left = yield* requestFor("Read one file")
      const right = yield* requestFor("Read a file")

      expect(left.body.input).toEqual(right.body.input)
      expect(firstDifference(openAIRegions(left.body), openAIRegions(right.body))?.left?.name).toBe("tools")
    }),
  )

  it.effect("Anthropic valid chronological System append retains the complete earlier provider prefix", () =>
    Effect.gen(function* () {
      const common = {
        model: anthropic,
        system: "Stable operator head.",
        cache: "none" as const,
      }
      const base = yield* prepareAnthropic({ ...common, messages: [Message.user("Before.")] })
      const next = yield* prepareAnthropic({
        ...common,
        messages: [Message.user("Before."), Message.system("Additive operator update."), Message.assistant("After.")],
      })

      expect(next.body.system).toEqual(base.body.system)
      expect(Array.from(next.body.messages.slice(0, base.body.messages.length))).toEqual(Array.from(base.body.messages))
      const baseRegions = anthropicRegions(base.body)
      const nextRegions = anthropicRegions(next.body)
      expect(nextRegions.find((item) => item.name === "messages[0]")?.cumulativeDigest).toBe(
        baseRegions.find((item) => item.name === "messages[0]")?.cumulativeDigest,
      )
      const diff = firstDifference(baseRegions, nextRegions)
      expect(diff?.left?.name).toBe("generation")
      expect(diff?.right?.name).toBe("messages[1]")
    }),
  )

  it.effect("Anthropic privileged-head mutation is distinguished from chronological append", () =>
    Effect.gen(function* () {
      const left = yield* prepareAnthropic({ model: anthropic, system: "Policy A", prompt: "Same", cache: "none" })
      const right = yield* prepareAnthropic({ model: anthropic, system: "Policy B", prompt: "Same", cache: "none" })

      expect(left.body.messages).toEqual(right.body.messages)
      expect(firstDifference(anthropicRegions(left.body), anthropicRegions(right.body))?.left?.name).toBe("privileged-head")
    }),
  )
})
