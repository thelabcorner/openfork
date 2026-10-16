import { randomBytes } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type { Auth } from "@/auth"
import { createTelegramBotAPI, telegramPairingUrl, TelegramBotError } from "./transport"

/**
 * Telegram is the generic destination and delivery owner. Source plugins are
 * deliberately ignorant of chat IDs, bot credentials, polling and HTTP.
 */
export type NotificationIntent = {
  /** Stable identity across restarts; unique within its source service. */
  readonly id: string
  readonly text: string
}
export type NotificationSource = {
  readonly id: string
  readonly title: string
  initialize(): Promise<void>
  active(): boolean
  collect(now: number): Promise<readonly NotificationIntent[]>
  /** Optional source-owned cursor advancement once the hub has claimed an event. */
  acknowledge?(id: string): Promise<void>
  /** Delay before next shared scan; no source can install its own timer. */
  nextPollDelayMs?(now: number): number
  clear(): Promise<void>
}
export type TelegramConnectionStatus = {
  enabled: boolean
  configured: boolean
  connected: boolean
  botUsername?: string
  chatLabel?: string
  pairingUrl?: string
  pairingExpiresAt?: number
  owner: boolean
  services: { id: string; title: string; enabled: boolean }[]
  error?: string
  lastAttemptAt?: number
  lastSuccessAt?: number
}

type State = {
  enabled: boolean
  botUsername?: string
  chatId?: number
  chatLabel?: string
  updateOffset: number
  delivered: Record<string, number>
  lastAttemptAt?: number
  lastSuccessAt?: number
  retryAt?: number
}
type Pairing = { nonce: string; expiresAt: number }

const TOKEN_KEY = "openfork-telegram"
const FILE = path.join(Global.Path.data, "telegram-notifications.json")
const LOCK = path.join(Global.Path.data, "telegram-notifications.owner")
const INTERVAL_MS = 30 * 60_000
const RECHECK_MS = 5 * 60_000
const MAX_RECEIPTS = 3000
const MAX_AGE_MS = 60 * 86400_000
const MAX_NOTICES_PER_TICK = 40

