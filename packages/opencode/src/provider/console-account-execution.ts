import { Duration, Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Credential } from "@opencode-ai/core/credential"
import * as CredentialResolver from "@opencode-ai/core/credential/resolver"
import {
  consoleConfigFetcher,
  makeAccountConfigCache,
  type Snapshot,
} from "@opencode-ai/core/plugin/provider/opencode-account-config"
import {
  projectAccountCapabilities,
  type AccountCapabilitySnapshot,
  type AccountProviderCapability,
} from "@opencode-ai/core/plugin/provider/opencode-account-capability"
import {
  deviceMethodID,
  integrationID,
  oauth as opencodeOAuth,
} from "@opencode-ai/core/plugin/provider/opencode-auth"
import { Hash } from "@opencode-ai/core/util/hash"

const REFRESH_WINDOW_MS = Duration.toMillis(Duration.minutes(5))

export interface ConsoleAccountExecution {
  readonly realm: string
  readonly credentialID: Credential.ID
  readonly credentialRevision: number
  readonly server: string
  readonly orgID?: string
  readonly configVersion: number
  readonly secret: string
  readonly snapshot: Snapshot
  readonly capabilities: AccountCapabilitySnapshot
}

export interface ConsoleClientIdentity {
  /** Stable bounded slot: one current generation per account/provider route. */
  readonly slot: string
  /** Secret-free cache generation. Rotation/config changes always change this value. */
  readonly generation: string
}

export interface ResolverOptions {
  readonly realm: string
  readonly credentials: Credential.Interface
  readonly resolver: CredentialResolver.Interface
  /** Raw client used by the shared OAuth refresh implementation. */
  readonly http: HttpClient.HttpClient
  /** Caller-owned read policy for GET /api/config. Defaults to the raw client. */
  readonly configHttp?: HttpClient.HttpClient
  readonly ttlMs?: number
  readonly maxEntries?: number
  readonly now?: () => number
}

/**
 * P5 V1 adapter over the shared P1 Console wire contract and P2 CredentialResolver.
 *
 * The returned execution object is deliberately ephemeral: it contains the live
 * credential only so the final SDK constructor can receive it. The account-config
 * cache and capability projection retain no credential bytes.
 */
export function makeConsoleAccountExecutionResolver(options: ResolverOptions) {
  const oauth = opencodeOAuth(options.http)
  const config = makeAccountConfigCache({
    fetch: consoleConfigFetcher(options.configHttp ?? options.http),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const resolve = (accountID: string) =>
    Effect.gen(function* () {
      const credentialID = Credential.ID.make(accountID)
      const stored = yield* options.credentials.get(credentialID)
      if (!stored || stored.integrationID !== integrationID) return undefined

      const resolved = yield* options.resolver.resolve(credentialID, {
        shouldRefresh: (value, owner, now) =>
          owner === integrationID &&
          value.methodID === deviceMethodID &&
          value.expires <= now + REFRESH_WINDOW_MS,
        refresh: (value, owner) => {
          if (owner !== integrationID || value.methodID !== deviceMethodID || !oauth.refresh) {
            return Effect.succeed(undefined)
          }
          return oauth.refresh(value)
        },
      })
      if (!resolved) return undefined

      const snapshot = yield* config.resolve({
        scope: options.realm,
        credentialID,
        revision: resolved.revision,
        value: resolved.value,
      })
      const capabilities = projectAccountCapabilities(snapshot)
      const secret = resolved.value.type === "oauth" ? resolved.value.access : resolved.value.key

      return {
        realm: options.realm,
        credentialID,
        credentialRevision: resolved.revision,
        server: snapshot.server,
        ...(snapshot.orgID ? { orgID: snapshot.orgID } : {}),
        configVersion: snapshot.version,
        secret,
        snapshot,
        capabilities,
      } satisfies ConsoleAccountExecution
    })

  return {
    resolve,
    invalidate: (credentialID: Credential.ID) => config.invalidate({ scope: options.realm, credentialID }),
    cacheSize: () => config.size(),
  }
}

/**
 * Build the cache identity for one account-specific provider transport.
 *
 * No secret (or secret-derived fingerprint) participates. The stable slot bounds
 * generations, while the generation includes every authority/config discriminator
 * required to prevent an older authenticated client from being reused.
 */
export function consoleClientIdentity(
  account: ConsoleAccountExecution,
  providerID: string,
  provider: AccountProviderCapability,
): ConsoleClientIdentity {
  const slot = Hash.fast(
    JSON.stringify([
      account.realm,
      account.credentialID,
      account.server,
      account.orgID ?? null,
      providerID,
    ]),
  )
  const generation = Hash.fast(
    JSON.stringify([
      account.realm,
      account.credentialID,
      account.credentialRevision,
      account.server,
      account.orgID ?? null,
      account.configVersion,
      providerID,
      provider.configIdentity,
    ]),
  )
  return { slot, generation }
}

export function isConsoleAccountProvider(providerID: string) {
  return providerID !== "opencode" && providerID !== "opencode-go"
}
