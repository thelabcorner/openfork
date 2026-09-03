import { createHash } from "crypto"
import { mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ZenGovernor } from "./zen-governor"

export type ZenAccountSource = "env"

export type ZenAccount = {
  id: string
  label: string
  apiKey: string
  governor: ZenGovernor
  source: ZenAccountSource
  mtime: number
  everUsed: boolean
}

export type ZenRegistryOptions = {
  persistenceDir?: string
}

export type ZenSelection = {
  account: ZenAccount
  bound: boolean
  reason: "explicit" | "affinity" | "automatic"
}

export type ZenEnvCredential = {
  apiKey: string
  source: ZenAccountSource
  path: string
}

const ENV_NUMBERED_MAX = 10

/**
 * Stable account identity derived only from the key: logs, bindings, and
 * persisted governor state address accounts without ever exposing the raw
 * secret (mirrors stableVerdentIdentity).
 */
export function stableZenIdentity(apiKey: string): string {
  const hash = createHash("sha256").update(apiKey).digest("hex")
  return `zen-${hash.slice(0, 12)}`
}

function pushEnvKey(raw: string | undefined, path: string, out: ZenEnvCredential[]) {
  if (!raw) return
  const value = raw.trim()
  if (!value) return
  for (const part of value.split(",")) {
    const key = part.trim().replace(/^"+|"+$/g, "")
    if (!key) continue
    out.push({ apiKey: key, source: "env", path })
  }
}

export function zenEnvCredentials(env: Record<string, string | undefined> = process.env): ZenEnvCredential[] {
  const out: ZenEnvCredential[] = []
  pushEnvKey(env.OPENCODE_API_KEY, "OPENCODE_API_KEY", out)
  pushEnvKey(env.OPENCODE_API_KEYS, "OPENCODE_API_KEYS", out)
  for (let i = 2; i <= ENV_NUMBERED_MAX; i++) {
    pushEnvKey(env[`OPENCODE_API_KEY_${i}`], `OPENCODE_API_KEY_${i}`, out)
  }
  return out
}

export class ZenRegistry {
  private readonly persistenceDir: string
  private accountsById = new Map<string, ZenAccount>()
  private discoveredAt = 0

  constructor(options: ZenRegistryOptions = {}) {
    this.persistenceDir = options.persistenceDir ?? join(tmpdir(), "opencode-zen-accounts")
    mkdirSync(this.persistenceDir, { recursive: true })
  }

  persistenceFile(accountId: string): string {
    return join(this.persistenceDir, `${accountId}-zen-governor.json`)
  }

  private accountFrom(credential: ZenEnvCredential): ZenAccount {
    const id = stableZenIdentity(credential.apiKey)
    const prior = this.accountsById.get(id)
    if (prior) {
      prior.mtime = Date.now()
      return prior
    }
    return {
      id,
      label: `key-${id.slice(4, 12)}`,
      apiKey: credential.apiKey,
      governor: new ZenGovernor({ persistenceFile: this.persistenceFile(id) }),
      source: credential.source,
      mtime: Date.now(),
      everUsed: false,
    }
  }

  discover(): ZenAccount[] {
    const now = Date.now()
    if (now - this.discoveredAt < 1000) return [...this.accountsById.values()]
    const next = new Map<string, ZenAccount>()
    for (const credential of zenEnvCredentials()) {
      const id = stableZenIdentity(credential.apiKey)
      if (next.has(id)) continue
      next.set(id, this.accountFrom(credential))
    }
    this.accountsById = next
    this.discoveredAt = now
    return [...next.values()]
  }

  all(): ZenAccount[] {
    return this.discover()
  }

  get(id: string): ZenAccount | undefined {
    this.discover()
    return this.accountsById.get(id)
  }

  snapshot() {
    return this.all().map((account) => ({
      id: account.id,
      label: account.label,
      source: account.source,
      everUsed: account.everUsed,
      governor: account.governor.metrics(),
    }))
  }
}

export class ZenRouter {
  private readonly registry: ZenRegistry
  private bindings = new Map<string, string>()

  constructor(options: { registry: ZenRegistry }) {
    this.registry = options.registry
  }

  bind(session: string, accountId: string): ZenAccount | undefined {
    const account = this.registry.get(accountId)
    if (!account) return undefined
    this.bindings.set(session, account.id)
    account.everUsed = true
    return account
  }

  unbind(session: string) {
    this.bindings.delete(session)
  }

  binding(session: string): string | undefined {
    return this.bindings.get(session)
  }

  /**
   * Failover queue: (1) already-used keys first, ordered by resetAt ascending
   * so the soonest-resetting key serves next; (2) never-used keys always last
   * in reserve. Front-loads keys closest to reset — deliberately NOT load
   * balancing; there is no per-key concurrency signal worth balancing on.
   */
  failoverOrder(accounts: ZenAccount[], now = Date.now()): ZenAccount[] {
    return [...accounts].sort((a, b) => {
      const aUsed = a.everUsed ? 0 : 1
      const bUsed = b.everUsed ? 0 : 1
      if (aUsed !== bUsed) return aUsed - bUsed
      const ar = a.governor.currentResetAt(now) ?? 0
      const br = b.governor.currentResetAt(now) ?? 0
      return ar - br || a.id.localeCompare(b.id)
    })
  }

  select(session: string, requestedModel: string, explicitAccountId?: string): ZenSelection | undefined {
    const now = Date.now()
    const accounts = this.registry.all()
    if (explicitAccountId) {
      const account = accounts.find((item) => item.id === explicitAccountId)
      if (!account) return undefined
      this.bindings.set(session, account.id)
      account.everUsed = true
      return { account, bound: true, reason: "explicit" }
    }

    const existing = this.bindings.get(session)
    let failedOver = false
    if (existing) {
      const account = accounts.find((item) => item.id === existing)
      if (!account) {
        this.bindings.delete(session)
      } else if (account.governor.usable(now)) {
        return { account, bound: true, reason: "affinity" }
      } else {
        this.unbind(session)
        failedOver = true
      }
    }

    const eligible = accounts.filter((account) => account.governor.usable(now))
    if (eligible.length === 0) {
      // Every key is cooling down or exhausted: fail over to the least-bad key
      // by earliest reset and let upstream re-teach the governor.
      const leastBad = [...accounts].sort((a, b) => {
        const ar = a.governor.currentResetAt(now) ?? Number.POSITIVE_INFINITY
        const br = b.governor.currentResetAt(now) ?? Number.POSITIVE_INFINITY
        return ar - br || a.id.localeCompare(b.id)
      })[0]
      if (!leastBad) return undefined
      leastBad.everUsed = true
      this.bindings.set(session, leastBad.id)
      return { account: leastBad, bound: true, reason: "automatic" }
    }

    // Failover rebinds through the two-rule queue: already-used keys first,
    // ordered by resetAt ascending, never-used keys held last in reserve.
    // A session binding for the first time instead brings a reserve key into
    // service — parallelism is different sessions holding different keys, so
    // untouched keys are preferred for new bindings.
    const pool = failedOver
      ? this.failoverOrder(eligible, now)
      : this.failoverOrder(
          eligible.filter((account) => !account.everUsed).length > 0
            ? eligible.filter((account) => !account.everUsed)
            : eligible,
          now,
        )
    const account = pool[0]
    account.everUsed = true
    this.bindings.set(session, account.id)
    return { account, bound: true, reason: "automatic" }
  }

  bindingsSnapshot() {
    return [...this.bindings.entries()].map(([session, account]) => ({ session, account }))
  }
}
