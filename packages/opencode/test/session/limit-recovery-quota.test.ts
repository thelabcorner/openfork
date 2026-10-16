import { describe, expect, test } from "bun:test"
import type { ResetAgendaResult, ResetOccurrence } from "@/quota/schema"
import { selectRecoveryQuotaReset } from "@/session/limit-recovery-quota"

function occurrence(input: Partial<ResetOccurrence> & Pick<ResetOccurrence, "resetAt" | "scope">): ResetOccurrence {
  return {
    id: `reset-${input.resetAt}-${input.scope}`,
    providerId: "codex",
    providerName: "Codex",
    observedAt: 1_000,
    windows: [
      {
        key: "5h",
        usedPercent: 100,
        remainingPercent: 0,
        valueLabel: null,
        source: "provider",
      },
    ],
    ...input,
  }
}

function agenda(occurrences: ResetOccurrence[]): ResetAgendaResult {
  return {
    from: 1_000,
    to: 100_000,
    generatedAt: 1_000,
    occurrences,
    failures: [],
  }
}

describe("selectRecoveryQuotaReset", () => {
  test("trusts exhausted provider-wide reset only when route identity is not account-ambiguous", () => {
    const value = selectRecoveryQuotaReset(agenda([occurrence({ resetAt: 5_000, scope: "provider" })]), {
      modelID: "gpt-5",
    })
    expect(value).toEqual({ resetAt: 5_000, resetObservedAt: 1_000, resetSource: "provider" })

    const ambiguous = selectRecoveryQuotaReset(agenda([occurrence({ resetAt: 5_000, scope: "provider" })]), {
      accountID: "acct-a",
      modelID: "gpt-5",
    })
    expect(ambiguous?.resetSource).toBe("observed")
  })

  test("requires exact account/model scope and chooses the latest blocking reset", () => {
    const value = selectRecoveryQuotaReset(
      agenda([
        occurrence({ resetAt: 5_000, scope: "account", accountId: "acct-a" }),
        occurrence({ resetAt: 9_000, scope: "account-model", accountId: "acct-a", model: "gpt-5" }),
        occurrence({ resetAt: 12_000, scope: "account", accountId: "acct-b" }),
      ]),
      { accountID: "acct-a", modelID: "gpt-5" },
    )
    expect(value).toEqual({ resetAt: 9_000, resetObservedAt: 1_000, resetSource: "provider" })
  })

  test("does not treat a non-exhausted quota window as a blocking reset", () => {
    const value = selectRecoveryQuotaReset(
      agenda([
        occurrence({
          resetAt: 5_000,
          scope: "provider",
          windows: [
            {
              key: "5h",
              usedPercent: 42,
              remainingPercent: 58,
              valueLabel: null,
              source: "provider",
            },
          ],
        }),
      ]),
      { modelID: "gpt-5" },
    )
    expect(value).toBeUndefined()
  })

  test("keeps percentage-free reset evidence observational instead of granting execution authority", () => {
    const value = selectRecoveryQuotaReset(
      agenda([
        occurrence({
          resetAt: 5_000,
          scope: "provider",
          windows: [
            {
              key: "rate",
              usedPercent: null,
              remainingPercent: null,
              valueLabel: null,
              source: "provider",
            },
          ],
        }),
      ]),
      { modelID: "gpt-5" },
    )
    expect(value?.resetSource).toBe("observed")
  })

  test("downgrades provider reset evidence that predates the confirmed runtime failure", () => {
    const stale = selectRecoveryQuotaReset(
      agenda([occurrence({ resetAt: 5_000, observedAt: 1_000, scope: "model", model: "gpt-5" })]),
      { modelID: "gpt-5", failureObservedAt: 1_001 },
    )
    expect(stale).toEqual({ resetAt: 5_000, resetObservedAt: 1_000, resetSource: "observed" })

    const fresh = selectRecoveryQuotaReset(
      agenda([occurrence({ resetAt: 5_000, observedAt: 1_001, scope: "model", model: "gpt-5" })]),
      { modelID: "gpt-5", failureObservedAt: 1_001 },
    )
    expect(fresh).toEqual({ resetAt: 5_000, resetObservedAt: 1_001, resetSource: "provider" })
  })
})
