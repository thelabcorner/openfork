import { describe, expect, test } from "bun:test"
import type { ResetAgendaResult, ResetOccurrence } from "../../src/quota/schema"
import {
  detectEarlyQuotaRecovery,
  quotaDeliveryKey,
  quotaNotificationDeadlines,
  quotaSubscriptionKey,
  verifyQuotaReset,
  type TelegramQuotaSubscription,
} from "../../src/quota/telegram-reset-policy"

const now = Date.UTC(2026, 9, 10, 17)
const deadline = now + 60_000

function occurrence(options: Partial<ResetOccurrence> = {}): ResetOccurrence {
  return {
    id: "test-id",
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    resetAt: deadline,
    observedAt: now - 1_000,
    scope: "account",
    accountId: "acct_immutable",
    accountLabel: "Original Label",
    windows: [
      { key: "five-hour", usedPercent: 99, remainingPercent: 1, valueLabel: null, source: "provider" },
      { key: "weekly", usedPercent: 50, remainingPercent: 50, valueLabel: null, source: "provider" },
    ],
    ...options,
  }
}
function agenda(...occurrences: ResetOccurrence[]): ResetAgendaResult {
  return { from: now, to: now + 32 * 86_400_000, generatedAt: now, occurrences, failures: [] }
}
const choice: TelegramQuotaSubscription = {
  providerId: "opencode-go",
  scope: "account",
  accountId: "acct_immutable",
  windowKey: "five-hour",
  enabled: true,
}

