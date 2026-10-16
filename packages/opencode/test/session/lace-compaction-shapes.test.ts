/**
 * No-network V1 LACE compaction experiment: observe REAL compiled native bodies
 * for the existing isolated strategy vs a parent-prefix summary fork.
 * This proves request shape only; no cost or semantic-quality wins are implied.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import * as OpenAI from "@opencode-ai/llm/providers/openai"
import { compareRequestWitness, witnessCompiledRequest } from "@opencode-ai/llm/cache-request-witness"
import { chooseCompactionArm, type CompactionArm } from "../../src/session/lace-compaction-plan"

const openAI = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "offline-fixture" }).responses("gpt-5.6")
const parentMessages = [
  Message.user("Find the issue in packages/opencode/test/session/compaction.test.ts"),
  Message.assistant("The fixture builds a temporary instance."),
  Message.user("We need to preserve current provenance and tool causality."),
]
const parent = () => LLMClient.prepare<{ input: unknown[] }>(LLM.request({
  model: openAI, system: "Immutable project instructions", tools: [
    { name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } },
  ], messages: parentMessages, cache: "none",
  providerOptions: { openai: { promptCacheKey: "offline-test-same-domain" } },
}))

const fork = () => LLMClient.prepare<{ input: unknown[] }>(LLM.request({
  model: openAI, system: "Immutable project instructions", tools: [
    { name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } },
  ], messages: [...parentMessages, Message.user("Produce a concise evidence-carrying compaction summary.")],
  cache: "none", providerOptions: { openai: { promptCacheKey: "offline-test-same-domain" } },
}))

const isolated = () => LLMClient.prepare<{ input: unknown[] }>(LLM.request({
  model: openAI, system: "Immutable project instructions", tools: [
    { name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } },
  ], messages: [Message.user("Summarize this serialized history: " + parentMessages.map((m) => JSON.stringify(m)).join("\n"))],
  cache: "none", providerOptions: { openai: { promptCacheKey: "offline-test-same-domain" } },
}))

const witness = (body: unknown) => witnessCompiledRequest({
  owner: "owner-A", session: "session-A", provider: "openai", model: "gpt-5.6",
  runtime: "native", route: "direct/responses", protocol: "openai-responses", body: body as Record<string, unknown>,
})

const arm = (kind: CompactionArm["kind"], historicalTokens: number, newTokens: number, hitProbability: number): CompactionArm => ({
  kind, authorized: true, fitsContext: true, authorityPreserved: true, toolHistoryClosed: true,
  reasoningCompatible: true, parentRouteCompatible: true,
  input: {
    historicalTokens, newTokens, hitProbability, ordinaryPrice: 1, cacheReadPrice: 0.1, cacheMissPrice: 1,
  },
  output: { expectedTokens: 300, price: 1 },
})

describe("LACE native compaction request-shape experiments", () => {
  test("parent fork shares actual compiled native prefix; isolated history text cannot", async () => {
    const [p, f, i] = await Promise.all([
      Effect.runPromise(parent()), Effect.runPromise(fork()), Effect.runPromise(isolated()),
    ])
    // Prefix equality is established on exact provider-compiled data, not an
    // invented text concatenation; first tool/system/history parts remain equal.
    expect(f.body.input.slice(0, p.body.input.length)).toEqual(p.body.input)
    const forkChange = compareRequestWitness(witness(p.body), witness(f.body))
    const isolatedChange = compareRequestWitness(witness(p.body), witness(i.body))
    expect(forkChange.kind).toBe("prefix-extended")
    expect(isolatedChange.kind).toBe("prefix-rewritten")
    expect(forkChange.retainedRegionCount).toBeGreaterThan(isolatedChange.retainedRegionCount)
    expect(i.body.input.length).toBeLessThan(f.body.input.length)
  })

  test("forecast uses both arm costs, not just predicted cache hit ratio", () => {
    const choice = chooseCompactionArm(arm("isolated", 8000, 500, 0), arm("parent-prefix-fork", 8000, 60, 0.95))
    expect(choice.choice).toBe("parent-prefix-fork")
    const cheapIsolated: CompactionArm = {
      ...arm("isolated", 8000, 500, 0),
      input: { ...arm("isolated", 8000, 500, 0).input, ordinaryPrice: 0.05, cacheMissPrice: 0.05 },
      output: { expectedTokens: 300, price: 0.05 },
    }
    expect(chooseCompactionArm(cheapIsolated, arm("parent-prefix-fork", 8000, 60, 0.95)).choice).toBe("isolated")
  })

  test("incompatible route, incomplete tools, incompatible reasoning, and overflow exclude the fork", () => {
    const base = arm("parent-prefix-fork", 8000, 60, 0.95)
    for (const rejected of [
      { parentRouteCompatible: false }, { toolHistoryClosed: false },
      { reasoningCompatible: false }, { fitsContext: false },
    ]) {
      expect(chooseCompactionArm(arm("isolated", 8000, 500, 0), { ...base, ...rejected }).choice).toBe("isolated")
    }
  })
})
