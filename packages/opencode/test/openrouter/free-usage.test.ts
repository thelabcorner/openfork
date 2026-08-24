import { describe, expect, it } from "bun:test"
import { normalizeAnalyticsRow } from "../../src/openrouter/free-usage/core"
import { OpenRouterReadClient } from "../../src/openrouter/free-usage/openrouter"

describe("OpenRouter free usage analytics", () => {
  it("recognizes a free variant when Analytics returns the base model ID", () => {
    expect(
      normalizeAnalyticsRow({
        model: "thinkingmachines/inkling-20260715",
        variant: "free",
        request_count: "229",
      }),
    ).toMatchObject({
      model: "thinkingmachines/inkling-20260715",
      requests: 229,
    })
    expect(normalizeAnalyticsRow({ model: "stealth/ox-alpha", variant: "standard", request_count: 3281 })).toBeNull()
  })

  it("queries the model and variant dimensions", async () => {
    let body: { dimensions?: string[] } | undefined
    const client = new OpenRouterReadClient({
      managementKey: "test-management-key",
      timeoutMs: 1_000,
      fetchImpl: Object.assign(
        (async (_input: URL | RequestInfo, init?: BunFetchRequestInit | RequestInit) => {
          body = JSON.parse(String(init?.body)) as { dimensions?: string[] }
          return new Response(JSON.stringify({ data: { data: [], metadata: { row_count: 0, truncated: false } } }))
        }) as typeof fetch,
        { preconnect: globalThis.fetch.preconnect },
      ),
    })

    await client.analytics(new Date("2026-08-24T00:00:00Z"), new Date("2026-08-24T01:00:00Z"))

    expect(body?.dimensions).toEqual(["model", "variant"])
  })
})