describe("Telegram quota reset notification policy", () => {
  test("matches only selected stable account and window in grouped deadline", () => {
    const rows = quotaNotificationDeadlines({
      agenda: agenda(occurrence()),
      subscriptions: [choice, { ...choice, enabled: false }, { ...choice, windowKey: "monthly" }],
      now,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.windowKey).toBe("five-hour")
    expect(rows[0]?.accountId).toBe("acct_immutable")
    expect(rows[0]?.remainingPercent).toBe(1)
  })

  test("does not use account labels as keys and does not silently widen account scope", () => {
    const identicalLabel = occurrence({ accountId: "another", accountLabel: "Original Label" })
    expect(quotaNotificationDeadlines({ agenda: agenda(identicalLabel), subscriptions: [choice], now })).toEqual([])
    expect(
      quotaNotificationDeadlines({
        agenda: agenda(occurrence({ accountId: undefined })),
        subscriptions: [choice],
        now,
      }),
    ).toEqual([])
    expect(
      quotaSubscriptionKey({ ...choice, accountId: "acct_immutable", windowKey: "weekly" }),
    ).not.toBe(quotaSubscriptionKey(choice))
  })

  test("ignores deadlines already elapsed when monitoring starts and duplicate row projections", () => {
    expect(
      quotaNotificationDeadlines({ agenda: agenda(occurrence()), subscriptions: [choice], now: deadline + 1 }),
    ).toEqual([])
    expect(
      quotaNotificationDeadlines({ agenda: agenda(occurrence(), occurrence()), subscriptions: [choice], now }),
    ).toHaveLength(1)
  })

  test("confirms only an authoritative post-deadline provider snapshot with a new window", () => {
    const [before] = quotaNotificationDeadlines({ agenda: agenda(occurrence()), subscriptions: [choice], now })
    expect(before).toBeDefined()
    if (!before) throw new Error("missing expected before-state")
    expect(verifyQuotaReset(before, agenda(occurrence()), now)).toEqual({
      state: "pending",
      reason: "not-due",
    })
    const stale = occurrence({ resetAt: deadline + 5 * 3600_000, observedAt: deadline - 1 })
    expect(verifyQuotaReset(before, agenda(stale), deadline + 1)).toEqual({
      state: "pending",
      reason: "no-fresh-observation",
    })
    const refreshed = occurrence({
      resetAt: deadline + 5 * 3600_000,
      observedAt: deadline + 5,
      windows: [
        { key: "five-hour", usedPercent: 10, remainingPercent: 90, valueLabel: null, source: "provider" },
      ],
    })
    expect(verifyQuotaReset(before, agenda(refreshed), deadline + 10)).toEqual({
      state: "confirmed",
      observedAt: deadline + 5,
      nextResetAt: deadline + 5 * 3600_000,
    })
    expect(verifyQuotaReset(before, agenda(occurrence({
      resetAt: deadline + 5 * 3600_000,
      observedAt: deadline + 5,
    })), deadline + 10)).toEqual({
      state: "pending",
      reason: "no-measured-recovery",
    })
  })

  test("refuses inferred deadlines and cross-account confirmation", () => {
    const [inferred] = quotaNotificationDeadlines({
      agenda: agenda(occurrence({ windows: [{ ...occurrence().windows[0]!, source: "inferred" }] })),
      subscriptions: [choice],
      now,
    })
    if (!inferred) throw new Error("missing inferred before-state")
    expect(verifyQuotaReset(inferred, agenda(), deadline + 1)).toEqual({
      state: "unverifiable",
      reason: "not-provider-authoritative",
    })
    const [original] = quotaNotificationDeadlines({ agenda: agenda(occurrence()), subscriptions: [choice], now })
    if (!original) throw new Error("missing account before-state")
    expect(
      verifyQuotaReset(
        original,
        agenda(occurrence({ accountId: "another", resetAt: deadline + 3600_000, observedAt: deadline + 1 })),
        deadline + 10,
      ),
    ).toEqual({ state: "pending", reason: "no-fresh-observation" })
  })

  test("delivery identity includes chat to prevent reassignment after repa iring", () => {
    const [before] = quotaNotificationDeadlines({ agenda: agenda(occurrence()), subscriptions: [choice], now })
    if (!before) throw new Error("missing deadline")
    expect(quotaDeliveryKey(before, "111")).not.toBe(quotaDeliveryKey(before, "222"))
  })

  test("detects an early reset only on fresh capacity recovery plus a new provider period", () => {
    const future = now + 3600_000
    const [baseline] = quotaNotificationDeadlines({
      agenda: agenda(occurrence({ resetAt: future })), subscriptions: [choice], now,
    })
    if (!baseline) throw new Error("missing baseline")
    const observedAt = future - 20 * 60_000
    const fresh = occurrence({
      observedAt, resetAt: future + 5 * 3600_000,
      windows: [{ key: "five-hour", usedPercent: 0, remainingPercent: 100, valueLabel: null, source: "provider" }],
    })
    const result = detectEarlyQuotaRecovery(baseline, agenda(fresh), observedAt)
    expect(result).toMatchObject({
      kind: "reset", observedAt, expectedResetAt: future,
      nextResetAt: future + 5 * 3600_000,
      previousRemainingPercent: 1, remainingPercent: 100,
    })
    expect(result?.id).toBe(JSON.stringify(["early-quota-recovery", baseline.subscriptionKey, future]))
    expect(detectEarlyQuotaRecovery(baseline, agenda({ ...fresh, observedAt: future - 30_000 }), future - 30_000))
      .toBeUndefined() // near the deadline
    expect(detectEarlyQuotaRecovery(baseline, agenda({
      ...fresh, windows: [{ ...fresh.windows[0]!, remainingPercent: 1 }],
    }), observedAt)).toBeUndefined() // timestamp movement alone
  })

  test("rejects stale, cross-account, non-provider, rolling and jitter-only evidence", () => {
    const future = now + 3600_000
    const [baseline] = quotaNotificationDeadlines({
      agenda: agenda(occurrence({ resetAt: future })), subscriptions: [choice], now,
    })
    if (!baseline) throw new Error("missing baseline")
    const at = now + 2000
    const changed = occurrence({
      observedAt: at, resetAt: future + 5 * 3600_000,
      windows: [{ key: "five-hour", usedPercent: 0, remainingPercent: 100, valueLabel: null, source: "provider" }],
    })
    expect(detectEarlyQuotaRecovery(baseline, agenda({ ...changed, accountId: "another" }), at)).toBeUndefined()
    expect(detectEarlyQuotaRecovery(baseline, agenda({ ...changed, observedAt: baseline.observedAt }), at)).toBeUndefined()
    expect(detectEarlyQuotaRecovery(baseline, agenda({ ...changed, observedAt: at + 1 }), at)).toBeUndefined()
    expect(detectEarlyQuotaRecovery(baseline, agenda({
      ...changed, windows: changed.windows.map((w) => ({ ...w, source: "inferred" as const })),
    }), at)).toBeUndefined()
    expect(detectEarlyQuotaRecovery({ ...baseline, source: "inferred" }, agenda(changed), at)).toBeUndefined()
    expect(detectEarlyQuotaRecovery({ ...baseline, providerId: "claude", windowKey: "weekly" },
      agenda({ ...changed, providerId: "claude", windows: changed.windows.map((w) => ({ ...w, key: "weekly" })) }), at))
      .toBeUndefined()
    expect(detectEarlyQuotaRecovery(baseline, agenda({ ...changed, resetAt: future + 1_000 }), at))
      .toMatchObject({ kind: "replenishment" }) // large refill, but not a confirmed new period
    expect(detectEarlyQuotaRecovery(baseline, agenda({
      ...changed, resetAt: future + 1_000,
      windows: [{ key: "five-hour", usedPercent: 80, remainingPercent: 20, valueLabel: null, source: "provider" }],
    }), at)).toBeUndefined()
  })

  test("prefers strong new-period evidence if several projected rows describe one window", () => {
    const future = now + 3600_000
    const [baseline] = quotaNotificationDeadlines({
      agenda: agenda(occurrence({ resetAt: future })), subscriptions: [choice], now,
    })
    if (!baseline) throw new Error("missing baseline")
    const observedAt = now + 3000
    const bonus = occurrence({
      observedAt, resetAt: future,
      windows: [{ key: "five-hour", usedPercent: 55, remainingPercent: 45, valueLabel: null, source: "provider" }],
    })
    const nextPeriod = occurrence({ ...bonus, resetAt: future + 5 * 3600_000 })
    const result = detectEarlyQuotaRecovery(baseline, agenda(bonus, nextPeriod), observedAt)
    expect(result).toMatchObject({ kind: "reset", nextResetAt: future + 5 * 3600_000 })
  })

  test("distinguishes unexpected bonus capacity from a confirmed early reset", () => {
    const future = now + 3600_000
    const [baseline] = quotaNotificationDeadlines({
      agenda: agenda(occurrence({ resetAt: future })), subscriptions: [choice], now,
    })
    if (!baseline) throw new Error("missing baseline")
    const fresh = occurrence({
      observedAt: now + 2000, resetAt: future,
      windows: [{ key: "five-hour", usedPercent: 70, remainingPercent: 30, valueLabel: null, source: "provider" }],
    })
    const result = detectEarlyQuotaRecovery(baseline, agenda(fresh), now + 2000)
    expect(result).toMatchObject({ kind: "replenishment", previousRemainingPercent: 1, remainingPercent: 30 })
    expect(detectEarlyQuotaRecovery(baseline, agenda({
      ...fresh, windows: [{ ...fresh.windows[0]!, remainingPercent: 19 }],
    }), now + 2000)).toBeUndefined()
  })
})
