import { describe, expect, test } from "bun:test"
import {
  createDisplayModelProjector,
  createModelSearchOrderIndexCache,
  fingerprintModelCatalog,
  indexModelSearchOrder,
  orderModelSearchMatches,
  orderModelSearchMatchesIndexed,
  pricingFallbackForCatalog,
  sortModelsForFirstPaint,
  sortWorkBuddyCreditModels,
} from "./dialog-select-model-sorting"
import { collapseAccountVariants, indexModelGroups } from "./dialog-select-model-accounts"
import { filterPreparedModelGroupsForSearch, prepareModelGroupSearchFields } from "./dialog-select-model-search"
import { sortByCheapness } from "@/utils/model-cost"

const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } }
const paid = { input: 2, output: 8, cache: { read: 0.2, write: 0 } }
const model = (provider: string, id: string, name: string, cost = paid) => ({
  id, name, provider: { id: provider }, cost,
})

describe("selector ordering", () => {
  test("search rank index is created only on demand and invalidates with either ranked rows or group structure", () => {
    const getGroup = (groups: Map<string, string>, item: { id: string }) => groups.get(item.id) ?? item.id
    let calls = 0
    const getRank = createModelSearchOrderIndexCache((groups: Map<string, string>, item: { id: string }) => {
      calls++
      return getGroup(groups, item)
    })
    expect(calls).toBe(0)
    const ranked = [{ id: "a" }, { id: "b" }, { id: "c" }]
    const groups = new Map([["a", "group-a"], ["b", "group-b"]])
    const initial = getRank(ranked, groups)
    expect(calls).toBe(3)
    expect(getRank(ranked, groups)).toBe(initial)
    expect(calls).toBe(3)
    const reorder = getRank([...ranked].reverse(), groups)
    expect(reorder).not.toBe(initial)
    expect(reorder.get("group-a")).toBe(2)
    expect(calls).toBe(6)
    const regroup = getRank(ranked, new Map([["a", "merged"], ["b", "merged"]]))
    expect(regroup).not.toBe(initial)
    expect(regroup.get("merged")).toBe(0)
    expect(calls).toBe(9)
  })

  test("display model projection retains row identity across filtered list changes", () => {
    const project = createDisplayModelProjector<{ id: string; provider: { id: string; name: string } }>()
    const item = { id: "m", provider: { id: "vendor", name: "Vendor" } }
    const first = project(item, "Display")
    expect(project(item, "Display")).toBe(first)
    expect(first.provider.name).toBe("Display")
    expect(item.provider.name).toBe("Vendor")
    const renamed = project(item, "Display Updated")
    expect(renamed).not.toBe(first)
    expect(project({ ...item }, "Display Updated")).not.toBe(renamed)
  })

  test("indexed sparse search matches the linear reference for duplicates, variants, and missing groups", () => {
    const canonical = Array.from({ length: 280 }, (_, i) => ({ id: `m${i}`, group: `g${i}` }))
    const order = [...canonical].reverse()
    const groupOf = (item: (typeof canonical)[number]) => item.group
    const rank = indexModelSearchOrder(order, groupOf)
    let state = 0x7e4de921
    const random = () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return state >>> 0
    }
    for (let cycle = 0; cycle < 100; cycle++) {
      const query = Array.from({ length: cycle * 2 }, (_, j) => {
        const id = random() % 320
        return { id: `match-${cycle}-${j}`, group: `g${id}` }
      })
      expect(orderModelSearchMatchesIndexed(rank, query, groupOf)).toEqual(
        orderModelSearchMatches(order, query, groupOf),
      )
    }
  })
  test("pricing preparations reuse a catalog snapshot and invalidate on structural revision", () => {
    const list = [
      model("vendor", "model", "Atlas", paid),
      model("openrouter", "model:free", "Atlas (Free)", zero),
    ]
    const first = pricingFallbackForCatalog(list, "revision-1")
    expect(first?.get("model:free")?.input).toBe(2)
    expect(pricingFallbackForCatalog(list, "revision-1")).toBe(first)
    list[0] = model("vendor", "model", "Atlas", { ...paid, input: 9 })
    const revised = pricingFallbackForCatalog(list, "revision-2")
    expect(revised).not.toBe(first)
    expect(revised?.get("model:free")?.input).toBe(9)
    expect(pricingFallbackForCatalog([...list], "revision-2")).not.toBe(revised)
    expect(pricingFallbackForCatalog([], "empty")).toBeUndefined()
    list[0] = model("vendor", "model", "Atlas", { ...paid, input: 12 })
    expect(pricingFallbackForCatalog(list)?.get("model:free")?.input).toBe(12)
    list[0] = model("vendor", "model", "Atlas", { ...paid, input: 14 })
    expect(pricingFallbackForCatalog(list)?.get("model:free")?.input).toBe(14)
  })
  test("rank fingerprint invalidates cached order on native tier and 200K repricing", () => {
    const a = {
      ...model("vendor", "tiered", "Tiered"),
      limit: { context: 160_000 },
      cost: {
        ...paid,
        tiers: [{ tier: { type: "context", size: 128_000 }, ...paid }],
        experimentalOver200K: { ...paid, input: 5 },
      },
    }
    const baseline = fingerprintModelCatalog([a])
    expect(fingerprintModelCatalog([a])).toBe(baseline)
    expect(fingerprintModelCatalog([{ ...a, cost: { ...a.cost, tiers: [{ ...a.cost.tiers[0], input: 99 }] } }])).not.toBe(baseline)
    expect(fingerprintModelCatalog([{ ...a, cost: { ...a.cost, tiers: [{ ...a.cost.tiers[0], tier: { type: "context", size: 129_000 } }] } }])).not.toBe(baseline)
    expect(fingerprintModelCatalog([{ ...a, cost: { ...a.cost, experimentalOver200K: { ...paid, input: 6 } } }])).not.toBe(baseline)
    expect(fingerprintModelCatalog([{ ...a, limit: { context: 64_000 } }])).not.toBe(baseline)
    expect(fingerprintModelCatalog([{ ...a, name: "Renamed Tiered" }])).not.toBe(baseline)
    expect(fingerprintModelCatalog([])).toBe("")
  })
  test("OpenRouter free and zero-price stealth rows precede paid rows before enrichment", () => {
    const items = [
      model("openrouter", "openrouter/auto", "A Meta-Router", zero),
      model("openrouter", "openai/gpt-4o", "B Paid"),
      model("openrouter", "stealth/preview", "C Free Preview", zero),
      model("openrouter", "openrouter/free", "D Free Router", zero),
      model("openrouter", "other/model:free", "E Free Tier", zero),
      model("openrouter", "stealth/paid-preview", "F Paid Preview", paid),
    ]
    const names = sortModelsForFirstPaint(items).map((item) => item.name)
    expect(names.slice(0, 3)).toEqual(["C Free Preview", "D Free Router", "E Free Tier"])
    expect(names.slice(3)).toEqual(["A Meta-Router", "B Paid", "F Paid Preview"])
  })

  test("Zen/Go zero-rate models are free, but unknown provider zero rates are unpriced", () => {
    const ordered = sortModelsForFirstPaint([
      model("vendor", "unknown-zero", "A Unknown", zero),
      model("opencode-go", "free-go", "Z Go Free", zero),
      model("opencode", "free-zen", "B Zen Free", zero),
      model("vendor", "paid", "C Paid"),
    ])
    expect(ordered.map((item) => item.id)).toEqual(["free-zen", "free-go", "unknown-zero", "paid"])
  })

  test("search follows ranked canonical groups without losing matched account variants", () => {
    const paid = { id: "a", group: "a" }
    const free = { id: "b", group: "b" }
    const matchingAccount1 = { id: "b@account1", group: "b" }
    const matchingAccount2 = { id: "b@account2", group: "b" }
    const ordered = orderModelSearchMatches(
      [free, paid],
      [paid, matchingAccount1, matchingAccount2],
      (item) => item.group,
    )
    expect(ordered).toEqual([matchingAccount1, matchingAccount2, paid])
  })

  test("unmatched canonical indexes do not discard query matches", () => {
    const a = { id: "a" }, b = { id: "b" }, unknown = { id: "new" }
    expect(orderModelSearchMatches([b, a], [unknown, a], (item) => item.id)).toEqual([a, unknown])
  })

  test("provider search retains free-first ranking across cold and enriched lists", () => {
    const raw = [
      model("openrouter", "openrouter/auto", "A Meta Router", zero),
      model("openrouter", "anthropic/sonnet", "B Paid Premium"),
      model("openrouter", "zen/example:free", "Z Free"),
      model("openrouter", "stealth/preview", "Y Preview", zero),
    ].map((item) => ({ ...item, provider: { ...item.provider, name: "OpenRouter" } }))
    const groups = collapseAccountVariants(raw)
    const groupIndex = indexModelGroups(groups)
    const matches = filterPreparedModelGroupsForSearch(groups, "openrouter", prepareModelGroupSearchFields(groups))
    const getGroup = (item: (typeof raw)[number]) =>
      groupIndex.get(`${item.provider.id}:${item.id}`)?.key ?? `${item.provider.id}:${item.id}`
    const firstPaint = orderModelSearchMatches(sortModelsForFirstPaint(groups.map((g) => g.canonical)), matches, getGroup)
    const enriched = orderModelSearchMatches(sortByCheapness(groups.map((g) => g.canonical) as never) as typeof raw, matches, getGroup)
    for (const list of [firstPaint, enriched]) {
      expect(list.slice(0, 2).map((item) => item.id).sort()).toEqual(["stealth/preview", "zen/example:free"])
      expect(list.slice(2).map((item) => item.id).sort()).toEqual(["anthropic/sonnet", "openrouter/auto"])
    }
  })

  test("WorkBuddy sorts promoted free models then real credits per request, never zero-priced unknowns", () => {
    const items = [{ id: "unknown" }, { id: "costly" }, { id: "free" }, { id: "cheap" }, { id: "second-free" }]
    const prices = new Map([
      ["free", { free: true, rate: 0 }],
      ["second-free", { free: true, rate: 0 }],
      ["cheap", { free: false, rate: 0.25 }],
      ["costly", { free: false, rate: 3 }],
    ])
    const sorted = sortWorkBuddyCreditModels(items, prices)
    expect(sorted.map((item) => item.id)).toEqual(["free", "second-free", "cheap", "costly", "unknown"])
    // The provider may temporarily return incomplete rate data during refresh.
    // Unknown is NOT inferred free from missing cost.
    expect(sortWorkBuddyCreditModels(items, new Map()).map((item) => item.id)).toEqual(items.map((item) => item.id))
  })
})
