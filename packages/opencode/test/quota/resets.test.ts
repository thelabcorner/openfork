import { describe, expect, test } from "bun:test"
import { buildResetAgenda } from "../../src/quota/resets"
import type { ProviderResult } from "../../src/quota/schema"
import type { ForkUsageSnapshot } from "../../src/fork/usage"

const from = Date.UTC(2026, 8, 21)
const to = from + 7 * 24 * 60 * 60 * 1000
const resetAt = from + 60 * 60 * 1000

function window(at = resetAt) {
  return {
    usedPercent: 25,
    remainingPercent: 75,
    windowSeconds: 18_000,
    resetAt: at,
    resetAfterSeconds: 3_600,
    valueLabel: null,
  }
}

function provider(overrides: Partial<ProviderResult> = {}): ProviderResult {
  return {
    providerId: "claude",
    providerName: "Claude",
    ok: true,
    configured: true,
    planLabel: null,
    usage: { windows: { "5h": window(), weekly: window() } },
    fetchedAt: from,
    ...overrides,
  }
}

describe("quota reset agenda projection", () => {
  test("groups same-scope same-deadline windows without inventing recurrences", () => {
    const result = buildResetAgenda({ from, to, generatedAt: from, providerResults: [provider()] })
    expect(result.occurrences).toHaveLength(1)
    expect(result.occurrences[0]?.resetAt).toBe(resetAt)
    expect(result.occurrences[0]?.windows.map((item) => item.key)).toEqual(["5h", "weekly"])

    const later = buildResetAgenda({
      from: resetAt + 1,
      to,
      generatedAt: from,
      providerResults: [provider()],
    })
    expect(later.occurrences).toEqual([])
  })

  test("keeps WorkBuddy account package and account-model reset identity", () => {
    const result = buildResetAgenda({
      from,
      to,
      generatedAt: from,
      providerResults: [
        provider({
          providerId: "workbuddy",
          providerName: "WorkBuddy",
          usage: {
            windows: {
              "account:alpha@example.com:Basic": window(),
              "account:alpha@example.com:Combined": window(),
            },
            accountLabels: { "wb-stable": "alpha@example.com" },
            workbuddyAccounts: [
              {
                accountId: "wb-stable",
                label: "alpha@example.com",
                models: [
                  {
                    model: "hy3",
                    canonical: "hunyuan-3",
                    unit: "credits",
                    usedObserved: 1,
                    limitEstimate: 10,
                    remainingEstimate: 9,
                    remainingPercent: 90,
                    status: "healthy",
                    confidence: "high",
                    accuracy: "server-confirmed",
                    exhaustedObserved: false,
                    serverCode: 6004,
                    resetAt,
                    resetSource: "server-6004",
                    windowType: "server-defined",
                    windowStartedAt: from,
                    secondsUntilReset: 3_600,
                    lastObservationAt: from + 500,
                    burnPerHour: null,
                    estimatedExhaustionAt: null,
                    willLikelyExhaustBeforeReset: false,
                    creditsObserved: 1,
                    tokensInput: 100,
                    tokensOutput: 50,
                    tokensCacheHit: 0,
                    tokensCacheMiss: 0,
                    creditsPersonalized: false,
                    coverage: "opencode-only",
                  },
                ],
              },
            ],
          },
        }),
      ],
    })

    const account = result.occurrences.find((item) => item.scope === "account")
    expect(account?.accountId).toBe("wb-stable")
    expect(account?.accountLabel).toBe("alpha@example.com")
    expect(account?.windows.map((item) => item.key)).toEqual(["Basic", "Combined"])

    const model = result.occurrences.find((item) => item.scope === "account-model")
    expect(model?.accountId).toBe("wb-stable")
    expect(model?.model).toBe("hunyuan-3")
    expect(model?.windows[0]?.source).toBe("observed")
  })

  test("projects every OpenCode Go account from the shared fork snapshot", () => {
    const goSnapshot: ForkUsageSnapshot = {
      result: {
        aggregate: [
          {
            label: "5h",
            spentUSD: 2,
            limitUSD: 10,
            resetsAt: resetAt,
            clearsAt: resetAt,
            callsInWindow: 2,
            source: "api",
          },
        ],
        byCredential: [
          {
            credentialID: "cred-a",
            accountID: "zen-a",
            windows: [
              {
                label: "5h",
                spentUSD: 2,
                limitUSD: 10,
                resetsAt: resetAt,
                clearsAt: resetAt,
                callsInWindow: 2,
                source: "api",
              },
            ],
            official: { fetchedAt: from + 10, ageMs: 0, status: "ok" },
          },
          {
            credentialID: "zen-b",
            accountID: "zen-b",
            windows: [
              {
                label: "week",
                spentUSD: 1,
                limitUSD: 10,
                resetsAt: resetAt + 500,
                clearsAt: resetAt + 500,
                callsInWindow: 1,
                source: "api",
              },
            ],
            official: { fetchedAt: from + 20, ageMs: 0, status: "stale" },
          },
        ],
      },
      accountLabels: new Map([
        ["zen-a", "Primary"],
        ["zen-b", "Migrated Key"],
      ]),
    }

    const result = buildResetAgenda({
      from,
      to,
      generatedAt: from,
      providerResults: [
        provider({
          providerId: "opencode-go",
          providerName: "OpenCode Go",
          usage: { windows: { "5h": window() } },
        }),
      ],
      goSnapshot,
    })

    // The aggregate row is a derived earliest-account summary, not a third
    // physical quota reset. Account-specific official deadlines win.
    expect(result.occurrences.filter((item) => item.providerId === "opencode-go")).toHaveLength(2)
    expect(result.occurrences.find((item) => item.accountId === "zen-a")?.accountLabel).toBe("Primary")
    expect(result.occurrences.find((item) => item.accountId === "zen-b")?.accountLabel).toBe("Migrated Key")
    expect(result.occurrences.find((item) => item.accountId === "zen-b")?.windows[0]?.source).toBe("observed")
  })

  test("preserves partial provider failures instead of failing the whole agenda", () => {
    const result = buildResetAgenda({
      from,
      to,
      generatedAt: from,
      providerResults: [
        provider(),
        provider({
          providerId: "deepseek",
          providerName: "DeepSeek",
          ok: false,
          error: "rate limited",
          usage: null,
        }),
      ],
    })

    expect(result.occurrences.length).toBeGreaterThan(0)
    expect(result.failures).toEqual([{ providerId: "deepseek", providerName: "DeepSeek", error: "rate limited" }])
  })
})
