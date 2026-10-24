import { randomBytes } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Global } from "@opencode-ai/core/global"
import type { ResetAgendaResult } from "@/quota/schema"
import {
  detectEarlyQuotaRecovery,
  isRollingQuotaWindow,
  quotaNotificationDeadlines,
  quotaSubscriptionKey,
  verifyQuotaReset,
  type TelegramQuotaDeadline,
  type TelegramQuotaSubscription,
} from "@/quota/telegram-reset-policy"
import type { NotificationSource, NotificationIntent } from "./hub"
import {
  migrateRollingCapacity,
  observeRollingCapacity,
  rollingObservations,
  validRollingCapacity,
  type RollingCapacityState,
} from "./quota-rolling-recovery"

const STATE_FILE = path.join(Global.Path.data, "telegram-notifications.quota.json")
const HORIZON = 32 * 86400_000
const MAX_SUBSCRIPTIONS = 128
const MAX_DEADLINES = 512

/** Provider/account labels are external content, never Telegram instructions. */
function safeMessagePart(value: string | undefined): string {
  return (value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)
}

export type QuotaNotificationSettings = {
  enabled: boolean
  subscriptions: TelegramQuotaSubscription[]
  scheduled: number
}
type State = {
  enabled: boolean
  subscriptions: TelegramQuotaSubscription[]
  deadlines: TelegramQuotaDeadline[]
  rolling: RollingCapacityState[]
  early: EarlyPending[]
}
type EarlyPending = NotificationIntent & { readonly subscriptionKey: string }

function validEarlyPending(value: unknown): value is EarlyPending {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.subscriptionKey === "string" && row.subscriptionKey.length <= 2048 &&
    typeof row.id === "string" && row.id.length > 0 && row.id.length <= 3000 &&
    typeof row.text === "string" && row.text.length > 0 && row.text.length <= 4096
}

function percent(value: number): string {
  return (Math.round(value * 10) / 10).toString()
}

function validSubscription(value: unknown): value is TelegramQuotaSubscription {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  const scope = o.scope
  return (
    typeof o.providerId === "string" && o.providerId.length > 0 && o.providerId.length <= 128 &&
    (scope === "provider" || scope === "account" || scope === "model" || scope === "account-model") &&
    typeof o.windowKey === "string" && o.windowKey.length > 0 && o.windowKey.length <= 128 &&
    typeof o.enabled === "boolean" &&
    (o.accountId === undefined || (typeof o.accountId === "string" && o.accountId.length < 256)) &&
    (o.model === undefined || (typeof o.model === "string" && o.model.length < 256)) &&
    ((scope !== "account" && scope !== "account-model") || (typeof o.accountId === "string" && o.accountId.length > 0))
  )
}
function validDeadline(value: unknown): value is TelegramQuotaDeadline {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.id === "string" && o.id.length <= 4096 &&
    typeof o.subscriptionKey === "string" && o.subscriptionKey.length <= 2048 &&
    typeof o.providerId === "string" && typeof o.windowKey === "string" &&
    typeof o.providerName === "string" &&
    (o.source === "provider" || o.source === "observed" || o.source === "inferred" || o.source === "local") &&
    typeof o.resetAt === "number" && Number.isFinite(o.resetAt) &&
    typeof o.observedAt === "number" && Number.isFinite(o.observedAt)
  )
}

/**
 * Providers can revise an estimated reset timestamp on every poll. These
 * estimate changes are not distinct quota events. Keep one pending deadline
 * per subscription in each phase; a due deadline is retained briefly to
 * verify recovery even after the next future estimate becomes available.
 */
function coalesceDeadlines(rows: readonly TelegramQuotaDeadline[], now: number): TelegramQuotaDeadline[] {
  const byWindowAndPhase = new Map<string, TelegramQuotaDeadline>()
  for (const row of rows) {
    if (isRollingQuotaWindow(row) || row.resetAt < now - 24 * 3600_000) continue
    const phase = row.resetAt + 60_000 <= now ? "due" : "future"
    const key = JSON.stringify([row.subscriptionKey, phase])
    const previous = byWindowAndPhase.get(key)
    if (!previous || row.observedAt > previous.observedAt ||
        (row.observedAt === previous.observedAt && row.resetAt > previous.resetAt)) {
      byWindowAndPhase.set(key, row)
    }
  }
  return [...byWindowAndPhase.values()].sort((a, b) => a.resetAt - b.resetAt).slice(0, MAX_DEADLINES)
}

export class QuotaNotificationSource implements NotificationSource {
  readonly id = "quota"
  readonly title = "Quota alerts"
  private state: State = { enabled: false, subscriptions: [], deadlines: [], rolling: [], early: [] }
  private writeTail: Promise<void> = Promise.resolve()
  private revision = 0

  constructor(
    private readonly agenda: (from: number, to: number, providerIds: readonly string[]) => Promise<ResetAgendaResult>,
    private readonly file: string = STATE_FILE,
  ) {}

