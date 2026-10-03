import { describe, expect, test } from "bun:test"
import {
  indexProviderCapacity,
  normalizeCapacityWindow,
  normalizeCapacityWindows,
  normalizeGoCapacityWindows,
  normalizeProviderCapacityWindows,
  goCapacityView,
  selectGeneralUsage,
} from "./fork-usage"
import type {
  ForkCapacityEstimate,
  ForkGeneralUsageModel,
  ForkGeneralUsageSnapshot,
  ForkGeneralUsageWorkload,
  ForkProviderCapacity,
  ForkProviderCapacityEstimate,
  ForkProviderCapacityWindow,
} from "@/utils/fork-client"

const workload = (over: Partial<ForkGeneralUsageWorkload> = {}): ForkGeneralUsageWorkload => ({
  inputTokens: 1_000,
  cacheReadTokens: 40_000,
  cacheWriteTokens: 0,
  outputTokens: 300,
  reasoningTokens: 0,
  contextTokens: 41_000,
  generationTokens: 300,
  totalTokens: 41_300,
  ...over,
})

const evidence = { observations: 20, requestEffectiveSamples: 6.5, sessionEffectiveSamples: 4.2 }

const snapshot = (over: Partial<ForkGeneralUsageSnapshot> = {}): ForkGeneralUsageSnapshot => ({
  source: "personal-general",
  fingerprint: "general-v1:deadbeef",
  fallback: workload({ contextTokens: 32_890, totalTokens: 32_890 + 120 }),
  typical: workload(),
  corpus: [workload()],
  evidence,
  observedModelScopes: 3,
  models: [],
  ...over,
})

const index = (models: ForkGeneralUsageModel[]) => new Map(models.map((m) => [`${m.providerID}:${m.modelID}`, m]))

describe("selectGeneralUsage", () => {
  test("returns undefined when the server has no general usage projection", () => {
    expect(selectGeneralUsage(undefined, new Map(), "openrouter", "m")).toBeUndefined()
  })

  test("a direct personal model scope outranks the personal-general prior", () => {
    const direct: ForkGeneralUsageModel = {
      providerID: "openrouter",
      modelID: "m",
      source: "personal-model",
      personalized: true,
      workload: workload({ contextTokens: 128_000, totalTokens: 128_300 }),
      evidence: { observations: 9, requestEffectiveSamples: 5, sessionEffectiveSamples: 3 },
    }
    const view = selectGeneralUsage(snapshot(), index([direct]), "openrouter", "m")!
    expect(view.source).toBe("personal-model")
    expect(view.personalized).toBe(true)
    expect(view.workload.contextTokens).toBe(128_000)
    expect(view.evidence?.observations).toBe(9)
  })

  test("a mature personal-general profile uses the user's own typical workload", () => {
    const view = selectGeneralUsage(snapshot(), new Map(), "anthropic", "unseen")!
    expect(view.source).toBe("personal-general")
    expect(view.personalized).toBe(true)
    // `typical`, never the standardized `fallback` corpus median.
    expect(view.workload.contextTokens).toBe(41_000)
    expect(view.workload.contextTokens).not.toBe(snapshot().fallback.contextTokens)
  })

  test("an immature profile falls back to the standardized corpus median", () => {
    const view = selectGeneralUsage(snapshot({ source: "standardized-workload-prior" }), new Map(), "anthropic", "unseen")!
    expect(view.source).toBe("standardized-workload-prior")
    expect(view.personalized).toBe(false)
    expect(view.workload).toEqual(snapshot().fallback)
  })

  test("direct scope still wins when the general profile is only a prior", () => {
    const direct: ForkGeneralUsageModel = {
      providerID: "anthropic",
      modelID: "seen",
      source: "personal-model",
      personalized: true,
      workload: workload({ contextTokens: 7_000, totalTokens: 7_300 }),
      evidence: { observations: 4, requestEffectiveSamples: 3, sessionEffectiveSamples: 2 },
    }
    const view = selectGeneralUsage(snapshot({ source: "standardized-workload-prior" }), index([direct]), "anthropic", "seen")!
    expect(view.source).toBe("personal-model")
    expect(view.workload.contextTokens).toBe(7_000)
  })

  test("scopes are provider-scoped: the same model id on another provider does not inherit", () => {
    const direct: ForkGeneralUsageModel = {
      providerID: "openrouter",
      modelID: "m",
      source: "personal-model",
      personalized: true,
      workload: workload({ contextTokens: 128_000, totalTokens: 128_300 }),
      evidence: { observations: 9, requestEffectiveSamples: 5, sessionEffectiveSamples: 3 },
    }
    const view = selectGeneralUsage(snapshot(), index([direct]), "anthropic", "m")!
    expect(view.source).toBe("personal-general")
    expect(view.workload.contextTokens).toBe(41_000)
  })

  test("never exposes a requests-left field without a quota denominator", () => {
    const view = selectGeneralUsage(snapshot(), new Map(), "anthropic", "unseen")!
    expect(Object.keys(view)).not.toContain("estimatedRequests")
    expect(Object.keys(view)).not.toContain("remaining")
    expect(Object.keys(view)).not.toContain("requestsLeft")
  })

  test("carries the descriptive bands only when the server reported them", () => {
    const withoutBands = selectGeneralUsage(snapshot(), new Map(), "anthropic", "unseen")!
    expect(withoutBands.observedRequestBand).toBeUndefined()
    expect(withoutBands.observedScopeBand).toBeUndefined()

    const requestBand = {
      requests: 24,
      lowerContextTokens: 12_000,
      upperContextTokens: 90_000,
      lowerGenerationTokens: 100,
      upperGenerationTokens: 900,
    }
    const scopeBand = {
      scopeCount: 3,
      lowerContextTokens: 4_000,
      upperContextTokens: 180_000,
      lowerGenerationTokens: 50,
      upperGenerationTokens: 2_000,
    }
    const withBands = selectGeneralUsage(
      snapshot({ observedRequestBand: requestBand, observedScopeBand: scopeBand }),
      new Map(),
      "anthropic",
      "unseen",
    )!
    expect(withBands.observedRequestBand).toEqual(requestBand)
    expect(withBands.observedScopeBand).toEqual(scopeBand)
  })
})

