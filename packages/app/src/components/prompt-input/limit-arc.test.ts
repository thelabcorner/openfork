import { describe, expect, test } from "bun:test"
import type { LimitProvider } from "@/hooks/use-limits"
import type { ForkWindowUsage } from "@/utils/fork-client"
import {
  resolveTierGate,
  sortWindows,
  toneForRemaining,
  type ProviderResult,
  type UsageWindow,
  type WorkBuddyModelLimit,
} from "@/utils/limits-format"
import {
  arcSectors,
  buildArcModel,
  capSegments,
  MAX_ARC_SEGMENTS,
  resolveQuotaProviderID,
  segmentsFromFork,
  segmentsFromWindows,
  windowMatchesModel,
  worstOf,
  type ArcSegment,
} from "./limit-arc"

const window = (args: Partial<UsageWindow> = {}): UsageWindow => ({
  usedPercent: args.usedPercent ?? null,
  remainingPercent: args.remainingPercent ?? null,
  windowSeconds: args.windowSeconds ?? null,
  resetAt: args.resetAt ?? null,
  resetAfterSeconds: args.resetAfterSeconds ?? null,
  valueLabel: args.valueLabel ?? null,
})

const provider = (result: Partial<ProviderResult> & { providerId: string }): LimitProvider => {
  const full: ProviderResult = {
    providerId: result.providerId,
    providerName: result.providerName ?? result.providerId,
    ok: result.ok ?? true,
    configured: result.configured ?? true,
    error: result.error,
    planLabel: result.planLabel,
    usage: result.usage ?? null,
    fetchedAt: result.fetchedAt ?? 0,
  }
  const windowsSorted = full.usage ? sortWindows(Object.entries(full.usage.windows)) : []
  const gate = resolveTierGate(windowsSorted)
  return {
    result: full,
    windowsSorted,
    worstRemaining: gate.effectiveRemaining,
    tone: toneForRemaining(gate.effectiveRemaining),
    gate,
  }
}

const forkWindow = (label: ForkWindowUsage["label"], spent: number, limit: number): ForkWindowUsage => ({
  label,
  spentUSD: spent,
  limitUSD: limit,
  resetsAt: 1_000,
  callsInWindow: 0,
})

const segment = (args: Partial<ArcSegment> & { id: string }): ArcSegment => ({
  id: args.id,
  windowKey: args.windowKey ?? args.id,
  literal: args.literal ?? null,
  remaining: args.remaining ?? null,
  resetAt: args.resetAt ?? null,
  resetAfterSeconds: args.resetAfterSeconds ?? null,
  valueLabel: args.valueLabel ?? null,
  kind: args.kind ?? "window",
  binding: args.binding ?? false,
})

const workbuddyModel = (args: Partial<WorkBuddyModelLimit> & { model: string }): WorkBuddyModelLimit => ({
  model: args.model,
  canonical: args.canonical ?? null,
  unit: args.unit ?? "requests",
  usedObserved: args.usedObserved ?? 0,
  limitEstimate: args.limitEstimate ?? null,
  remainingEstimate: args.remainingEstimate ?? null,
  remainingPercent: args.remainingPercent ?? null,
  status: args.status ?? "healthy",
  confidence: args.confidence ?? "medium",
  accuracy: args.accuracy ?? "estimate",
  exhaustedObserved: args.exhaustedObserved ?? false,
  serverCode: args.serverCode ?? null,
  resetAt: args.resetAt ?? null,
  resetSource: args.resetSource ?? "unknown",
  windowType: args.windowType ?? "unknown",
  windowStartedAt: args.windowStartedAt ?? null,
  secondsUntilReset: args.secondsUntilReset ?? null,
  lastObservationAt: args.lastObservationAt ?? null,
  burnPerHour: args.burnPerHour ?? null,
  estimatedExhaustionAt: args.estimatedExhaustionAt ?? null,
  willLikelyExhaustBeforeReset: args.willLikelyExhaustBeforeReset ?? null,
  creditsObserved: args.creditsObserved ?? 0,
  tokensInput: args.tokensInput ?? 0,
  tokensOutput: args.tokensOutput ?? 0,
  tokensCacheHit: args.tokensCacheHit ?? 0,
  tokensCacheMiss: args.tokensCacheMiss ?? 0,
  creditsPersonalized: args.creditsPersonalized ?? false,
  coverage: "opencode-only",
})

