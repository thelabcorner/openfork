import { describe, expect, test } from "bun:test"
import { rankOpenRouterEndpoints } from "./openrouter-endpoint-ranking"
import type { OpenRouterEndpoint } from "./openrouter-endpoints"

const endpoint = (
  providerName: string,
  options: { price: number; throughput?: number; cache?: number; uptime?: number },
): OpenRouterEndpoint => ({
  providerName,
  provider: providerName.toLowerCase(),
  tag: providerName.toLowerCase(),
  pricing: { prompt: options.price / 2, completion: options.price / 2, cacheRead: 0 },
  uptime: options.uptime,
  telemetry:
    options.cache === undefined && options.throughput === undefined
      ? undefined
      : {
          cacheHitPercent: options.cache ?? 0,
          ...(options.throughput === undefined ? {} : { throughputTps: options.throughput }),
        },
})

describe("rankOpenRouterEndpoints", () => {
  test("fuses speed, price, and cache rank instead of letting one unit dominate", () => {
    const fastest = endpoint("Fast", { price: 9, throughput: 300, cache: 10 })
    const balanced = endpoint("Balanced", { price: 2, throughput: 180, cache: 95 })
    const cheap = endpoint("Cheap", { price: 1, throughput: 80, cache: 60 })

    const ranked = rankOpenRouterEndpoints([fastest, balanced, cheap])
    expect(ranked[0].endpoint.providerName).toBe("Balanced")
    expect(ranked.find((entry) => entry.endpoint === fastest)?.fastest).toBe(true)
    expect(ranked.find((entry) => entry.endpoint === cheap)?.cheapest).toBe(true)
    expect(ranked.find((entry) => entry.endpoint === balanced)?.bestCache).toBe(true)
  })

  test("falls back to price when performance telemetry is unavailable", () => {
    const expensive = endpoint("Expensive", { price: 4 })
    const cheap = endpoint("Cheap", { price: 1 })
    expect(rankOpenRouterEndpoints([expensive, cheap]).map((entry) => entry.endpoint.providerName)).toEqual([
      "Cheap",
      "Expensive",
    ])
  })

  test("uses endpoint 30m throughput when longer-window telemetry is absent", () => {
    const a = { ...endpoint("A", { price: 1 }), throughputP50: 40 }
    const b = { ...endpoint("B", { price: 1 }), throughputP50: 90 }
    expect(rankOpenRouterEndpoints([a, b])[0].endpoint.providerName).toBe("B")
  })

  test("prefers fresh endpoint 30m P50 over the historical telemetry fallback", () => {
    const a = { ...endpoint("A", { price: 1, throughput: 200 }), throughputP50: 40 }
    const b = { ...endpoint("B", { price: 1, throughput: 50 }), throughputP50: 90 }
    expect(rankOpenRouterEndpoints([a, b])[0].endpoint.providerName).toBe("B")
  })

  test("keeps deterministic uptime/name tie-breakers", () => {
    const a = endpoint("Alpha", { price: 1, throughput: 100, cache: 80, uptime: 99 })
    const b = endpoint("Beta", { price: 1, throughput: 100, cache: 80, uptime: 100 })
    expect(rankOpenRouterEndpoints([a, b])[0].endpoint.providerName).toBe("Beta")
  })
})
