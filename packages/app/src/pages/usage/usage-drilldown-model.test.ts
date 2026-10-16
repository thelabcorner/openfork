import { describe, expect, test } from "bun:test"
import {
  globalUsageDrilldown, matchesUsageWorkload, reconcileUsageDrilldown, usageModelScope, usageProviderScope,
  usageScopeCrumbs, usageScopeTitle, usageWorkloadParams,
} from "./usage-drilldown-model"

describe("usage profiler drilldown", () => {
  const providers = ["a", "b"]
  const models = [{ providerID: "a", modelID: "shared" }, { providerID: "b", modelID: "shared" }, { providerID: "a", modelID: "other" }]

  test("global → provider → model is reversible with stable parent scopes", () => {
    const model = usageModelScope("a", "shared")
    const crumbs = usageScopeCrumbs(model)
    expect(crumbs.map((row) => row.label)).toEqual(["All providers", "a", "shared"])
    expect(crumbs.map((row) => row.target)).toEqual([globalUsageDrilldown, usageProviderScope("a"), model])
    expect(usageScopeTitle(model)).toBe("shared")
  })

  test("changing provider clears stale model and never conflates identical model IDs across providers", () => {
    expect(usageProviderScope("b")).toEqual({ level: "provider", providerID: "b", modelID: null })
    expect(reconcileUsageDrilldown(usageModelScope("a", "shared"), providers, [{ providerID: "b", modelID: "shared" }]))
      .toEqual(usageProviderScope("a"))
    expect(reconcileUsageDrilldown(usageModelScope("b", "shared"), providers, models))
      .toEqual(usageModelScope("b", "shared"))
  })

  test("stale scopes reconcile without displaying empty measurements as actual zero", () => {
    expect(reconcileUsageDrilldown(usageProviderScope("deleted"), providers, models)).toEqual(globalUsageDrilldown)
    expect(reconcileUsageDrilldown(usageModelScope("a", "missing"), providers, models)).toEqual(usageProviderScope("a"))
    expect(usageModelScope("", "unbound")).toEqual(globalUsageDrilldown)
  })

  test("one producer-scoped query preserves project/time/provider/model constraints", () => {
    expect(usageWorkloadParams(globalUsageDrilldown, 100, 200, "p")).toEqual({
      since: "100", until: "200", projectID: "p", limit: 40,
    })
    expect(usageWorkloadParams(usageProviderScope("A"), 100, 200, null)).toEqual({
      since: "100", until: "200", providerID: "A", limit: 40,
    })
    expect(usageWorkloadParams(usageModelScope("B", "shared"), 100, 200, "work", 10)).toEqual({
      since: "100", until: "200", projectID: "work", providerID: "B", modelID: "shared", limit: 10,
    })
  })

  test("stale fetch data is hidden during provider, model, project and time navigation", () => {
    const model = usageModelScope("A", "M")
    const snapshot = { providerID: "A", modelID: "M", projectID: "p", since: 10, until: 20 }
    expect(matchesUsageWorkload(model, { since: 10, until: 20 }, "p", snapshot)).toBe(true)
    expect(matchesUsageWorkload(usageProviderScope("A"), { since: 10, until: 20 }, "p", snapshot)).toBe(false)
    expect(matchesUsageWorkload(usageModelScope("B", "M"), { since: 10, until: 20 }, "p", snapshot)).toBe(false)
    expect(matchesUsageWorkload(model, { since: 10, until: 20 }, null, snapshot)).toBe(false)
    expect(matchesUsageWorkload(model, { since: 11, until: 20 }, "p", snapshot)).toBe(false)
    expect(matchesUsageWorkload(model, { since: 10, until: 20 }, "p", undefined)).toBe(false)
  })
})