describe("resolveQuotaProviderID", () => {
  test("maps a model provider onto its quota adapter through the alias table", () => {
    expect(resolveQuotaProviderID("anthropic", new Set())).toBe("claude")
    expect(resolveQuotaProviderID("codebuddy", new Set())).toBe("workbuddy")
    expect(resolveQuotaProviderID("moonshotai", new Set())).toBe("kimi-for-coding")
  })

  test("keeps Zen and Go apart even though the server folds `opencode` into Go", () => {
    expect(resolveQuotaProviderID("opencode", new Set())).toBe("opencode-zen")
    expect(resolveQuotaProviderID("opencode-go", new Set())).toBe("opencode-go")
  })

  test("an id the server actually returned wins over the alias table", () => {
    expect(resolveQuotaProviderID("anthropic", new Set(["anthropic"]))).toBe("anthropic")
  })

  test("normalizes case and separators before matching", () => {
    expect(resolveQuotaProviderID("Claude_Code", new Set())).toBe("claude")
  })

  test("returns null for a provider with no quota adapter at all", () => {
    expect(resolveQuotaProviderID("some-local-llm", new Set())).toBeNull()
    expect(resolveQuotaProviderID(undefined, new Set())).toBeNull()
  })
})

describe("windowMatchesModel", () => {
  test("matches the provider's spelling against the catalog id or display name", () => {
    expect(windowMatchesModel("claude-opus-4-1", "claude-opus-4-1-20250805")).toBe(true)
    expect(windowMatchesModel("claude-opus-4-1", undefined, "Claude Opus 4.1")).toBe(true)
  })

  test("does not match a different model in the same family", () => {
    expect(windowMatchesModel("claude-opus-4-1", "claude-sonnet-4-5")).toBe(false)
  })

  test("ignores fragments too short to be discriminating", () => {
    expect(windowMatchesModel("o1", "claude-opus-4-1")).toBe(false)
  })
})

describe("segmentsFromWindows", () => {
  test("drops model-scoped windows that belong to a different model", () => {
    const segments = segmentsFromWindows(
      [
        ["5h", window({ usedPercent: 40, windowSeconds: 18_000 })],
        ["weekly:claude-opus-4-1", window({ usedPercent: 90 })],
      ],
      { modelID: "claude-sonnet-4-5" },
    )
    expect(segments.map((s) => s.id)).toEqual(["5h"])
  })

  test("puts the selected model's own window first — it answers the composer's question", () => {
    const segments = segmentsFromWindows(
      [
        ["5h", window({ usedPercent: 40, windowSeconds: 18_000 })],
        ["weekly", window({ usedPercent: 20, windowSeconds: 604_800 })],
        ["weekly:claude-opus-4-1", window({ usedPercent: 90 })],
      ],
      { modelID: "claude-opus-4-1" },
    )
    expect(segments.map((s) => s.id)).toEqual(["weekly:claude-opus-4-1", "5h", "weekly"])
    expect(segments[0].kind).toBe("model")
    expect(segments[0].remaining).toBe(10)
  })

  test("reads remaining from usedPercent when the provider only publishes usage", () => {
    const segments = segmentsFromWindows([["5h", window({ usedPercent: 73 })]])
    expect(segments[0].remaining).toBe(27)
  })
})

describe("capSegments", () => {
  test("never drops the window that gates the provider", () => {
    const segments = [
      segment({ id: "a", remaining: 90 }),
      segment({ id: "b", remaining: 80 }),
      segment({ id: "c", remaining: 70 }),
      segment({ id: "gate", remaining: 2 }),
    ]
    const kept = capSegments(segments, "gate")
    expect(kept).toHaveLength(MAX_ARC_SEGMENTS)
    expect(kept.map((s) => s.id)).toEqual(["a", "b", "gate"])
  })

  test("leaves a list that already fits untouched", () => {
    const segments = [segment({ id: "a" }), segment({ id: "b" })]
    expect(capSegments(segments, null)).toEqual(segments)
  })
})

