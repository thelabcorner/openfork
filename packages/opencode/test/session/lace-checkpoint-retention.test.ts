import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { Token } from "../../src/util/token"
import { firstFittingSuffix, isMonotoneTextSuffix } from "../../src/session/lace-checkpoint-retention"

const assistant = (info: Record<string, unknown> = {}, parts?: Record<string, unknown>[]): SessionV1.WithParts =>
  ({
    info: { role: "assistant", finish: "end_turn", ...info },
    parts: parts ?? [{ type: "text", text: "finished" }],
  }) as unknown as SessionV1.WithParts

const choose = (costs: readonly number[], budget: number, observed: number[]) =>
  Effect.runPromise(firstFittingSuffix({
    starts: costs.map((_, index) => index),
    budget,
    estimate: (start) => Effect.sync(() => {
      observed.push(start)
      return costs[start]!
    }),
  }))

describe("LACE bounded exact-estimate checkpoint suffix", () => {
  test("plain-text suffix costs are monotone under the actual V1 model-message projection", async () => {
    const model = {
      providerID: "test",
      id: "test",
      api: { npm: "@ai-sdk/anthropic", id: "test" },
    } as Provider.Model
    let seed = 0x51cf1234
    const rand = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return seed >>> 0
    }
    for (let trial = 0; trial < 80; trial++) {
      const count = 3 + (rand() % 18)
      const messages: SessionV1.WithParts[] = Array.from({ length: count }, (_, i) => assistant({
        id: "m" + i,
        providerID: "test",
        modelID: "test",
      }, [
        { type: "step-start" },
        { type: "text", text: "step" + i + ":" + "q".repeat(1 + (rand() % 500)) },
        { type: "step-finish" },
      ]))
      expect(isMonotoneTextSuffix(messages)).toBe(true)
      const costs: number[] = []
      for (let start = 0; start < count; start++) {
        const projected = await Effect.runPromise(MessageV2.toModelMessagesEffect(messages.slice(start), model))
        costs.push(Token.estimate(JSON.stringify(projected)))
      }
      for (let start = 1; start < count; start++) {
        expect(costs[start]!).toBeLessThanOrEqual(costs[start - 1]!)
      }
      const budget = rand() % (costs[0]! + 100)
      const visited: number[] = []
      const expected = costs.findIndex((cost) => cost <= budget)
      expect(await choose(costs, budget, visited)).toBe(expected < 0 ? undefined : expected)
    }
  })
  test("fast-path admission requires finished, metadata-free plain assistant text", () => {
    expect(isMonotoneTextSuffix([assistant(), assistant()])).toBe(true)
    expect(isMonotoneTextSuffix([assistant({}, [
      { type: "step-start" },
      { type: "text", text: "normal final response" },
      { type: "step-finish" },
    ])])).toBe(true)
    expect(isMonotoneTextSuffix([])).toBe(false)
    for (const unsafe of [
      assistant({ role: "user" }),
      assistant({ finish: undefined }),
      assistant({ finish: "tool-calls" }),
      assistant({ summary: true }),
      assistant({ error: { name: "provider-error" } }),
      assistant({}, []),
      assistant({}, [{ type: "text", text: "a", synthetic: true }]),
      assistant({}, [{ type: "text", text: "a", ignored: true }]),
      assistant({}, [{ type: "text", text: "a", metadata: {} }]),
      assistant({}, [{ type: "text", text: "a", providerMetadata: {} }]),
      assistant({}, [{ type: "text", text: "a", providerOptions: {} }]),
      assistant({}, [{ type: "tool", state: { status: "completed" } }]),
      assistant({}, [{ type: "reasoning", text: "signed" }]),
      assistant({}, [{ type: "file", mime: "image/png" }]),
      assistant({}, [{ type: "step-start" }]),
      assistant({}, [{ type: "text", text: "" }]),
    ]) {
      expect(isMonotoneTextSuffix([assistant(), unsafe])).toBe(false)
    }
  })
  test("finds the earliest fitting boundary, measuring that exact suffix", async () => {
    const visits: number[] = []
    expect(await choose([120, 90, 45, 15], 47, visits)).toBe(2)
    expect(visits).toContain(2)
    expect(visits.length).toBeLessThanOrEqual(4)
  })

  test("fails closed if even the shortest suffix cannot fit or the budget is invalid", async () => {
    for (const budget of [0, -1, NaN, Infinity]) {
      const visits: number[] = []
      expect(await choose([30, 20, 10], budget, visits)).toBeUndefined()
      expect(visits).toHaveLength(0)
    }
    const visits: number[] = []
    expect(await choose([30, 20, 10], 9, visits)).toBeUndefined()
    expect(visits).toEqual([2])
    expect(await choose([], 10, [])).toBeUndefined()
  })

  test("never admits a non-finite estimate", async () => {
    const visited: number[] = []
    expect(await choose([100, 10, NaN], 20, visited)).toBeUndefined()
    expect(visited).toEqual([2])
  })

  test("10,000 seeded monotone cases match the linear exhaustive oracle", async () => {
    let seed = 0x3ac49dc1
    const rand = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return seed >>> 0
    }
    for (let trial = 0; trial < 10_000; trial++) {
      const length = 1 + (rand() % 64)
      const suffix = new Array<number>(length)
      let sum = 0
      for (let i = length - 1; i >= 0; i--) {
        sum += 1 + (rand() % 30)
        suffix[i] = sum
      }
      const budget = rand() % (sum + 40)
      const visited: number[] = []
      const actual = await choose(suffix, budget, visited)
      const expectedIndex = suffix.findIndex((v) => v <= budget)
      expect(actual).toBe(expectedIndex < 0 ? undefined : expectedIndex)
      expect(visited.length).toBeLessThanOrEqual(Math.ceil(Math.log2(length)) + 2)
    }
  })

  test("large pathological turn uses logarithmic estimates rather than linear rescans", async () => {
    const n = 65_536
    const suffix = Array.from({ length: n }, (_, i) => n - i)
    const visits: number[] = []
    const result = await choose(suffix, 4_000, visits)
    expect(result).toBe(n - 4_000)
    expect(visits.length).toBeLessThanOrEqual(18)
    expect(new Set(visits).size).toBe(visits.length)
  })
})
