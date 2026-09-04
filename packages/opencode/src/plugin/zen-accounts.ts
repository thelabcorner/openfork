import { createHash } from "crypto"

export type ZenAccountSource = "env" | "vault"

export type ZenAccountState = "READY" | "COOLING_DOWN" | "QUOTA_EXHAUSTED"

export type ZenAccount = {
  id: string
  label: string
  apiKey: string
  source: ZenAccountSource
  isDefault: boolean
}

export type ZenEnvCredential = {
  apiKey: string
  source: "env"
  path: string
}

export type ZenVaultCredential = {
  /** Vault DB primary key (uuid) — distinct from the routing id derived below. */
  vaultId: string
  apiKey: string
  label?: string
  isDefault?: boolean
}

const ENV_NUMBERED_MAX = 10

/**
 * Stable account identity derived only from the key, shared by env keys and
 * vault keys so the same physical key never produces two routing ids
 * regardless of where it is declared.
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

type FailureState = { state: ZenAccountState; resetAt: number | undefined }

/**
 * Unified key pool for both "opencode" (Zen free) and "opencode-go" (Go paid)
 * providers, which share the same physical `OPENCODE_API_KEY` env keys plus
 * fork-vault keys. Deliberately simple: no session affinity, no learned
 * cooldown windows, no persistence — mirrors how verdent/workbuddy bind one
 * key per session, except here the "session" is the model's account suffix,
 * resolved once per request by the caller.
 *
 * In-memory 402/429 tracking is best-effort and process-local; a restart
 * clears it, which is fine because upstream re-teaches it within one request.
 */
export class ZenAccountPool {
  private accounts = new Map<string, ZenAccount>()
  private failures = new Map<string, FailureState>()

  /** Rebuild the pool from current env + the vault credentials passed in. */
  sync(vaultCredentials: ZenVaultCredential[] = []): ZenAccount[] {
    const next = new Map<string, ZenAccount>()
    const envCredentials = zenEnvCredentials()
    for (const credential of envCredentials) {
      const id = stableZenIdentity(credential.apiKey)
      if (next.has(id)) continue
      next.set(id, {
        id,
        label: `key-${id.slice(4, 12)}`,
        apiKey: credential.apiKey,
        source: "env",
        isDefault: next.size === 0,
      })
    }
    let vaultDefaultTaken = false
    for (const credential of vaultCredentials) {
      const id = stableZenIdentity(credential.apiKey)
      if (next.has(id)) continue
      // Env keys always take default precedence (first-declared wins); among
      // vault-only pools, honor the caller-designated default wherever it sits.
      const flagDefault = envCredentials.length === 0 && (credential.isDefault ?? false) && !vaultDefaultTaken
      if (flagDefault) vaultDefaultTaken = true
      next.set(id, {
        id,
        label: credential.label?.trim() || `key-${id.slice(4, 12)}`,
        apiKey: credential.apiKey,
        source: "vault",
        isDefault: flagDefault,
      })
    }
    // If nothing was marked default (e.g. all-vault pool with no default
    // flag set), fall back to the first account in insertion order.
    if (next.size > 0 && ![...next.values()].some((account) => account.isDefault)) {
      const first = next.values().next().value as ZenAccount
      first.isDefault = true
    }
    this.accounts = next
    return [...next.values()]
  }

  all(): ZenAccount[] {
    return [...this.accounts.values()]
  }

  get(id: string): ZenAccount | undefined {
    return this.accounts.get(id)
  }

  defaultAccount(): ZenAccount | undefined {
    return this.all().find((account) => account.isDefault) ?? this.all()[0]
  }

  /** Record a non-ok response's status against the account for display purposes only. */
  observe(accountId: string, status: number, resetAt: number | undefined) {
    if (status === 402) {
      this.failures.set(accountId, { state: "QUOTA_EXHAUSTED", resetAt: undefined })
      return
    }
    if (status === 429) {
      this.failures.set(accountId, { state: "COOLING_DOWN", resetAt })
      return
    }
    if (status >= 200 && status < 300) {
      this.failures.delete(accountId)
    }
  }

  state(accountId: string, now = Date.now()): FailureState {
    const failure = this.failures.get(accountId)
    if (!failure) return { state: "READY", resetAt: undefined }
    if (failure.state === "COOLING_DOWN" && failure.resetAt !== undefined && now >= failure.resetAt) {
      this.failures.delete(accountId)
      return { state: "READY", resetAt: undefined }
    }
    return failure
  }

  snapshot(now = Date.now()) {
    return this.all().map((account) => {
      const { state, resetAt } = this.state(account.id, now)
      return {
        accountId: account.id,
        label: account.label,
        source: account.source,
        isDefault: account.isDefault,
        state,
        resetAt: resetAt ?? null,
      }
    })
  }
}