describe("segmentsFromFork", () => {
  test("orders the three Go budgets shortest-cadence first and skips missing ones", () => {
    const segments = segmentsFromFork([forkWindow("month", 5, 20), forkWindow("5h", 1, 4)])
    expect(segments.map((s) => s.id)).toEqual(["5h", "month"])
    expect(segments[0].remaining).toBe(75)
    expect(segments[0].valueLabel).toBe("$1.00 / $4.00")
  })

  test("a budget with no limit reports unknown rather than full", () => {
    const segments = segmentsFromFork([forkWindow("5h", 0, 0)])
    expect(segments[0].remaining).toBeNull()
  })
})

describe("worstOf", () => {
  test("ignores unknown segments instead of treating them as empty", () => {
    expect(worstOf([segment({ id: "a", remaining: 40 }), segment({ id: "b", remaining: null })])).toBe(40)
  })

  test("is null when nothing is known", () => {
    expect(worstOf([segment({ id: "a", remaining: null })])).toBeNull()
  })
})

describe("arcSectors", () => {
  test("a solo ring is one near-closed gauge, not a third of a tripartite", () => {
    const [only] = arcSectors(1)
    expect(only.end - only.start).toBeCloseTo(344)
  })

  test("splits evenly with an identical seam at every arity", () => {
    for (const count of [2, 3]) {
      const sectors = arcSectors(count)
      expect(sectors).toHaveLength(count)
      const spans = sectors.map((s) => s.end - s.start)
      expect(Math.max(...spans) - Math.min(...spans)).toBeCloseTo(0)
      for (let i = 1; i < count; i++) {
        expect(sectors[i].start - sectors[i - 1].end).toBeCloseTo(14)
      }
      expect(sectors[count - 1].end).toBeLessThan(360)
    }
  })

  test("degenerate counts produce nothing to draw", () => {
    expect(arcSectors(0)).toEqual([])
  })
})