  async initialize() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<State>
      if (!raw || typeof raw !== "object") return
      this.state.enabled = raw.enabled === true
      this.state.subscriptions = Array.isArray(raw.subscriptions)
        ? raw.subscriptions.filter(validSubscription).slice(0, MAX_SUBSCRIPTIONS)
        : []
      this.state.deadlines = Array.isArray(raw.deadlines)
        ? coalesceDeadlines(raw.deadlines.filter(validDeadline), Date.now())
        : []
      this.state.rolling = Array.isArray(raw.rolling)
        ? raw.rolling.filter(validRollingCapacity).map(migrateRollingCapacity).slice(0, MAX_SUBSCRIPTIONS)
        : []
      this.state.early = Array.isArray(raw.early)
        ? raw.early.filter(validEarlyPending).slice(0, MAX_SUBSCRIPTIONS)
        : []
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        // Corrupt/unreadable data must not initialize notifications with unknown
        // selection. Preserve the file for forensics and remain disabled.
        this.state = { enabled: false, subscriptions: [], deadlines: [], rolling: [], early: [] }
      }
    }
  }

  active() {
    return this.state.enabled && this.state.subscriptions.some((sub) => sub.enabled)
  }

  status(): QuotaNotificationSettings {
    return {
      enabled: this.state.enabled,
      subscriptions: this.state.subscriptions.map((sub) => ({ ...sub })),
      scheduled: this.state.deadlines.length + this.state.rolling.filter((row) => row.pending).length + this.state.early.length,
    }
  }

  private save() {
    const snapshot = structuredClone(this.state)
    const work = this.writeTail.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
      try {
        await fs.writeFile(temp, JSON.stringify(snapshot), { flag: "wx", mode: 0o600 })
        await fs.chmod(temp, 0o600)
        await fs.rename(temp, this.file)
      } finally { await fs.rm(temp, { force: true }).catch(() => undefined) }
    })
    this.writeTail = work
    return work
  }

  async update(input: { enabled: boolean; subscriptions: readonly TelegramQuotaSubscription[] }) {
    if (!input || typeof input.enabled !== "boolean" || !Array.isArray(input.subscriptions) ||
        input.subscriptions.length > MAX_SUBSCRIPTIONS || !input.subscriptions.every(validSubscription)) {
      throw new Error("Invalid quota notification selection")
    }
    const unique = new Map(input.subscriptions.map((s) => [quotaSubscriptionKey(s), { ...s }]))
    const wasEnabled = this.state.enabled
    this.revision++
    this.state.enabled = input.enabled
    this.state.subscriptions = [...unique.values()]
    const selected = new Set(this.state.subscriptions.filter((s) => s.enabled).map(quotaSubscriptionKey))
    // Disabling and later re-enabling must seed a new pre-deadline baseline.
    // Otherwise a snapshot from a paused interval could create a fake early
    // reset, just as it could for rolling capacity recovery.
    this.state.deadlines = input.enabled && wasEnabled
      ? this.state.deadlines.filter((row) => selected.has(row.subscriptionKey) && !isRollingQuotaWindow(row))
      : []
    this.state.early = input.enabled && wasEnabled
      ? this.state.early.filter((row) => selected.has(row.subscriptionKey))
      : []
    // Re-enabling the service must not compare a current snapshot with a
    // previously disabled/stale baseline to fabricate a retrospective event.
    this.state.rolling = input.enabled && wasEnabled
      ? this.state.rolling.filter((row) => selected.has(row.subscriptionKey))
      : []
    await this.save()
    return this.status()
  }

  nextPollDelayMs(now: number) {
    if (!this.active()) return 30 * 60_000
    // The Go official snapshot cache has a 5-minute TTL; this service needs
    // independent observations of the rolling capacity (not reset estimates).
    // Never increase the poll frequency beyond that shared provider gate.
    const pollDelay = this.state.subscriptions.some((sub) => sub.enabled && isRollingQuotaWindow(sub))
      ? 5 * 60_000 + 2_000 : 10 * 60_000
    const earliest = this.state.deadlines.reduce((min, row) => Math.min(min, row.resetAt + 60_000), Infinity)
    if (!Number.isFinite(earliest)) return pollDelay
    if (earliest <= now) return Math.min(pollDelay, 5 * 60_000)
    return Math.min(pollDelay, earliest - now)
  }

  async acknowledge(id: string) {
    const before = this.state.deadlines.length
    this.state.deadlines = this.state.deadlines.filter((row) => row.id !== id)
    const pendingBefore = this.state.early.length
    this.state.early = this.state.early.filter((row) => row.id !== id)
    const rolling = this.state.rolling.find((row) => row.pending?.id === id)
    if (rolling) this.state.rolling = this.state.rolling.map((row) =>
      row === rolling ? { ...row, pending: undefined } : row,
    )
    if (this.state.deadlines.length !== before || this.state.early.length !== pendingBefore || rolling) await this.save()
  }

  async clear() {
    this.revision++
    this.state = { enabled: false, subscriptions: [], deadlines: [], rolling: [], early: [] }
    await this.save()
  }

  /** Called by the generic hub on one shared timer. Never starts its own. */
  async collect(now: number): Promise<readonly NotificationIntent[]> {
    if (!this.active()) return []
    const revision = this.revision
    // Poll only actually selected providers. Polling Go rolling quota every five
    // minutes must not accidentally scan every other configured provider.
    const providers = [...new Set(this.state.subscriptions.filter((sub) => sub.enabled).map((sub) => sub.providerId))]
    const agenda = await this.agenda(now, now + HORIZON, providers)
    if (revision !== this.revision || !this.active()) return []
    const selected = new Set(this.state.subscriptions.filter((s) => s.enabled).map(quotaSubscriptionKey))
    const earlyIds = new Set(this.state.early.map((row) => row.id))
    for (const baseline of this.state.deadlines) {
      if (!selected.has(baseline.subscriptionKey)) continue
      const recovery = detectEarlyQuotaRecovery(baseline, agenda, now)
      if (!recovery || earlyIds.has(recovery.id)) continue
      const target = [baseline.providerName, baseline.accountLabel, baseline.model]
        .map(safeMessagePart).filter(Boolean).join(" · ")
      const leadMs = recovery.expectedResetAt - recovery.observedAt
      const leadMinutes = Math.floor(leadMs / 60_000)
      const timing = leadMinutes >= 60
        ? `${Math.floor(leadMinutes / 60)}h ${leadMinutes % 60}m`
        : `${leadMinutes}m`
      const isReset = recovery.kind === "reset"
      this.state.early.push({
        id: recovery.id,
        subscriptionKey: baseline.subscriptionKey,
        text: [
          isReset ? "OpenFork · EARLY QUOTA RESET DETECTED" : "OpenFork · UNEXPECTED EARLY QUOTA REPLENISHMENT",
          target,
          `Window: ${safeMessagePart(baseline.windowKey)}`,
          `Available: ${percent(recovery.previousRemainingPercent)}% → ${percent(recovery.remainingPercent)}%`,
          `Detected at least ${timing} before expected reset.`,
          `Previously expected: ${new Date(recovery.expectedResetAt).toISOString()}`,
          isReset
            ? `Provider's new reset time: ${new Date(recovery.nextResetAt).toISOString()}`
            : "Provider's reset schedule has not advanced to a new period; this may be bonus capacity.",
        ].join("\n"),
      })
      earlyIds.add(recovery.id)
    }
    this.state.early = this.state.early.slice(-MAX_SUBSCRIPTIONS)
    this.state.deadlines = coalesceDeadlines([
      ...this.state.deadlines.filter((row) => selected.has(row.subscriptionKey)),
      ...quotaNotificationDeadlines({ agenda, subscriptions: this.state.subscriptions, now }),
    ], now)
    const rolling = new Map(this.state.rolling.filter((row) => selected.has(row.subscriptionKey))
      .map((row) => [row.subscriptionKey, row] as const))
    for (const observation of rollingObservations({ agenda, subscriptions: this.state.subscriptions, now })) {
      rolling.set(observation.subscriptionKey, observeRollingCapacity(rolling.get(observation.subscriptionKey), observation))
    }
    this.state.rolling = [...rolling.values()].slice(0, MAX_SUBSCRIPTIONS)
    // Persist the pre-deadline observation before emitting, so restart cannot
    // turn a new post-deadline snapshot into a false historical baseline.
    await this.save()
    if (revision !== this.revision || !this.active()) return []
    const notices: NotificationIntent[] = []
    for (const row of this.state.deadlines) {
      if (row.resetAt + 60_000 > now) continue
      const target = [row.providerName, row.accountLabel, row.model].map(safeMessagePart).filter(Boolean).join(" · ")
      const windowLabel = safeMessagePart(row.windowKey)
      if (row.source !== "provider") {
        // Reminder only. Inferred/observed/provider-expiry schedules must NEVER
        // be presented as proof that request capacity actually replenished.
        notices.push({
          id: row.id,
          text: `OpenFork · expected quota reset time reached (unverified)\n${target}\nWindow: ${windowLabel}\nExpected: ${new Date(row.resetAt).toISOString()}\nCheck the provider before assuming capacity is restored.`,
        })
        continue
      }
      const result = verifyQuotaReset(row, agenda, now)
      if (result.state !== "confirmed") continue
      notices.push({
        id: row.id,
        text: `OpenFork · quota reset confirmed\n${target}\nWindow: ${windowLabel}\nNext reset: ${new Date(result.nextResetAt).toISOString()}`,
      })
    }
    for (const row of this.state.rolling) {
      if (row.pending) notices.push(row.pending)
    }
    notices.push(...this.state.early)
    return notices
  }
}
