import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { QuotaNotificationSource } from "../../src/notification/telegram/quota-source"
import { observeRollingCapacity, type RollingObservation } from "../../src/notification/telegram/quota-rolling-recovery"
import {
  quotaNotificationDeadlines,
  quotaSubscriptionKey,
  verifyQuotaReset,
  type TelegramQuotaDeadline,
  type TelegramQuotaSubscription,
} from "../../src/quota/telegram-reset-policy"
import type { ResetAgendaResult, ResetSource } from "../../src/quota/schema"

const start = 1_800_100_000_000
const interval = 300_000
const sub: TelegramQuotaSubscription = {
  providerId: "opencode-go", scope: "account", accountId: "stable-go-account",
  windowKey: "5h", enabled: true,
}
const subKey = quotaSubscriptionKey(sub)

function agenda(observedAt: number, resetAt: number, remaining: number, source: ResetSource = "provider", accountId = sub.accountId): ResetAgendaResult {
  return {
    from: observedAt, to: observedAt + 32 * 86_400_000,
    generatedAt: observedAt, failures: [],
    occurrences: [{
      id: `go:${observedAt}`, providerId: "opencode-go", providerName: "OpenCode Go",
      scope: "account", accountId, accountLabel: "Migrated key",
      resetAt, observedAt,
      windows: [{ key: "5h", remainingPercent: remaining, usedPercent: 100 - remaining, valueLabel: null, source }],
    }],
  }
}

function oldDeadline(): TelegramQuotaDeadline {
  return {
    id: JSON.stringify([subKey, start + 60_000]),
    subscriptionKey: subKey,
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    scope: "account",
    accountId: sub.accountId,
    accountLabel: "Migrated key",
    windowKey: "5h",
    resetAt: start + 60_000,
    observedAt: start,
    source: "provider",
    remainingPercent: 0,
  }
}