describe("buildArcModel", () => {
  test("reports loading while the first quota poll is in flight", () => {
    const model = buildArcModel({ modelProviderID: "anthropic", providers: undefined })
    expect(model.status).toBe("loading")
  })

  test("draws OpenCode Go from the ACTIVE credential's fork windows, not the quota endpoint", () => {
    const model = buildArcModel({
      modelProviderID: "opencode-go",
      providers: [],
      fork: {
        windows: [forkWindow("5h", 3, 4), forkWindow("week", 5, 20), forkWindow("month", 10, 100)],
        credentialLabel: "work",
        credentialCount: 3,
      },
    })
    expect(model.status).toBe("ready")
    expect(model.segments.map((s) => s.id)).toEqual(["5h", "week", "month"])
    expect(model.worst).toBe(25)
    expect(model.scope).toBe("work")
    expect(model.switchable).toBe(true)
    expect(model.segments.find((s) => s.binding)?.id).toBe("5h")
  })

  test("a provider with one window draws a solo arc", () => {
    const model = buildArcModel({
      modelProviderID: "opencode",
      providers: [
        provider({
          providerId: "opencode-zen",
          providerName: "OpenCode Zen",
          usage: { windows: { "daily learned": window({ usedPercent: 30, windowSeconds: 86_400 }) } },
        }),
      ],
    })
    expect(model.status).toBe("ready")
    expect(model.segments).toHaveLength(1)
    expect(model.worst).toBe(70)
  })

  test("WorkBuddy pairs the selected model's own window with the account's balances", () => {
    const model = buildArcModel({
      modelProviderID: "workbuddy",
      modelID: "hy4-preview#ctx-262144",
      providers: [
        provider({
          providerId: "workbuddy",
          providerName: "WorkBuddy",
          usage: {
            windows: {
              "aggregate:combined": window({ remainingPercent: 55, valueLabel: "1100 / 2000 pts" }),
              "aggregate:basic": window({ remainingPercent: 20 }),
            },
            workbuddyAccounts: [
              {
                accountId: "wb-1",
                label: "primary",
                models: [workbuddyModel({ model: "hy4-preview", remainingPercent: 80, limitEstimate: 50 })],
              },
            ],
          },
        }),
      ],
    })
    expect(model.segments.map((s) => s.kind)).toEqual(["model", "balance", "balance"])
    expect(model.segments[0].literal).toBe("Hy4 Preview")
    expect(model.worst).toBe(20)
  })

  test("an account-qualified WorkBuddy model scopes to that account's balances", () => {
    const model = buildArcModel({
      modelProviderID: "workbuddy",
      modelID: "hy3@wb-2",
      providers: [
        provider({
          providerId: "workbuddy",
          providerName: "WorkBuddy",
          usage: {
            windows: {
              "aggregate:combined": window({ remainingPercent: 90 }),
              "account:second:Combined": window({ remainingPercent: 12 }),
            },
            accountLabels: { "wb-2": "second" },
            workbuddyAccounts: [
              { accountId: "wb-1", label: "first", models: [workbuddyModel({ model: "hy3", remainingPercent: 99 })] },
              { accountId: "wb-2", label: "second", models: [workbuddyModel({ model: "hy3", remainingPercent: 30 })] },
            ],
          },
        }),
      ],
    })
    expect(model.scope).toBe("second")
    expect(model.segments.map((s) => s.id)).toEqual(["model:hy3", "account:second:Combined"])
    expect(model.segments[0].remaining).toBe(30)
    expect(model.worst).toBe(12)
  })

  test("keeps serving last-good numbers through a failed poll, flagged stale", () => {
    const stale = provider({
      providerId: "claude",
      providerName: "Claude",
      ok: false,
      error: "429 rate limited",
      usage: { windows: { "5h": window({ usedPercent: 10, windowSeconds: 18_000 }) } },
    })
    const model = buildArcModel({ modelProviderID: "anthropic", providers: [stale] })
    expect(model.status).toBe("ready")
    expect(model.stale).toBe(true)
    expect(model.worst).toBe(90)
  })

  test("a provider that failed with no cached usage draws nothing rather than a full ring", () => {
    const model = buildArcModel({
      modelProviderID: "anthropic",
      providers: [provider({ providerId: "claude", ok: false, error: "Not configured", usage: null })],
    })
    expect(model.status).toBe("error")
    expect(model.segments).toEqual([])
    expect(model.worst).toBeNull()
  })

  test("a provider with no quota adapter is unsupported, not empty-with-a-name", () => {
    const model = buildArcModel({ modelProviderID: "some-local-llm", providers: [] })
    expect(model.status).toBe("unsupported")
    expect(model.brandProviderID).toBe("some-local-llm")
  })

  test("an OpenRouter :free model gets its daily allowance first; a paid one does not", () => {
    const providers = [
      provider({
        providerId: "openrouter",
        providerName: "OpenRouter",
        usage: { windows: { credits: window({ remainingPercent: 64, valueLabel: "$12.80" }) } },
      }),
    ]
    const free = { remainingPercent: 8, resetsAt: new Date(86_400_000).toISOString() }

    const onFree = buildArcModel({
      modelProviderID: "openrouter",
      modelID: "deepseek/deepseek-r1:free",
      providers,
      openRouterFree: free,
    })
    expect(onFree.segments.map((s) => s.id)).toEqual(["openrouter:free", "credits"])
    expect(onFree.segments[0].remaining).toBe(8)
    expect(onFree.segments[0].resetAt).toBe(86_400_000)
    expect(onFree.worst).toBe(8)

    const onPaid = buildArcModel({
      modelProviderID: "openrouter",
      modelID: "anthropic/claude-opus-4-5",
      providers,
      openRouterFree: free,
    })
    expect(onPaid.segments.map((s) => s.id)).toEqual(["credits"])
  })

  test("carries the model provider id for the glyph even when the quota id differs", () => {
    const model = buildArcModel({
      modelProviderID: "anthropic",
      providers: [provider({ providerId: "claude", usage: { windows: { "5h": window({ usedPercent: 0 }) } } })],
    })
    expect(model.brandProviderID).toBe("anthropic")
    expect(model.quotaProviderID).toBe("claude")
  })
})
