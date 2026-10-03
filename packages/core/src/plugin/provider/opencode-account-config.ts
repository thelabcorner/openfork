import { Effect, Schema, Semaphore } from "effect"
import { HttpClient } from "effect/unstable/http"
import type { Credential } from "../../credential"
import { ConfigV1 } from "../../v1/config/config"
import { DEFAULT_SERVER, getProviderConfig } from "./opencode-console"

export interface FetchInput {
  readonly server: string
  readonly accessToken: string
  readonly orgID?: string
}

export type FetchRemoteConfig<E> = (input: FetchInput) => Effect.Effect<Record<string, unknown> | undefined, E>

/** Production fetch adapter. P1 remains the sole owner of Console wire semantics. */
export const consoleConfigFetcher = (http: HttpClient.HttpClient): FetchRemoteConfig<unknown> =>
  ({ server, accessToken, orgID }) => getProviderConfig(http, server, accessToken, orgID)

export interface ResolveInput {
  /** Authority/isolation realm. Never reuse this across mutually untrusted realms. */
  readonly scope: string
  readonly credentialID: Credential.ID
  readonly revision: number
  readonly value: Credential.Value
}

export interface Snapshot {
  readonly scope: string
  readonly credentialID: Credential.ID
  readonly credentialRevision: number
  readonly server: string
  readonly orgID?: string
  /** Monotonic only within one stable (scope, credential, server, org) slot. */
  readonly version: number
  readonly fetchedAt: number
  readonly expiresAt: number
  /** Decoded remote config; credential secret material is rejected before retention. */
  readonly config?: Schema.Schema.Type<typeof ConfigV1.Info>
}

export interface Options<E> {
  readonly fetch: FetchRemoteConfig<E>
  readonly ttlMs?: number
  readonly maxEntries?: number
  readonly now?: () => number
}

interface Entry {
  readonly revision: number
  readonly version: number
  readonly fetchedAt: number
  readonly expiresAt: number
  readonly server: string
  readonly orgID?: string
  readonly config?: Schema.Schema.Type<typeof ConfigV1.Info>
}

interface Slot {
  readonly lock: ReturnType<typeof Semaphore.makeUnsafe>
  entry?: Entry
  lastUsed: number
}

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_MAX_ENTRIES = 64

/**
 * Realm-owned, account-scoped cache for OpenCode Console /api/config.
 *
 * This is deliberately a factory rather than a process-global singleton.
 * Standalone may own one instance for its implicit local realm; hosted callers
 * must own one per authority realm. Secret refresh stays in CredentialResolver:
 * callers pass the exact resolved value + trusted revision.
 */
export function makeAccountConfigCache<E>(options: Options<E>) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const now = options.now ?? Date.now
  const slots = new Map<string, Slot>()

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be positive")
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error("maxEntries must be a positive integer")

  const slotKey = (input: ResolveInput, server: string, orgID: string | undefined) =>
    JSON.stringify([input.scope, input.credentialID, server, orgID ?? null])

  const metadata = (value: Credential.Value) => {
    const server =
      typeof value.metadata?.server === "string" && value.metadata.server.trim()
        ? value.metadata.server
        : DEFAULT_SERVER
    const orgID =
      typeof value.metadata?.orgID === "string" && value.metadata.orgID.trim() ? value.metadata.orgID : undefined
    return { server, orgID }
  }

  const token = (value: Credential.Value) => (value.type === "oauth" ? value.access : value.key)

  const credentialSecrets = (value: Credential.Value) =>
    value.type === "oauth" ? [value.access, value.refresh] : [value.key]

  const containsCredentialSecret = (value: unknown, secrets: readonly string[]): boolean => {
    if (typeof value === "string") {
      return secrets.some((secret) => secret.length > 0 && value.includes(secret))
    }
    if (Array.isArray(value)) return value.some((item) => containsCredentialSecret(item, secrets))
    if (!value || typeof value !== "object") return false
    return Object.values(value).some((item) => containsCredentialSecret(item, secrets))
  }

  const prune = (keep: string) => {
    if (slots.size <= maxEntries) return
    const victims = [...slots.entries()]
      .filter(([key]) => key !== keep)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    while (slots.size > maxEntries && victims.length > 0) {
      const [key] = victims.shift()!
      slots.delete(key)
    }
  }

  const project = (input: ResolveInput, entry: Entry): Snapshot => ({
    scope: input.scope,
    credentialID: input.credentialID,
    credentialRevision: entry.revision,
    server: entry.server,
    ...(entry.orgID ? { orgID: entry.orgID } : {}),
    version: entry.version,
    fetchedAt: entry.fetchedAt,
    expiresAt: entry.expiresAt,
    ...(entry.config ? { config: entry.config } : {}),
  })

  const resolve = (input: ResolveInput): Effect.Effect<Snapshot, E> => {
    const { server, orgID } = metadata(input.value)
    const key = slotKey(input, server, orgID)
    let slot = slots.get(key)
    if (!slot) {
      slot = { lock: Semaphore.makeUnsafe(1), lastUsed: now() }
      slots.set(key, slot)
      prune(key)
    }
    slot.lastUsed = now()

    return slot.lock.withPermit(
      Effect.gen(function* () {
        const current = now()
        const cached = slot!.entry
        if (cached && cached.revision === input.revision && current < cached.expiresAt) {
          slot!.lastUsed = current
          return project(input, cached)
        }

        const secret = token(input.value)
        const remote = yield* options.fetch({ server, accessToken: secret, orgID })
        if (remote !== undefined && containsCredentialSecret(remote, credentialSecrets(input.value))) {
          return yield* Effect.die(new Error("OpenCode Console /api/config contained credential secret material"))
        }

        const config =
          remote === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(ConfigV1.Info)(remote).pipe(Effect.orDie)
        const fetchedAt = now()
        const entry: Entry = {
          revision: input.revision,
          version: (cached?.version ?? 0) + 1,
          fetchedAt,
          expiresAt: fetchedAt + ttlMs,
          server,
          orgID,
          ...(config ? { config } : {}),
        }
        slot!.entry = entry
        slot!.lastUsed = fetchedAt
        return project(input, entry)
      }),
    )
  }

  const invalidate = (input: Pick<ResolveInput, "scope" | "credentialID">) => {
    for (const key of [...slots.keys()]) {
      const parsed = JSON.parse(key) as [string, string, string, string | null]
      if (parsed[0] === input.scope && parsed[1] === input.credentialID) slots.delete(key)
    }
  }

  return {
    resolve,
    invalidate,
    size: () => slots.size,
  }
}