const providerEvidence = { observations: 12, requestEffectiveSamples: 5, sessionEffectiveSamples: 3 }

const providerEstimate = (
  providerID: string,
  over: Partial<ForkProviderCapacityEstimate> = {},
): ForkProviderCapacityEstimate => ({
  providerID,
  status: "ready",
  source: "direct-request-budget",
  estimatedRequests: 100,
  remainingPercent: 50,
  resetAt: null,
  personalized: false,
  evidence: providerEvidence,
  ...over,
})

const provider = (over: Partial<ForkProviderCapacity> = {}): ForkProviderCapacity => ({
  quotaProviderID: "quota-a",
  providerName: "A",
  modelProviderIDs: [],
  status: "ok",
  defaultEstimates: [],
  estimates: [],
  accounts: [],
  ...over,
})

describe("indexProviderCapacity", () => {
  test("an absent provider projection indexes to an empty lookup", () => {
    expect(indexProviderCapacity(undefined).size).toBe(0)
    expect(indexProviderCapacity([]).size).toBe(0)
  })

  test("an exact quotaProviderID wins over another provider's alias in either array order", () => {
    const aliased = provider({
      quotaProviderID: "openai-ish",
      providerName: "OpenAI",
      modelProviderIDs: ["anthropic"],
      status: "error",
    })
    const exact = provider({
      quotaProviderID: "anthropic",
      providerName: "Anthropic",
      modelProviderIDs: ["claude-alias"],
      estimates: [providerEstimate("anthropic", { modelID: "claude-sonnet-4" })],
    })

    // Aliased provider is indexed first and parks on "anthropic"; the later
    // exact claim must replace it.
    const aliasFirst = indexProviderCapacity([aliased, exact])
    expect(aliasFirst.get("anthropic")!.status).toBe("ok")
    expect(aliasFirst.get("anthropic")!.estimates.get("claude-sonnet-4")?.providerID).toBe("anthropic")

    // Exact provider first: the alias must not steal the claimed key.
    const exactFirst = indexProviderCapacity([exact, aliased])
    expect(exactFirst.get("anthropic")!.status).toBe("ok")
    expect(exactFirst.get("anthropic")!.estimates.get("claude-sonnet-4")?.providerID).toBe("anthropic")

    // Both orders agree on the resolved owner of every key.
    expect(aliasFirst.get("anthropic")).toEqual(exactFirst.get("anthropic"))
    expect([...exactFirst.keys()].sort()).toEqual([...aliasFirst.keys()].sort())
  })

  test("aliases only fill keys that are still unclaimed", () => {
    const first = provider({ quotaProviderID: "quota-a", modelProviderIDs: ["shared", "only-a"] })
    const second = provider({ quotaProviderID: "quota-b", modelProviderIDs: ["shared", "only-b"] })

    const map = indexProviderCapacity([first, second])
    // "shared" was already claimed by the first provider's alias, so the second
    // provider's alias cannot take it.
    expect(map.get("shared")).toBe(map.get("quota-a"))
    expect(map.get("quota-b")).not.toBe(map.get("quota-a"))
    expect(map.get("only-a")).toBe(map.get("quota-a"))
    expect(map.get("only-b")).toBe(map.get("quota-b"))
  })

  test("aliases share one indexed provider object so row lookups stay O(1)", () => {
    const only = provider({
      quotaProviderID: "opencode",
      modelProviderIDs: ["opencode-zen", "opencode-go"],
      estimates: [providerEstimate("opencode", { modelID: "gpt-5" })],
      defaultEstimates: [providerEstimate("opencode"), providerEstimate("opencode", { modelID: "gpt-5" })],
      accounts: [
        {
          accountID: "acct-1",
          defaultEstimate: providerEstimate("opencode", { accountID: "acct-1" }),
          estimates: [providerEstimate("opencode", { accountID: "acct-1", modelID: "gpt-5" })],
        },
      ],
    })

    const map = indexProviderCapacity([only])
    const shared = map.get("opencode")
    expect(shared).toBeDefined()
    expect(map.get("opencode-zen")).toBe(shared)
    expect(map.get("opencode-go")).toBe(shared)
    // A repeated lookup is the identical object: no per-row allocation.
    expect(map.get("opencode")).toBe(shared)

    expect(shared!.status).toBe("ok")
    expect(shared!.estimates.get("gpt-5")?.providerID).toBe("opencode")
    expect(shared!.defaultEstimates.get("gpt-5")?.providerID).toBe("opencode")
    expect(shared!.defaultEstimate?.providerID).toBe("opencode")
    expect(shared!.accounts.get("acct-1")?.estimates.get("gpt-5")?.accountID).toBe("acct-1")
    expect(shared!.accounts.get("acct-1")?.defaultEstimate?.accountID).toBe("acct-1")
  })

  test("an unscoped default estimate does not occupy a model id key", () => {
    const only = provider({
      quotaProviderID: "quota-a",
      defaultEstimates: [providerEstimate("quota-a"), providerEstimate("quota-a", { modelID: "pinned" })],
    })
    const map = indexProviderCapacity([only])
    expect(map.get("quota-a")!.defaultEstimates.size).toBe(1)
    expect(map.get("quota-a")!.defaultEstimate?.modelID).toBeUndefined()
    expect(map.get("quota-a")!.defaultEstimates.get("pinned")).toBeDefined()
  })

  test("an unscoped model estimate is not indexed under an empty key", () => {
    const only = provider({ quotaProviderID: "quota-a", estimates: [providerEstimate("quota-a")] })
    expect(indexProviderCapacity([only]).get("quota-a")!.estimates.size).toBe(0)
  })
})
describe("capacity window normalization", () => {
  const providerWindow = (over: Partial<ForkProviderCapacityWindow> = {}): ForkProviderCapacityWindow => ({
    id: "5h",
    label: "5h",
    basis: "observed-remaining",
    status: "ready",
    source: "published-model-capacity",
    personalized: false,
    estimatedRequests: 412,
    remainingPercent: 42,
    resetAt: 1_700_000_000_000,
    ...over,
  })

  describe("normalizeCapacityWindow", () => {
    test("an observed-remaining row is a remainder, never a window total", () => {
      expect(normalizeCapacityWindow(providerWindow())).toEqual({
        id: "5h",
        label: "5h",
        remaining: { remainingRequests: 412, remainingPercent: 42, resetAt: 1_700_000_000_000, status: "ready" },
      })
      expect(normalizeCapacityWindow(providerWindow())!.pointRequests).toBeUndefined()
    })

    test("a personalized-total-capacity row is a total and carries no remainder", () => {
      const normalized = normalizeCapacityWindow(
        providerWindow({ basis: "personalized-total-capacity", estimatedRequests: 5_100, remainingPercent: null }),
      )!
      expect(normalized.pointRequests).toBe(5_100)
      expect(normalized.remaining).toBeUndefined()
    })

    test("a null remainder fails closed rather than reading as zero", () => {
      const normalized = normalizeCapacityWindow(providerWindow({ estimatedRequests: null, remainingPercent: 0 }))!
      expect(normalized.remaining).toEqual({ remainingPercent: 0, resetAt: 1_700_000_000_000, status: "ready" })
      expect(normalized.remaining?.remainingRequests).toBeUndefined()
    })

    test("an unavailable status is carried through instead of a number", () => {
      const normalized = normalizeCapacityWindow(providerWindow({ status: "unavailable" }))!
      expect(normalized.remaining?.status).toBe("unavailable")
    })

    test("falls back to the id when no label was published", () => {
      expect(normalizeCapacityWindow(providerWindow({ label: "  " }))!.label).toBe("5h")
    })

    test("drops a row that carries no usable fact at all", () => {
      expect(
        normalizeCapacityWindow(providerWindow({ estimatedRequests: null, remainingPercent: null })),
      ).toBeUndefined()
    })
  })

  describe("normalizeProviderCapacityWindows", () => {
    test("keeps a 5h and a week row distinct", () => {
      const normalized = normalizeProviderCapacityWindows([
        providerWindow({ id: "week", label: "1w", estimatedRequests: 2_400 }),
        providerWindow({ id: "5h" }),
      ])
      expect(normalized.map((window) => window.id)).toEqual(["week", "5h"])
      expect(normalized[0]!.remaining?.remainingRequests).toBe(2_400)
    })

    test("tolerates an absent list", () => {
      expect(normalizeProviderCapacityWindows(undefined)).toEqual([])
    })
  })

  describe("normalizeGoCapacityWindows", () => {
    test("keeps a published total and its observed remainder side by side", () => {
      const normalized = normalizeGoCapacityWindows([
        { window: "5h", baselineRequests: 20_000, pointRequests: 20_000, remaining: { remainingPercent: 42, remainingRequests: 412, status: "ready" } },
        { window: "week", baselineRequests: 74_000, pointRequests: 74_000 },
      ])
      expect(normalized[0]).toEqual({
        id: "5h",
        label: "5h",
        pointRequests: 20_000,
        remaining: { remainingRequests: 412, remainingPercent: 42, status: "ready" },
      })
      expect(normalized[1]).toEqual({ id: "week", label: "week", pointRequests: 74_000 })
    })

    test("a null remainder is dropped while the percent survives", () => {
      const normalized = normalizeGoCapacityWindows([
        { window: "5h", baselineRequests: 20_000, pointRequests: 20_000, remaining: { remainingPercent: 0, remainingRequests: null, status: "unavailable" } },
      ])
      expect(normalized[0]!.remaining).toEqual({ remainingPercent: 0, status: "unavailable" })
    })

    test("a window with neither a usable total nor an observation is dropped", () => {
      expect(
        normalizeGoCapacityWindows([{ window: "5h", baselineRequests: 0, pointRequests: 0 }]),
      ).toEqual([])
    })
  })

  describe("normalizeCapacityWindows", () => {
    test("merges duplicate ids, keeping whichever side knows more", () => {
      const merged = normalizeCapacityWindows([
        normalizeGoCapacityWindows([{ window: "5h", baselineRequests: 20_000, pointRequests: 20_000 }]),
        normalizeProviderCapacityWindows([providerWindow({ id: "5h" })]),
      ])
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({
        id: "5h",
        pointRequests: 20_000,
        remaining: { remainingRequests: 412, remainingPercent: 42 },
      })
    })

    test("a later total fills in a gap without erasing an observed remainder", () => {
      const merged = normalizeCapacityWindows([
        normalizeProviderCapacityWindows([providerWindow({ id: "5h" })]),
        [{ id: "5h", label: "5h", pointRequests: 20_000 }],
      ])
      expect(merged[0]!.pointRequests).toBe(20_000)
      expect(merged[0]!.remaining?.remainingRequests).toBe(412)
    })

    test("never invents a total from a remainder-only merge", () => {
      const merged = normalizeCapacityWindows([
        normalizeProviderCapacityWindows([providerWindow({ id: "5h" })]),
        normalizeProviderCapacityWindows([providerWindow({ id: "5h" })]),
      ])
      expect(merged[0]!.pointRequests).toBeUndefined()
    })

    test("tolerates missing sources", () => {
      expect(normalizeCapacityWindows(undefined)).toEqual([])
      expect(normalizeCapacityWindows([undefined, null])).toEqual([])
    })
  })
})
describe("goCapacityView", () => {
  const goEstimate = (over: Partial<ForkCapacityEstimate> = {}): ForkCapacityEstimate => ({
    modelID: "hy4-preview",
    accountID: "zen-abc",
    baselineRequests: 20_000,
    estimatedRequests: 412,
    remainingFraction: 0.42,
    remainingPercent: 42,
    workloadMultiplier: 1.1,
    personalized: true,
    resetAt: 1_700_000_000_000,
    quotaStatus: "ok",
    projectionStatus: "ok",
    predictiveRange: {
      status: "calibrated",
      effectiveSamples: 24,
      matureAt: 1_700_000_000_000,
      targetCoverage: 0.8,
      heldOutCoverage: 0.76,
      calibrationBudget: 20,
      lowerRequests: 300,
      upperRequests: 600,
    },
    windowCapacity: [
      { window: "5h", baselineRequests: 20_000, pointRequests: 20_000 },
      { window: "week", baselineRequests: 74_000, pointRequests: 74_000 },
    ],
    evidence: { observations: 30, requestEffectiveSamples: 9, sessionEffectiveSamples: 6, personalWeight: 0.8 },
    ...over,
  })

  test("a healthy estimate exposes its windows, remaining count, and range", () => {
    const view = goCapacityView(goEstimate())
    expect(view.status).toBe("ready")
    expect(view.estimatedRequests).toBe(412)
    expect(view.remainingPercent).toBe(42)
    expect(view.capacityWindows?.map((window) => window.id)).toEqual(["5h", "week"])
    expect(view.capacityWindows?.map((window) => window.pointRequests)).toEqual([20_000, 74_000])
    expect(view.accountID).toBe("zen-abc")
  })

  test("an older server with no window list still yields the single 5h estimate", () => {
    const view = goCapacityView(goEstimate({ windowCapacity: undefined }))
    expect(view.capacityWindows).toBeUndefined()
    expect(view.estimatedRequests).toBe(412)
  })

  test("incomplete local accounting keeps the 5h and week TOTALS", () => {
    const view = goCapacityView(goEstimate({ projectionStatus: "incomplete-local-accounting" }))
    expect(view.capacityWindows?.map((window) => [window.id, window.pointRequests])).toEqual([
      ["5h", 20_000],
      ["week", 74_000],
    ])
  })

  test("incomplete local accounting fabricates no remaining request count", () => {
    const view = goCapacityView(goEstimate({ projectionStatus: "incomplete-local-accounting" }))
    expect(view.estimatedRequests).toBeUndefined()
    // A window that published an observed remainder keeps it; none was fabricated
    // for the windows that did not.
    expect(view.capacityWindows?.every((window) => window.remaining === undefined)).toBe(true)
  })

  test("incomplete local accounting keeps the real percentage, reason, and identity", () => {
    const view = goCapacityView(goEstimate({ projectionStatus: "incomplete-local-accounting" }))
    expect(view.status).toBe("unavailable")
    expect(view.remainingPercent).toBe(42)
    expect(view.personalized).toBe(true)
    expect(view.accountID).toBe("zen-abc")
    expect(view.reason).toContain("could not be normalized")
  })

  test("an observed window remainder survives incomplete accounting", () => {
    const view = goCapacityView(
      goEstimate({
        projectionStatus: "incomplete-local-accounting",
        windowCapacity: [
          {
            window: "5h",
            baselineRequests: 20_000,
            pointRequests: 20_000,
            remaining: { remainingPercent: 42, remainingRequests: null, status: "unavailable" },
          },
        ],
      }),
    )
    expect(view.capacityWindows?.[0]?.pointRequests).toBe(20_000)
    expect(view.capacityWindows?.[0]?.remaining?.remainingRequests).toBeUndefined()
    expect(view.capacityWindows?.[0]?.remaining?.status).toBe("unavailable")
  })
})