function empty(): State {
  return { enabled: false, updateOffset: 0, delivered: {} }
}
function readState(raw: unknown): State {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty()
  const o = raw as Record<string, unknown>
  const delivered: Record<string, number> = {}
  if (o.delivered && typeof o.delivered === "object" && !Array.isArray(o.delivered)) {
    for (const [id, time] of Object.entries(o.delivered)) {
      if (id.length > 4096 || typeof time !== "number" || !Number.isFinite(time) ||
          time < Date.now() - MAX_AGE_MS || time > Date.now() + 60_000) continue
      delivered[id] = time
      if (Object.keys(delivered).length === MAX_RECEIPTS) break
    }
  }
  return {
    enabled: o.enabled === true,
    ...(typeof o.botUsername === "string" ? { botUsername: o.botUsername } : {}),
    ...(typeof o.chatId === "number" && Number.isSafeInteger(o.chatId) ? { chatId: o.chatId } : {}),
    ...(typeof o.chatLabel === "string" ? { chatLabel: o.chatLabel } : {}),
    updateOffset: typeof o.updateOffset === "number" && Number.isSafeInteger(o.updateOffset) && o.updateOffset >= 0
      ? o.updateOffset : 0,
    delivered,
    ...(typeof o.lastAttemptAt === "number" ? { lastAttemptAt: o.lastAttemptAt } : {}),
    ...(typeof o.lastSuccessAt === "number" ? { lastSuccessAt: o.lastSuccessAt } : {}),
    ...(typeof o.retryAt === "number" && Number.isFinite(o.retryAt) && o.retryAt > 0 && o.retryAt < Date.now() + 86400_000 ? { retryAt: o.retryAt } : {}),
  }
}
async function saveAtomic(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temp = `${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" })
    await fs.chmod(temp, 0o600)
    await fs.rename(temp, filename)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

/**
 * One hub per served process. It owns exactly one timer for arbitrarily many
 * notification sources, and performs zero polling/network work when disabled.
 *
 * Semantics are at-most-once for uncertain sends. An acknowledged 429 can be
 * retried; an HTTP timeout after Telegram accepted a POST cannot be retried
 * safely without creating duplicates, because sendMessage has no idempotency key.
 */
export class TelegramNotificationHub {
  private state: State = empty()
  private pending?: Pairing
  private timer?: ReturnType<typeof setTimeout>
  private inFlight?: Promise<void>
  private pairingPoll?: Promise<TelegramConnectionStatus>
  private writeTail: Promise<void> = Promise.resolve()
  private pairingGeneration = 0
  private nextSourceOffset = 0
  private owner = false
  private ownerNonce?: string
  private releasing: Promise<void> = Promise.resolve()
  private generation = 0
  private error?: string
  private disposed = false

  constructor(
    private readonly auth: Auth.Interface,
    readonly sources: readonly NotificationSource[],
    private readonly options: {
      readonly stateFile?: string
      readonly ownerFile?: string
      readonly api?: typeof createTelegramBotAPI
      readonly intervalMs?: number
    } = {},
  ) {
    if (new Set(sources.map((s) => s.id)).size !== sources.length) {
      throw new Error("Duplicate Telegram notification source identifier")
    }
  }

  private get file() { return this.options.stateFile ?? FILE }
  private get ownerFile() { return this.options.ownerFile ?? LOCK }
  private api(token: string) { return (this.options.api ?? createTelegramBotAPI)(token) }

  async initialize() {
    for (const source of this.sources) await source.initialize()
    try {
      this.state = readState(JSON.parse(await fs.readFile(this.file, "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.error = "Could not load Telegram notification configuration"
      }
    }
    if (this.state.enabled) await this.refresh()
  }

  private save() {
    const snapshot = structuredClone(this.state)
    const task = this.writeTail.catch(() => undefined).then(() => saveAtomic(this.file, snapshot))
    this.writeTail = task
    return task
  }

  private async token() {
    const record = await Effect.runPromise(this.auth.get(TOKEN_KEY))
    return record?.type === "api" ? record.key : undefined
  }

  async status(): Promise<TelegramConnectionStatus> {
    const configured = Boolean(await this.token())
    return {
      enabled: this.state.enabled,
      configured,
      connected: configured && Number.isSafeInteger(this.state.chatId),
      ...(this.state.botUsername ? { botUsername: this.state.botUsername } : {}),
      ...(this.state.chatLabel ? { chatLabel: this.state.chatLabel } : {}),
      ...(this.pending && this.pending.expiresAt > Date.now() && this.state.botUsername
        ? {
          pairingUrl: telegramPairingUrl(this.state.botUsername, this.pending.nonce),
          pairingExpiresAt: this.pending.expiresAt,
        }
        : {}),
      owner: this.owner,
      services: this.sources.map((source) => ({ id: source.id, title: source.title, enabled: source.active() })),
      ...(this.error ? { error: this.error } : {}),
      ...(this.state.lastAttemptAt ? { lastAttemptAt: this.state.lastAttemptAt } : {}),
      ...(this.state.lastSuccessAt ? { lastSuccessAt: this.state.lastSuccessAt } : {}),
    }
  }

  async configure(botToken: string) {
    const generation = ++this.pairingGeneration
    const identity = await this.api(botToken).identity()
    if (this.pairingGeneration !== generation) throw new Error("Bot configuration superseded")
    this.stop()
    // Revoke the old destination and master enablement BEFORE rotating the
    // secret. A crash between these writes must never allow a newly configured
    // bot to inherit the previous bot's linked chat or delivery receipts.
    this.state = empty()
    this.pending = undefined
    await this.save()
    // Credential authority remains the existing local Auth vault. Its file
    // permissions are restricted, but this is NOT OS hardware-backed encryption.
    await Effect.runPromise(this.auth.set(TOKEN_KEY, { type: "api", key: botToken }))
    this.state.botUsername = identity.username
    this.error = undefined
    await this.save()
    return this.status()
  }

  async disconnect() {
    this.pairingGeneration++
    this.stop()
    this.pending = undefined
    this.state = empty()
    await this.save()
    await Effect.runPromise(this.auth.remove(TOKEN_KEY))
    for (const source of this.sources) await source.clear()
    return this.status()
  }

  async beginPairing() {
    const generation = this.pairingGeneration
    if (!(await this.token()) || !this.state.botUsername) throw new Error("Configure a Telegram bot before pairing")
    if (this.pairingGeneration !== generation) throw new Error("Pairing superseded")
    this.pairingGeneration++
    this.pending = { nonce: randomBytes(24).toString("base64url"), expiresAt: Date.now() + 300_000 }
    return this.status()
  }

  async checkPairing(): Promise<TelegramConnectionStatus> {
    if (this.pairingPoll) return this.pairingPoll
    const run = this.pollOnce()
    this.pairingPoll = run
    try {
      return await run
    } catch (error) {
      if (error instanceof TelegramBotError && error.status === 409) {
        this.error = "Bot pairing unavailable: Telegram does not support getUpdates while another webhook is active"
      } else {
        this.error = "Telegram pairing check failed"
      }
      throw error
    } finally {
      if (this.pairingPoll === run) this.pairingPoll = undefined
    }
  }

  private async pollOnce() {
    const pending = this.pending
    const generation = this.pairingGeneration
    if (!pending || Date.now() >= pending.expiresAt) {
      this.pending = undefined
      throw new Error("Telegram pairing expired")
    }
    const token = await this.token()
    if (!token) throw new Error("Telegram bot not configured")
    const result = await this.api(token).readPairing(pending.nonce, this.state.updateOffset)
    if (generation !== this.pairingGeneration || this.pending !== pending || pending.expiresAt <= Date.now()) {
      throw new Error("Pairing no longer active")
    }
    this.state.updateOffset = result.offset
    if ("chat" in result) {
      this.stop()
      this.state.chatId = result.chat.id
      this.state.chatLabel = result.chat.username || result.chat.firstName || "Private Telegram chat"
      this.state.enabled = false
      this.state.delivered = {}
      this.pending = undefined
      this.error = undefined
    }
    await this.save()
    return this.status()
  }

  async setEnabled(enabled: boolean) {
    if (enabled && (!(await this.token()) || !Number.isSafeInteger(this.state.chatId))) {
      throw new Error("Pair a private Telegram chat before enabling notifications")
    }
    this.state.enabled = enabled
    await this.save()
    await this.refresh()
    return this.status()
  }

  async sendTest() {
    const token = await this.token()
    if (!token || !Number.isSafeInteger(this.state.chatId)) throw new Error("Pair a private Telegram chat first")
    await this.api(token).sendText(this.state.chatId!, "OpenFork · Telegram notifications connected. Test successful.")
    return this.status()
  }

  /** Called after a source's own settings changed. */
  async refresh() {
    if (this.disposed || !this.state.enabled || !this.sources.some((source) => source.active())) {
      this.stop()
      return
    }
    if (await this.acquireOwner()) {
      // Disabling or disconnecting can race with a pending owner acquire.
      if (this.disposed || !this.state.enabled || !this.sources.some((source) => source.active())) {
        this.stop()
        return
      }
      this.schedule(0)
    }
  }

  private async acquireOwner() {
    if (this.owner) return true
    // A disable/enable transition must not race its own asynchronous unlink.
    await this.releasing
    await fs.mkdir(path.dirname(this.ownerFile), { recursive: true })
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const nonce = randomBytes(20).toString("hex")
        await fs.writeFile(this.ownerFile, JSON.stringify({ pid: process.pid, at: Date.now(), nonce }), { flag: "wx", mode: 0o600 })
        this.ownerNonce = nonce
        this.owner = true
        this.error = undefined
        return true
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause
        let record: { pid?: number }
        try { record = JSON.parse(await fs.readFile(this.ownerFile, "utf8")) as { pid?: number } }
        catch { this.error = "Telegram notification owner lock unavailable"; return false }
        if (record.pid === process.pid) {
          this.error = "Telegram notifications are already active in this process"
          return false
        }
        if (typeof record.pid === "number") {
          try { process.kill(record.pid, 0); this.error = "Another OpenFork process owns Telegram notifications"; return false }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return false }
        }
        // Only a positively dead owning process can be reclaimed.
        await fs.rm(this.ownerFile, { force: true })
      }
    }
    return false
  }

  private stop() {
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.owner) return
    const nonce = this.ownerNonce
    this.owner = false
    this.ownerNonce = undefined
    const filename = this.ownerFile
    this.releasing = this.releasing.catch(() => undefined).then(async () => {
      if (!nonce) return
      try {
        const stored = JSON.parse(await fs.readFile(filename, "utf8")) as { nonce?: string }
        // Never release a newer owner that acquired the same pathname.
        if (stored.nonce === nonce) await fs.rm(filename, { force: true })
      } catch {
        // A vanished or malformed file belongs to no verified prior owner.
      }
    })
  }

  dispose() {
    this.disposed = true
    this.stop()
    this.pending = undefined
  }

  private schedule(delayMs: number) {
    if (this.timer) clearTimeout(this.timer)
    if (this.disposed || !this.state.enabled || !this.owner) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().catch(() => {
        this.error = "Notification sources unavailable; retrying"
        this.schedule(this.options.intervalMs ?? RECHECK_MS)
      })
    }, Math.max(0, Math.min(this.options.intervalMs ?? INTERVAL_MS, delayMs)))
    this.timer.unref?.()
  }

  private async tick() {
    if (this.inFlight) return this.inFlight
    const run = this.cycle()
    this.inFlight = run
    try { await run } finally { if (this.inFlight === run) this.inFlight = undefined }
  }

  private async cycle() {
    if (!this.owner || !this.state.enabled) return
    const chatId = this.state.chatId
    const token = await this.token()
    if (!Number.isSafeInteger(chatId) || !token) {
      this.error = "Telegram destination unavailable"
      this.stop()
      return
    }
    const generation = this.generation
    const now = Date.now()
    if (this.state.retryAt && this.state.retryAt > now) {
      this.schedule(this.state.retryAt - now)
      return
    }
    this.state.retryAt = undefined
    let attempted = 0
    let throttled = false
    let backlog = false
    const activeSources = this.sources.filter((source) => source.active())
    const start = activeSources.length > 0 ? this.nextSourceOffset++ % activeSources.length : 0
    const ordered = activeSources.slice(start).concat(activeSources.slice(0, start))
    const perSource = Math.max(1, Math.floor(MAX_NOTICES_PER_TICK / Math.max(1, ordered.length)))
    for (const source of ordered) {
      if (!this.owner || !this.state.enabled) return
      if (!source.active()) continue
      let notices: readonly NotificationIntent[]
      try { notices = await source.collect(now) }
      catch { this.error = `Notification source ${source.id} unavailable`; continue }
      if (generation !== this.generation || !this.owner || !this.state.enabled || !source.active()) return
      const allowance = Math.min(perSource, MAX_NOTICES_PER_TICK - attempted)
      if (notices.length > allowance) backlog = true
      for (const intent of notices.slice(0, allowance)) {
        if (!this.owner || !this.state.enabled) return
        if (!source.active()) break
        if (!intent.id || intent.id.length > 3000 || !intent.text || intent.text.length > 4096) continue
        const key = JSON.stringify([String(chatId), source.id, intent.id])
        if (this.state.delivered[key]) {
          await source.acknowledge?.(intent.id)
          continue
        }
        // Claim before sending: a timeout cannot distinguish success from failure.
        this.state.delivered[key] = Date.now()
        this.state.lastAttemptAt = Date.now()
        try {
          await this.save()
        } catch (error) {
          // No outbound call has occurred. Undo the failed durable claim so
          // a later successful write can still deliver this notification.
          delete this.state.delivered[key]
          throw error
        }
        // A settings mutation or owner change can occur while the receipt is
        // being durably written. Never send under a revoked generation.
        if (generation !== this.generation || !this.owner || !this.state.enabled || !source.active()) return
        attempted++
        try {
          await this.api(token).sendText(chatId!, intent.text)
          this.state.lastSuccessAt = Date.now()
          this.error = undefined
          // Source checkpoint failure must not turn a confirmed successful
          // send into a false Telegram delivery failure. The durable hub
          // receipt will suppress duplicates on the next source scan.
          try {
            await source.acknowledge?.(intent.id)
          } catch {
            this.error = `Notification source ${source.id} checkpoint unavailable`
          }
        } catch (error) {
          if (error instanceof TelegramBotError && error.status === 429) {
            delete this.state.delivered[key]
            this.state.retryAt = Date.now() + Math.max(1_000, (error.retryAfterSeconds ?? 60) * 1000)
            throttled = true
            this.error = "Telegram rate limited notifications"
          } else if (error instanceof TelegramBotError && (error.status === 401 || error.status === 403)) {
            // A revoked token or blocked chat will not recover through more
            // outbound sends. Disable the master switch until explicitly fixed.
            this.state.enabled = false
            this.error = error.status === 403
              ? "Telegram notifications disabled: the bot cannot message this private chat"
              : "Telegram notifications disabled: the bot token is no longer authorized"
            await source.acknowledge?.(intent.id)
            this.stop()
          } else {
            this.error = "Telegram message delivery failed or is unconfirmed"
            await source.acknowledge?.(intent.id)
          }
        }
        await this.save()
        if (throttled || attempted >= MAX_NOTICES_PER_TICK) break
      }
      if (throttled || attempted >= MAX_NOTICES_PER_TICK) break
    }
    const entries = Object.entries(this.state.delivered)
    if (entries.length > MAX_RECEIPTS || entries.some(([, time]) => time < now - MAX_AGE_MS)) {
      this.state.delivered = Object.fromEntries(
        entries.filter(([, time]) => time >= now - MAX_AGE_MS)
          .sort((a, b) => b[1] - a[1]).slice(0, MAX_RECEIPTS),
      )
      await this.save()
    }
    const delay = Math.min(
      this.options.intervalMs ?? INTERVAL_MS,
      ...this.sources.filter((source) => source.active()).map((source) => {
        const requested = source.nextPollDelayMs?.(Date.now())
        return typeof requested === "number" && Number.isFinite(requested) && requested >= 0
          ? requested
          : this.options.intervalMs ?? INTERVAL_MS
      }),
    )
    this.schedule(throttled && this.state.retryAt
      ? Math.max(0, this.state.retryAt - Date.now())
      : attempted >= MAX_NOTICES_PER_TICK || (backlog && attempted > 0) ? 2_000 : delay)
  }
}
