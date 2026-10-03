export * as OpencodeRouteCandidates from "./opencode-route-candidates"

import { Duration, Effect, Exit } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ProviderAccount } from "@opencode-ai/schema/provider-account"
import { Credential } from "../../credential"
import * as CredentialResolver from "../../credential/resolver"
import { ProviderAccountPolicy } from "../../provider-account-policy"
import {
  consoleConfigFetcher,
  makeAccountConfigCache,
  type Snapshot,
} from "./opencode-account-config"
import {
  projectAccountCapabilities,
  type AccountCapabilitySnapshot,
} from "./opencode-account-capability"
import {
  deviceMethodID,
  integrationID,
  oauth as opencodeOAuth,
} from "./opencode-auth"
import {
  projectCredential,
} from "./opencode-provider-account"

const REFRESH_WINDOW_MS = Duration.toMillis(Duration.minutes(5))

export interface HealthAssessment {
  readonly admissible: boolean
  readonly healthRank: number
  readonly ineligibleReason?: ProviderAccountPolicy.IneligibilityReason
  readonly usedPercent?: number
  readonly resetAt?: number
  readonly maxSessionBindings?: number
}

export interface HealthInput {
  readonly account: ProviderAccount.Info
  readonly providerID: string
  readonly modelID: string
  readonly credentialRevision: number
  readonly configVersion: number
  readonly providerConfigIdentity?: string
}

export interface CandidateSnapshot {
  readonly account: ProviderAccount.Info
  readonly credentialRevision: number
  readonly configVersion: number
  readonly providerConfigIdentity?: string
  readonly candidate: ProviderAccountPolicy.Candidate
}

export const IssuePhase = [
  "credential-resolution",
  "resolved-identity",
  "account-config",
  "health",
] as const
export type IssuePhase = (typeof IssuePhase)[number]

export interface AccountIssue {
  readonly accountID: ProviderAccount.ID
  readonly credentialHandle: Credential.ID
  readonly phase: IssuePhase
}

export interface ListResult {
  readonly candidates: readonly CandidateSnapshot[]
  readonly issues: readonly AccountIssue[]
}

export interface RevisionInput {
  readonly providerID: string
  readonly accountID: string
  readonly credentialHandle: string
}

export interface ExecutionInput extends RevisionInput {
  readonly modelID: string
  readonly expectedCredentialRevision: number
}

/**
 * Ephemeral final-transport materialization for an already-committed account
 * lease. Secret material may cross this boundary only to the immediate provider
 * compiler; it is never part of route/account/cache identity.
 */
export interface ExecutionMaterialization {
  readonly account: ProviderAccount.Info
  readonly credential: Credential.Value
  readonly credentialRevision: number
  readonly snapshot: Snapshot
  readonly capabilities: AccountCapabilitySnapshot
}

export interface Options<HealthError = never> {
  readonly realm: string
  readonly credentials: Credential.Interface
  readonly resolver: CredentialResolver.Interface
  /** Raw transport used only by the shared OAuth refresh implementation. */
  readonly http: HttpClient.HttpClient
  /** Caller-owned read policy for GET /api/config; defaults to raw http. */
  readonly configHttp?: HttpClient.HttpClient
  readonly assessHealth: (
    input: HealthInput,
  ) => Effect.Effect<HealthAssessment, HealthError>
  readonly ttlMs?: number
  readonly maxEntries?: number
  readonly now?: () => number
}

function issue(account: ProviderAccount.Info, phase: IssuePhase): AccountIssue {
  return {
    accountID: account.accountID,
    credentialHandle: account.credentialID,
    phase,
  }
}

function resolvedInfo(
  stored: Credential.Info,
  resolved: CredentialResolver.Resolved,
) {
  return new Credential.Info({
    id: stored.id,
    integrationID: stored.integrationID,
    label: stored.label,
    value: resolved.value,
    ...(stored.active ? { active: true } : {}),
    revision: resolved.revision,
  })
}