describe("Telegram OpenCode Go rolling 5h anti-spam regression", () => {
  test("moving 5h provider reset estimates are never a fixed reset confirmation", () => {
    const baseline = agenda(start, start + 60_000, 1)
    expect(quotaNotificationDeadlines({ agenda: baseline, subscriptions: [sub], now: start })).toEqual([])
    expect(verifyQuotaReset(oldDeadline(), agenda(start + interval, start + 5 * 3_600_000, 90), start + interval))
      .toEqual({ state: "unverifiable", reason: "rolling-window" })
    // This classification is provider-specific, not a wildcard for 5h labels.
    const anotherProvider = {
      ...baseline,
      occurrences: baseline.occurrences.map((row) => ({ ...row, providerId: "fixed-provider" })),
    }
    const fixedSub = { ...sub, providerId: "fixed-provider" }
    expect(quotaNotificationDeadlines({ agenda: anotherProvider, subscriptions: [fixedSub], now: start })).toHaveLength(1)
  })

  test("prunes pre-upgrade queued rolling deadlines, even after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-rolling-"))
    const file = join(dir, "source.json")
    await writeFile(file, JSON.stringify({
      enabled: true, subscriptions: [sub], deadlines: [oldDeadline()],
    }))
    let current = agenda(start, start + interval, 50)
    try {
      const source = new QuotaNotificationSource(async () => current, file)
      await source.initialize()
      expect(source.active()).toBe(true)
      expect(source.status().scheduled).toBe(0)
      for (let n = 0; n < 12; n++) {
        const t = start + n * interval
        current = agenda(t, t + 5 * 3_600_000, 50)
        expect(await source.collect(t)).toEqual([])
        expect(source.status().scheduled).toBe(0)
      }
      const saved = JSON.parse(await readFile(file, "utf8")) as { deadlines: unknown[] }
      expect(saved.deadlines).toEqual([])
      const restarted = new QuotaNotificationSource(async () => current, file)
      await restarted.initialize()
      expect(restarted.status().scheduled).toBe(0)
      expect(await restarted.collect(start + 12 * interval)).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("notifies for 98 -> 99 available without requiring exhaustion; durable dedupe after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-rolling-"))
    const file = join(dir, "source.json")
    let current = agenda(start, start + 5 * 3_600_000, 98)
    const source = new QuotaNotificationSource(async () => current, file)
    try {
      await source.initialize()
      await source.update({ enabled: true, subscriptions: [sub] })
      expect(source.nextPollDelayMs(start)).toBe(5 * 60_000 + 2_000)
      expect(await source.collect(start)).toEqual([]) // initial sample is only a baseline

      current = agenda(start + interval, start + interval + 5 * 3_600_000, 98.5)
      expect(await source.collect(start + interval)).toEqual([]) // cumulative 0.5pp is not yet enough
      current = agenda(start + 2 * interval, start + 2 * interval + 5 * 3_600_000, 99)
      const notices = await source.collect(start + 2 * interval)
      expect(notices).toHaveLength(1)
      expect(notices[0]!.text).toContain("rolling quota capacity increased")
      expect(notices[0]!.text).toContain("Available: 98% → 99% (+1 pp)")
      expect(notices[0]!.text).not.toContain("quota reset confirmed")
      expect(await source.collect(start + 2 * interval)).toEqual(notices) // pending until hub acknowledges
      await source.acknowledge(notices[0]!.id)

      const restarted = new QuotaNotificationSource(async () => current, file)
      await restarted.initialize()
      expect(await restarted.collect(start + 2 * interval)).toEqual([])
      current = agenda(start + 3 * interval, start + 3 * interval + 5 * 3_600_000, 100)
      expect(await restarted.collect(start + 3 * interval)).toEqual([]) // real increase but cooldown
      for (let n = 4; n <= 20; n++) {
        const t = start + n * interval
        current = agenda(t, t + 5 * 3_600_000, 100)
        expect(await restarted.collect(t)).toEqual([]) // flat 100%, continuously moving resetAt
      }

      // After cooldown, another new recovery is allowed; never emit merely
      // because 100% stayed constant for an hour.
      const downAt = start + 21 * interval
      current = agenda(downAt, downAt + 5 * 3_600_000, 98)
      expect(await restarted.collect(downAt)).toEqual([])
      const upAt = start + 22 * interval
      current = agenda(upAt, upAt + 5 * 3_600_000, 99)
      const later = await restarted.collect(upAt)
      expect(later).toHaveLength(1)
      expect(later[0]!.id).not.toBe(notices[0]!.id)
      expect(later[0]!.text).toContain("Available: 98% → 99% (+1 pp)")
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("large restoration before a moving estimate gets a distinct, cautious early-replenishment alert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-rolling-early-"))
    const file = join(dir, "quota.json")
    let current = agenda(start, start + 5 * 3600_000, 0)
    try {
      const source = new QuotaNotificationSource(async () => current, file)
      await source.initialize()
      await source.update({ enabled: true, subscriptions: [sub] })
      expect(await source.collect(start)).toEqual([])
      current = agenda(start + interval, start + interval + 5 * 3600_000, 95)
      const [notice] = await source.collect(start + interval)
      expect(notice?.text).toContain("UNEXPECTED EARLY QUOTA REPLENISHMENT (rolling)")
      expect(notice?.text).toContain("Available: 0% → 95% (+95 pp)")
      expect(notice?.text).toContain("Prior estimated reset:")
      expect(notice?.text).toContain("provider gift or full reset is not confirmed")
      expect(source.status().scheduled).toBe(1)
      const restarted = new QuotaNotificationSource(async () => current, file)
      await restarted.initialize()
      expect((await restarted.collect(start + interval)).map((r) => r.id)).toEqual([notice?.id])
      if (!notice) throw new Error("missing early notice")
      await restarted.acknowledge(notice.id)
      expect(await restarted.collect(start + interval)).toEqual([])
      current = agenda(start + 2 * interval, start + 2 * interval + 5 * 3600_000, 95)
      expect(await restarted.collect(start + 2 * interval)).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("ordinary rolling recoveries remain ordinary; a major leap can override their cooldown", () => {
    const sample = (n: number, available: number, estimate = start + 5 * 3600_000): RollingObservation => ({
      subscriptionKey: subKey, providerName: "OpenCode Go", windowKey: "5h",
      observedAt: start + n * interval, remainingPercent: available, resetAt: estimate,
    })
    let state = observeRollingCapacity(undefined, sample(0, 0))
    state = observeRollingCapacity(state, sample(1, 1))
    expect(state.pending?.text).toContain("rolling quota capacity increased")
    state = { ...state, pending: undefined } // simulated acknowledgment
    state = observeRollingCapacity(state, sample(2, 80))
    expect(state.pending?.text).toContain("UNEXPECTED EARLY QUOTA REPLENISHMENT")
    expect(state.lastEarlyAlertAt).toBe(start + 2 * interval)
    state = { ...state, pending: undefined }
    state = observeRollingCapacity(state, sample(3, 90))
    expect(state.pending).toBeUndefined()
    state = observeRollingCapacity(state, sample(4, 90, start + 5 * 3600_000 + 4))
    expect(state.pending).toBeUndefined()
    let withoutEstimate = observeRollingCapacity(undefined, { ...sample(0, 0), resetAt: undefined })
    withoutEstimate = observeRollingCapacity(withoutEstimate, { ...sample(1, 100), resetAt: undefined })
    expect(withoutEstimate.pending?.text).toContain("rolling quota capacity increased")
    expect(withoutEstimate.pending?.text).not.toContain("UNEXPECTED EARLY")
  })

  test("100% used forever: new reset timestamp every five minutes is never a quota event", () => {
    const sample = (n: number, remainingPercent: number): RollingObservation => ({
      subscriptionKey: subKey, providerName: "OpenCode Go", accountLabel: "Migrated key",
      windowKey: "5h", observedAt: start + n * interval, remainingPercent,
    })
    let state = observeRollingCapacity(undefined, sample(0, 0)) // 100% used
    for (let n = 1; n <= 288; n++) {
      state = observeRollingCapacity(state, sample(n, 0)) // 24 hours of moving deadlines
      expect(state.pending).toBeUndefined()
      expect(state.remainingPercent).toBe(0)
    }
    // A 100% available window must similarly never repeat when unchanged.
    state = observeRollingCapacity(undefined, sample(0, 100))
    for (let n = 1; n <= 288; n++) {
      state = observeRollingCapacity(state, sample(n, 100))
      expect(state.pending).toBeUndefined()
    }
  })

  test("spent utilization increases are not recovery; 99% used to 98% used is", () => {
    const sample = (n: number, remainingPercent: number): RollingObservation => ({
      subscriptionKey: subKey, providerName: "OpenCode Go", windowKey: "5h",
      observedAt: start + n * interval, remainingPercent,
    })
    let state = observeRollingCapacity(undefined, sample(0, 2)) // used=98%
    state = observeRollingCapacity(state, sample(1, 1)) // used=99%: consumption, not recovery
    expect(state.pending).toBeUndefined()
    state = observeRollingCapacity(state, sample(2, 2)) // used=98%: actual recovery of 1pp
    expect(state.pending?.text).toContain("Available: 1% → 2% (+1 pp)")
  })

  test("small cumulative improvements count; repeat and sub-threshold jitter do not", () => {
    const sample = (n: number, remainingPercent: number): RollingObservation => ({
      subscriptionKey: subKey, providerName: "OpenCode Go", windowKey: "5h",
      observedAt: start + n * interval, remainingPercent,
    })
    let state = observeRollingCapacity(undefined, sample(0, 98))
    state = observeRollingCapacity(state, sample(1, 98.3))
    state = observeRollingCapacity(state, sample(2, 98.7))
    expect(state.pending).toBeUndefined()
    state = observeRollingCapacity(state, sample(3, 99))
    expect(state.pending?.text).toContain("Available: 98% → 99% (+1 pp)")
    // Same sample or older provider response cannot create a new pending alert.
    const same = observeRollingCapacity(state, sample(3, 100))
    expect(same).toBe(state)
    const stale = observeRollingCapacity(state, sample(2, 100))
    expect(stale).toBe(state)
  })

  test("pre-upgrade exhaustion-only pending notices are dropped, and tracking reseeds safely", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-rolling-"))
    const file = join(dir, "quota.json")
    const legacy = {
      subscriptionKey: subKey, observedAt: start, armed: true,
      pending: {
        id: JSON.stringify(["rolling-capacity-restored", subKey, start]),
        text: "OpenFork · rolling quota availability recovered",
      },
    }
    await writeFile(file, JSON.stringify({
      enabled: true, subscriptions: [sub], deadlines: [], rolling: [legacy],
    }))
    let current = agenda(start + interval, start + 5 * 3_600_000, 99)
    try {
      const source = new QuotaNotificationSource(async () => current, file)
      await source.initialize()
      expect(source.status().scheduled).toBe(0)
      expect(await source.collect(start + interval)).toEqual([]) // legacy exhaustion cannot synthesize a jump
      current = agenda(start + 2 * interval, start + 5 * 3_600_000, 100)
      expect(await source.collect(start + 2 * interval)).toHaveLength(1) // new real +1pp
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("after an offline gap the next observation seeds a baseline, not a retroactive alert", () => {
    const sample = (n: number, remainingPercent: number): RollingObservation => ({
      subscriptionKey: subKey, providerName: "OpenCode Go", windowKey: "5h",
      observedAt: start + n * interval, remainingPercent,
    })
    let state = observeRollingCapacity(undefined, sample(0, 98))
    state = observeRollingCapacity(state, sample(12, 99)) // offline for an hour
    expect(state.pending).toBeUndefined()
    state = observeRollingCapacity(state, sample(13, 100)) // actual new 1pp increase
    expect(state.pending?.text).toContain("Available: 99% → 100% (+1 pp)")
  })

  test("disabling and re-enabling clears comparisons from the paused period; only selected provider is read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-rolling-"))
    const file = join(dir, "source.json")
    const selectedProviders: string[][] = []
    let current = agenda(start, start + 5 * 3_600_000, 98)
    const source = new QuotaNotificationSource(async (_from, _to, providers) => {
      selectedProviders.push([...providers])
      return current
    }, file)
    try {
      await source.initialize()
      await source.update({ enabled: true, subscriptions: [sub] })
      expect(await source.collect(start)).toEqual([])
      expect(selectedProviders).toEqual([["opencode-go"]])
      await source.update({ enabled: false, subscriptions: [sub] })
      current = agenda(start + interval, start + 5 * 3_600_000, 99)
      expect(await source.collect(start + interval)).toEqual([])
      await source.update({ enabled: true, subscriptions: [sub] })
      expect(await source.collect(start + interval)).toEqual([]) // seed current 99%
      current = agenda(start + 2 * interval, start + 5 * 3_600_000, 100)
      expect(await source.collect(start + 2 * interval)).toHaveLength(1) // fresh +1pp
      expect(selectedProviders).toEqual([["opencode-go"], ["opencode-go"], ["opencode-go"]].slice(0, 3))
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("stale/non-authoritative observations and mismatched accounts cannot arm recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openfork-telegram-rolling-"))
    const file = join(dir, "source.json")
    let current = agenda(start, start + interval, 0, "observed")
    const source = new QuotaNotificationSource(async () => current, file)
    try {
      await source.initialize()
      await source.update({ enabled: true, subscriptions: [sub] })
      expect(await source.collect(start)).toEqual([])
      current = agenda(start + interval, start + 5 * 3_600_000, 0, "provider", "different-account")
      expect(await source.collect(start + interval)).toEqual([])
      current = agenda(start + 2 * interval, start + 5 * 3_600_000, 20)
      expect(await source.collect(start + 2 * interval)).toEqual([]) // no authoritative depletion observed
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
