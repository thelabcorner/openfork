import { describe, expect, test } from "bun:test"
import { getUsagePricingTable, getUsageProfileTable, getUsageTables } from "../src/model-select/usage-profile"

describe("shared usage/pricing document loader", () => {
  test("coalesces concurrent consumers into one fetch and retains stale data on failure", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    const persisted = new Map<string, string>()
    persisted.set("opencode.go-usage-profile.v1", JSON.stringify({
      fetchedAt: originalNow() + 30 * 24 * 60 * 60 * 1000,
      entries: [{ names: ["invalid"], profile: {} }],
    }))
    // A future-dated or structurally corrupt cache must never suppress a
    // network refresh or masquerade as the authoritative pricing table.
    persisted.set("openfork.go-pricing-table.v1", JSON.stringify({
      fetchedAt: originalNow(),
      entries: [],
    }))
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => persisted.get(key) ?? null,
        setItem: (key: string, value: string) => void persisted.set(key, value),
        removeItem: (key: string) => void persisted.delete(key),
      },
    })
    const markdown = [
      "The estimates are based on observed request patterns:",
      "- Model Alpha — 390 input, 32,500 cached, 120 output tokens per request",
      "The estimates are also based on provider-specific limits.",
      "prices per 1M tokens",
      "| Model | Input | Output | Cache read | Cache write |",
      "| --- | --- | --- | --- | --- |",
      "| Model Alpha | $1.00 | $2.00 | $0.10 | $0.20 |",
    ].join("\n")
    let fetchCount = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    try {
      globalThis.fetch = (async () => {
        fetchCount++
        await gate
        return { ok: true, text: async () => markdown } as Response
      }) as unknown as typeof fetch
      const requests = Promise.all([getUsageTables(), getUsageProfileTable(), getUsagePricingTable()])
      release()
      const [tables, profile, pricing] = await requests
      expect(fetchCount).toBe(1)
      expect(tables.profile).toEqual(profile)
      expect(tables.pricing).toEqual(pricing)
      expect(profile[0]?.profile.cached).toBe(32_500)
      expect(pricing[0]?.pricing.cache.read).toBe(0.1)
      const durablePricing = JSON.parse(persisted.get("openfork.go-pricing-table.v1") ?? "null")
      expect(durablePricing?.entries).toEqual(pricing)
      expect(durablePricing?.fetchedAt).toBeGreaterThan(0)
      expect(await getUsageProfileTable()).toEqual(profile)
      expect(await getUsagePricingTable()).toEqual(pricing)
      expect(fetchCount).toBe(1)

      // One failed refresh remains one shared request, and all callers fall
      // back to the same previously published, non-empty table snapshot.
      Date.now = () => originalNow() + 25 * 60 * 60 * 1000
      globalThis.fetch = (async () => {
        fetchCount++
        throw new Error("synthetic Go documentation outage")
      }) as unknown as typeof fetch
      const [staleProfile, stalePricing] = await Promise.all([getUsageProfileTable(), getUsagePricingTable()])
      expect(fetchCount).toBe(2)
      expect(staleProfile).toEqual(profile)
      expect(stalePricing).toEqual(pricing)
      expect(await getUsageTables()).toEqual({ profile, pricing })
      expect(fetchCount).toBe(2)

      Date.now = () => originalNow() + 25 * 60 * 60 * 1000 + 61_000
      globalThis.fetch = (async () => {
        fetchCount++
        return { ok: true, text: async () => "# Documentation format changed; no usable pricing rows" } as Response
      }) as unknown as typeof fetch
      const formatDrift = await getUsageTables()
      expect(fetchCount).toBe(3)
      expect(formatDrift.profile).toEqual(profile)
      expect(formatDrift.pricing).toEqual(pricing)
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  })
})