function candidate(
  account: ProviderAccount.Info,
  providerID: string,
  health: HealthAssessment,
): ProviderAccountPolicy.Candidate {
  return {
    providerID,
    accountID: account.accountID,
    credentialHandle: account.credentialID,
    admissible: health.admissible,
    healthRank: health.healthRank,
    ...(health.ineligibleReason
      ? { ineligibleReason: health.ineligibleReason }
      : {}),
    ...(health.usedPercent === undefined
      ? {}
      : { usedPercent: health.usedPercent }),
    ...(health.resetAt === undefined ? {} : { resetAt: health.resetAt }),
    ...(health.maxSessionBindings === undefined
      ? {}
      : { maxSessionBindings: health.maxSessionBindings }),
  }
}

/**
 * OpenCode-specific trusted source feeding the provider-neutral P5A router.
 *
 * Account enumeration is failure-isolated: one refresh/config/health failure
 * yields a secret-free issue for that account and does not remove healthy peers.
 * No raw Credential.Value or remote config escapes this factory.
 */
export function make<HealthError = never>(options: Options<HealthError>) {
  const oauth = opencodeOAuth(options.http)
  const config = makeAccountConfigCache({
    fetch: consoleConfigFetcher(options.configHttp ?? options.http),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.maxEntries === undefined
      ? {}
      : { maxEntries: options.maxEntries }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const resolveStored = (stored: Credential.Info) =>
    options.resolver.resolve(stored.id, {
      shouldRefresh: (value, owner, now) =>
        owner === integrationID &&
        value.methodID === deviceMethodID &&
        value.expires <= now + REFRESH_WINDOW_MS,
      refresh: (value, owner) => {
        if (
          owner !== integrationID ||
          value.methodID !== deviceMethodID ||
          !oauth.refresh
        ) {
          return Effect.succeed(undefined)
        }
        return oauth.refresh(value)
      },
    })

  const list = (input: { readonly providerID: string; readonly modelID: string }) =>
    Effect.gen(function* () {
      const stored = yield* options.credentials.list(integrationID)
      const entries = yield* Effect.forEach(
        stored,
        (credential) =>
          Effect.gen(function* () {
            const storedAccount = projectCredential(credential)
            if (!storedAccount) return undefined

            const resolvedExit = yield* resolveStored(credential).pipe(Effect.exit)
            if (Exit.isFailure(resolvedExit)) {
              return { issue: issue(storedAccount, "credential-resolution") } as const
            }
            const resolved = resolvedExit.value
            if (!resolved) {
              return { issue: issue(storedAccount, "credential-resolution") } as const
            }

            const current = resolvedInfo(credential, resolved)
            const account = projectCredential(current)
            if (!account) {
              return { issue: issue(storedAccount, "resolved-identity") } as const
            }

            const configExit = yield* config
              .resolve({
                scope: options.realm,
                credentialID: current.id,
                revision: resolved.revision,
                value: resolved.value,
              })
              .pipe(Effect.exit)
            if (Exit.isFailure(configExit)) {
              return { issue: issue(account, "account-config") } as const
            }

            const snapshot = configExit.value
            const capabilities = projectAccountCapabilities(snapshot)
            const provider = capabilities.providers[input.providerID]
            const servesModel =
              provider?.models[input.modelID] !== undefined
            const providerConfigIdentity = provider?.configIdentity

            if (!servesModel) {
              const result: CandidateSnapshot = {
                account,
                credentialRevision: resolved.revision,
                configVersion: snapshot.version,
                ...(providerConfigIdentity
                  ? { providerConfigIdentity }
                  : {}),
                candidate: candidate(account, input.providerID, {
                  admissible: false,
                  healthRank: 0,
                  ineligibleReason: "model-unsupported",
                }),
              }
              return { candidate: result } as const
            }

            const healthExit = yield* options
              .assessHealth({
                account,
                providerID: input.providerID,
                modelID: input.modelID,
                credentialRevision: resolved.revision,
                configVersion: snapshot.version,
                ...(providerConfigIdentity
                  ? { providerConfigIdentity }
                  : {}),
              })
              .pipe(Effect.exit)
            if (Exit.isFailure(healthExit)) {
              return { issue: issue(account, "health") } as const
            }

            const result: CandidateSnapshot = {
              account,
              credentialRevision: resolved.revision,
              configVersion: snapshot.version,
              ...(providerConfigIdentity
                ? { providerConfigIdentity }
                : {}),
              candidate: candidate(
                account,
                input.providerID,
                healthExit.value,
              ),
            }
            return { candidate: result } as const
          }),
        { concurrency: 4 },
      )

      const candidates = entries
        .flatMap((entry) => (entry?.candidate ? [entry.candidate] : []))
        .toSorted(
          (left, right) =>
            left.account.accountID.localeCompare(right.account.accountID) ||
            String(left.account.credentialID).localeCompare(
              String(right.account.credentialID),
            ),
        )
      const issues = entries
        .flatMap((entry) => (entry?.issue ? [entry.issue] : []))
        .toSorted(
          (left, right) =>
            left.accountID.localeCompare(right.accountID) ||
            String(left.credentialHandle).localeCompare(
              String(right.credentialHandle),
            ) ||
            left.phase.localeCompare(right.phase),
        )

      return { candidates, issues } satisfies ListResult
    })

  const resolveExact = (input: RevisionInput) =>
    Effect.gen(function* () {
      if (
        !input.providerID.trim() ||
        input.providerID.trim() !== input.providerID ||
        !input.accountID.trim() ||
        input.accountID.trim() !== input.accountID ||
        !input.credentialHandle.trim() ||
        input.credentialHandle.trim() !== input.credentialHandle
      ) {
        return undefined
      }

      const handle = Credential.ID.make(input.credentialHandle)
      const stored = yield* options.credentials.get(handle)
      if (!stored || stored.integrationID !== integrationID) return undefined

      const storedAccount = projectCredential(stored)
      if (!storedAccount || storedAccount.accountID !== input.accountID) return undefined

      const resolved = yield* resolveStored(stored)
      if (!resolved) return undefined
      const account = projectCredential(resolvedInfo(stored, resolved))
      if (!account || account.accountID !== input.accountID) return undefined

      const snapshot = yield* config.resolve({
        scope: options.realm,
        credentialID: stored.id,
        revision: resolved.revision,
        value: resolved.value,
      })
      const capabilities = projectAccountCapabilities(snapshot)
      if (!capabilities.providers[input.providerID]) return undefined
      return { account, resolved, snapshot, capabilities }
    })

  const resolveCredentialRevision = (input: RevisionInput) =>
    resolveExact(input).pipe(Effect.map((exact) => exact?.resolved.revision))

  const resolveExecution = (input: ExecutionInput) =>
    Effect.gen(function* () {
      if (
        !Number.isSafeInteger(input.expectedCredentialRevision) ||
        input.expectedCredentialRevision <= 0 ||
        !input.modelID.trim() ||
        input.modelID.trim() !== input.modelID
      ) {
        return undefined
      }

      const exact = yield* resolveExact(input)
      if (!exact || exact.resolved.revision !== input.expectedCredentialRevision) return undefined
      if (!exact.capabilities.providers[input.providerID]?.models[input.modelID]) return undefined

      return {
        account: exact.account,
        credential: exact.resolved.value,
        credentialRevision: exact.resolved.revision,
        snapshot: exact.snapshot,
        capabilities: exact.capabilities,
      } satisfies ExecutionMaterialization
    })

  return {
    list,
    resolveCredentialRevision,
    resolveExecution,
    invalidate: (credentialID: Credential.ID) =>
      config.invalidate({ scope: options.realm, credentialID }),
    cacheSize: () => config.size(),
  }
}
