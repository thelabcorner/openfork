import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { QuotaNotificationSource } from "../../src/notification/telegram/quota-source"
import { quotaSubscriptionKey, type TelegramQuotaSubscription } from "../../src/quota/telegram-reset-policy"
import type { ResetAgendaResult } from "../../src/quota/schema"

const before = 1_800_000_000_000
const oldReset = before + 300_000
const nextReset = oldReset + 5 * 3600_000
const subscription = { providerId: "opencode-go", scope: "account" as const, accountId: "stable-A", windowKey: "weekly", enabled: true }

function snapshot(now: number, resetAt: number, remainingPercent = 10): ResetAgendaResult {
  return {
    from: now, to: now + 32 * 86400_000, generatedAt: now, failures: [],
    occurrences: [{
      id: "sample", providerId: "opencode-go", providerName: "OpenCode Go",
      accountId: "stable-A", accountLabel: "Account A", scope: "account",
      resetAt, observedAt: now,
      windows: [{ key: "weekly", usedPercent: 100 - remainingPercent, remainingPercent, valueLabel: null, source: "provider" }],
    }],
  }
}

describe("quota reset notification source as registered Telegram service", () => {
  test("migrates Claude timestamp-jitter backlog and sends at most one measured recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-claude-spam-"))
    const file = join(dir, "quota.json")
    const five: TelegramQuotaSubscription = {
      providerId: "claude", scope: "provider", windowKey: "5h", enabled: true,
    }
    const week: TelegramQuotaSubscription = {
      providerId: "claude", scope: "provider", windowKey: "weekly", enabled: true,
    }
    const jittered = (sub: TelegramQuotaSubscription, count: number, resetAt: number) =>
      Array.from({ length: count }, (_, n) => ({
        id: JSON.stringify([quotaSubscriptionKey(sub), resetAt + n]),
        subscriptionKey: quotaSubscriptionKey(sub),
        providerId: "claude", providerName: "Claude", scope: "provider" as const,
        windowKey: sub.windowKey, resetAt: resetAt + n, observedAt: before - 1000 + n,
        source: "provider" as const, remainingPercent: 98,
      }))
    const weeklyReset = before + 7 * 86400_000
    const old5h = oldReset
    const after5h = old5h + 5 * 3600_000
    let current: ResetAgendaResult
    const observed = (at: number, fiveReset: number, fiveCapacity: number): ResetAgendaResult => ({
      from: at, to: at + 32 * 86400_000, generatedAt: at, failures: [],
      occurrences: [
        {
          id: "claude:5h", providerId: "claude", providerName: "Claude",
          scope: "provider", resetAt: fiveReset, observedAt: at,
          windows: [{ key: "5h", usedPercent: 100 - fiveCapacity, remainingPercent: fiveCapacity, valueLabel: null, source: "provider" }],
        },
        {
          id: "claude:weekly", providerId: "claude", providerName: "Claude",
          scope: "provider", resetAt: weeklyReset + (at - before), observedAt: at,
          windows: [{ key: "weekly", usedPercent: 2, remainingPercent: 98, valueLabel: null, source: "provider" }],
        },
      ],
    })
    current = observed(before, old5h + 100, 98)
    try {
      await writeFile(file, JSON.stringify({
        enabled: true, subscriptions: [five, week],
        deadlines: [...jittered(week, 98, weeklyReset), ...jittered(five, 3, old5h)],
      }))
      const source = new QuotaNotificationSource(async () => current, file)
      await source.initialize()
      expect(source.status().scheduled).toBe(0) // all 101 stale deadlines are discarded
      expect(await source.collect(before)).toEqual([])
      current = observed(old5h + 80_000, after5h, 98)
      expect(await source.collect(old5h + 80_000)).toEqual([]) // moving deadline only
      expect(source.status().scheduled).toBe(0)
      current = observed(old5h + 81_000, after5h, 99)
      const notices = await source.collect(old5h + 81_000)
      expect(notices).toHaveLength(1)
      expect(notices[0]!.text).toContain("rolling quota capacity increased")
      expect(notices[0]!.text).toContain("Window: 5h (rolling)")
      await source.acknowledge(notices[0]!.id)
      expect(await source.collect(old5h + 81_000)).toEqual([])
      const restarted = new QuotaNotificationSource(async () => current, file)
      await restarted.initialize()
      expect(await restarted.collect(old5h + 81_000)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("subscribes by stable account ID and confirms only a subsequent provider window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-quota-"))
    const file = join(dir, "quota.json")
    let current = snapshot(before, oldReset)
    const source = new QuotaNotificationSource(async () => current, file)
    try {
      await source.initialize()
      expect(source.active()).toBe(false)
      await source.update({ enabled: true, subscriptions: [subscription] })
      expect(source.active()).toBe(true)
      expect(await source.collect(before)).toEqual([])
      expect(source.status().scheduled).toBe(1)
      expect(source.nextPollDelayMs(before)).toBe(oldReset + 60_000 - before)

      // Stale observation or the same reset deadline isn't evidence.
      current = snapshot(before, oldReset)
      expect(await source.collect(oldReset + 70_000)).toEqual([])

      current = snapshot(oldReset + 80_000, nextReset, 90)
      const confirmed = await source.collect(oldReset + 80_000)
      expect(confirmed).toHaveLength(1)
      expect(confirmed[0]?.text).toContain("Account A")
      expect(confirmed[0]?.text).toContain("quota reset confirmed")
      await source.acknowledge(confirmed[0]!.id)
      expect(source.status().scheduled).toBe(1) // next-reset baseline remains monitored

      // Revoking a subscription must remove any pending baseline.
      await source.update({ enabled: false, subscriptions: [subscription] })
      expect(source.active()).toBe(false)
      expect(await source.collect(nextReset + 60_000)).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("observed deadline creates only a scheduled and explicitly unverified reminder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-quota-"))
    const source = new QuotaNotificationSource(async () => current, join(dir, "quota.json"))
    let current = snapshot(before, oldReset)
    current = {
      ...current,
      occurrences: current.occurrences.map((row) => ({
        ...row,
        windows: row.windows.map((window) => ({ ...window, source: "observed" as const })),
      })),
    }
    try {
      await source.initialize()
      await source.update({ enabled: true, subscriptions: [subscription] })
      expect(await source.collect(before)).toEqual([])
      // No updated provider observation is required for an explicitly
      // scheduled reminder; its text must not claim replenishment.
      const messages = await source.collect(oldReset + 61_000)
      expect(messages).toHaveLength(1)
      expect(messages[0]!.text).toContain("unverified")
      expect(messages[0]!.text).not.toContain("quota reset confirmed")
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("stale asynchronous fetch cannot resurrect a disabled subscription", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-quota-"))
    const file = join(dir, "quota.json")
    let resolve!: (agenda: ResetAgendaResult) => void
    const source = new QuotaNotificationSource(() => new Promise((r) => { resolve = r }), file)
    try {
      await source.initialize()
      await source.update({ enabled: true, subscriptions: [subscription] })
      const running = source.collect(before)
      await source.update({ enabled: false, subscriptions: [subscription] })
      resolve(snapshot(before, oldReset))
      expect(await running).toEqual([])
      expect(source.status().scheduled).toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
