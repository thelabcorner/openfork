import { beforeEach, describe, expect, test } from "bun:test"
import {
  getOpenRouterEndpoints,
  normalizeOpenRouterEndpoints,
  peekOpenRouterEndpoints,
  warmOpenRouterEndpoints,
  type OpenRouterEndpoint,
} from "./openrouter-endpoints"

const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for OpenRouter warm queue")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("OpenRouter endpoint cache", () => {
  beforeEach(() => localStorage.clear())

  test("preserves proxy-normalized $/M prices without a second unit conversion", () => {
    const [endpoint] = normalizeOpenRouterEndpoints([
      {
        providerName: "Provider",
        tag: "provider",
        provider: "provider",
        pricing: {
          prompt: "1.25",
          completion: "5",
          // Ultra-cheap normalized prices may legitimately be tiny; magnitude
          // is not a safe signal that this is still a per-token wire value.
          cacheRead: 0.00005,
        },
      },
    ])

    expect(endpoint?.pricing).toEqual({
      prompt: 1.25,
      completion: 5,
      cacheRead: 0.00005,
    })
  })

  test("daily warming populates once and reuses the in-memory cache", async () => {
    const modelID = "test/openrouter-warm-daily"
    let calls = 0
    const endpoint: OpenRouterEndpoint = {
      providerName: "Warm Provider",
      tag: "warm-provider",
      provider: "warm-provider",
      pricing: { prompt: 1, completion: 2, cacheRead: 0.5 },
      uptime: 99.9,
    }
    const fetcher = async () => {
      calls++
      return [endpoint]
    }

    warmOpenRouterEndpoints([modelID], fetcher)
    await waitUntil(() => peekOpenRouterEndpoints(modelID) !== undefined)

    expect(calls).toBe(1)
    expect(peekOpenRouterEndpoints(modelID)).toEqual([endpoint])

    warmOpenRouterEndpoints([modelID], fetcher)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(calls).toBe(1)
  })

  test("daily warming reuses a fresh persisted row when renderer memory is cold", async () => {
    const modelID = "test/openrouter-warm-persisted"
    const endpoint: OpenRouterEndpoint = {
      providerName: "Persisted Provider",
      tag: "persisted/provider",
      provider: "persisted",
      pricing: { prompt: 1, completion: 2, cacheRead: 0.5 },
      uptime: 99.9,
    }
    localStorage.setItem(
      `opencode.openrouter-endpoints.v5.${modelID}`,
      JSON.stringify({ version: 2, fetchedAt: Date.now(), endpoints: [endpoint] }),
    )
    let calls = 0

    warmOpenRouterEndpoints([modelID], async () => {
      calls++
      return [endpoint]
    })
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(calls).toBe(0)
    expect(peekOpenRouterEndpoints(modelID)).toEqual([endpoint])
  })

  test("background warming never exceeds three upstream requests", async () => {
    const modelIDs = Array.from({ length: 9 }, (_, index) => `test/openrouter-warm-concurrency-${index}`)
    let active = 0
    let peak = 0
    let calls = 0
    const fetcher = async (modelID: string) => {
      calls++
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 40))
      active--
      return [
        {
          providerName: modelID,
          tag: modelID,
          provider: "test",
          pricing: { prompt: 1, completion: 1, cacheRead: 0 },
          uptime: 100,
        },
      ] satisfies OpenRouterEndpoint[]
    }

    warmOpenRouterEndpoints(modelIDs, fetcher, { ttlMs: 0 })
    await waitUntil(() => calls === modelIDs.length)
    await waitUntil(() => modelIDs.every((id) => peekOpenRouterEndpoints(id) !== undefined))

    expect(peak).toBe(3)
  })

  test("a successful empty response clears stale provider rows", async () => {
    const modelID = "test/openrouter-successful-empty"
    localStorage.setItem(
      `opencode.openrouter-endpoints.v5.${modelID}`,
      JSON.stringify({
        version: 2,
        fetchedAt: Date.now() - 2 * 60 * 60 * 1000,
        endpoints: [
          {
            providerName: "Removed Provider",
            tag: "removed/provider",
            provider: "removed",
            pricing: { prompt: 1, completion: 1, cacheRead: 0 },
            uptime: 100,
          },
        ],
      }),
    )

    expect(await getOpenRouterEndpoints(modelID, async () => [])).toEqual([])
    expect(peekOpenRouterEndpoints(modelID)).toEqual([])
  })
})
