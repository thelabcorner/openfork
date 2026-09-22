import { Effect } from "effect"
import type { SessionUsage } from "@opencode-ai/core/session/usage"
import type { Auth } from "@/auth"
import type { ForkCredentials } from "@/fork/credentials"
import { stableZenIdentity } from "@/plugin/zen-accounts"
import { zenQuotaAccounts } from "@/plugin/zen"
import {
  buildAggregateWindows,
  buildLocalWindows,
  localUsageCache,
  officialUsageCache,
  type LocalWindow,
  type OfficialUsage,
} from "@/fork/usage-cache"

export type ForkUsageAccount = {
  readonly credentialID: string
  readonly accountID?: string
  readonly windows: LocalWindow[]
  readonly official?: {
    readonly fetchedAt: number
    readonly ageMs: number
    readonly status: "ok" | "stale" | "error"
  }
}

export type ForkUsageResult = {
  readonly aggregate: LocalWindow[]
  readonly byCredential: ForkUsageAccount[]
  readonly defaultAccountID?: string
  readonly defaultAccountLabel?: string
  readonly routedAccountID?: string
  readonly routedAccountLabel?: string
  readonly routedAccountSource?: "provider" | "pool"
}

export type ForkUsageSnapshot = {
  readonly result: ForkUsageResult
  readonly accountLabels: ReadonlyMap<string, string>
}

function authBearer(info: Auth.Info | undefined): string | undefined {
  if (!info) return
  if (info.type === "api") return info.key || undefined
  if (info.type === "oauth") return info.access || undefined
  if (info.type === "wellknown") return info.token || undefined
}

/**
 * Process-global OpenCode Go usage projection shared by every Tier-0 consumer.
 *
 * This is the authoritative composition boundary for local usage rows, the
 * >=5-minute process-global official-usage gate, multi-account pool aliases,
 * and direct provider auth. HTTP handlers and other process-global projections
 * consume this function instead of reimplementing account/routing semantics.
 */
export const forkUsageSnapshot = Effect.fn("ForkUsage.snapshot")(function* (input: {
  readonly credentials: ForkCredentials.Interface
  readonly usage: SessionUsage.Interface
  readonly auth: Auth.Interface
}) {
  const local = yield* localUsageCache.get(() =>
    Effect.gen(function* () {
      const bounds = yield* input.usage.windows()
      const allCredentials = yield* input.credentials.list()
      const grouped = yield* input.credentials.usageByCredential(bounds)
      const byCredential = new Map(
        allCredentials.map((credential) => [
          credential.id,
          buildLocalWindows(bounds, grouped.byCredential.get(credential.id) ?? []),
        ]),
      )
      const aggregate = buildAggregateWindows(bounds, grouped.byCredential, grouped.unattributed)
      return { bounds, allCredentials, byCredential, aggregate }
    }),
  )

  const { bounds, allCredentials, byCredential, aggregate } = local
  const poolAccounts = zenQuotaAccounts()
  const poolDefault = poolAccounts.find((entry) => entry.isDefault) ?? poolAccounts[0]
  const directAuth = yield* input.auth.get("opencode-go").pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  const directKey = authBearer(directAuth)
  const directAccountID = directKey ? stableZenIdentity(directKey) : undefined
  const directLabel =
    directAuth?.type === "api" && directAuth.metadata?.label ? directAuth.metadata.label : "OpenCode Go"
  const routed = directAccountID
    ? {
        routedAccountID: directAccountID,
        routedAccountLabel: directLabel,
        routedAccountSource: "provider" as const,
      }
    : poolDefault
      ? {
          routedAccountID: poolDefault.accountId,
          routedAccountLabel: poolDefault.label,
          routedAccountSource: "pool" as const,
        }
      : {}

  const accountLabels = new Map<string, string>()
  for (const credential of allCredentials) {
    accountLabels.set(stableZenIdentity(credential.key), credential.label)
    accountLabels.set(credential.id, credential.label)
  }
  for (const account of poolAccounts) accountLabels.set(account.accountId, account.label)
  if (directAccountID) accountLabels.set(directAccountID, directLabel)

  if (allCredentials.length === 0 && poolAccounts.length === 0 && !directKey) {
    return {
      result: {
        aggregate,
        byCredential: [] as ForkUsageAccount[],
        ...routed,
        ...(poolDefault
          ? { defaultAccountID: poolDefault.accountId, defaultAccountLabel: poolDefault.label }
          : {}),
      },
      accountLabels,
    }
  }

  // Collapse storage aliases by physical bearer identity. The official cache is
  // keyed by the bearer secret too, so this cannot multiply provider reads.
  const vaultByAccount = new Map<string, (typeof allCredentials)[number]>()
  for (const credential of allCredentials) {
    const accountID = stableZenIdentity(credential.key)
    const current = vaultByAccount.get(accountID)
    if (!current || (credential.active && !current.active)) vaultByAccount.set(accountID, credential)
  }

  const officialByCredential = yield* Effect.forEach(
    [...vaultByAccount.entries()],
    ([accountID, credential]): Effect.Effect<ForkUsageAccount> =>
      Effect.map(officialUsageCache.get(accountID, credential.key), (official) => ({
        credentialID: credential.id,
        accountID,
        windows: mergeOfficial(byCredential.get(credential.id) ?? [], official.snapshot ?? {}),
        official: {
          fetchedAt: official.fetchedAt,
          ageMs: official.ageMs,
          status: official.status,
        },
      })),
    { concurrency: 4 },
  )

  // Env-backed pool rows and direct /connect auth are real routing accounts even
  // when they have no durable fork_credential UUID.
  const missingPoolRows = yield* Effect.forEach(
    poolAccounts.filter((account) => !officialByCredential.some((entry) => entry.accountID === account.accountId)),
    (account): Effect.Effect<ForkUsageAccount> =>
      Effect.map(officialUsageCache.get(account.accountId, account.apiKey), (official) => ({
        credentialID: account.accountId,
        accountID: account.accountId,
        windows: mergeOfficial(buildLocalWindows(bounds, []), official.snapshot ?? {}),
        official: {
          fetchedAt: official.fetchedAt,
          ageMs: official.ageMs,
          status: official.status,
        },
      })),
    { concurrency: 4 },
  )
  officialByCredential.push(...missingPoolRows)

  if (directKey && directAccountID && !officialByCredential.some((entry) => entry.accountID === directAccountID)) {
    const official = yield* officialUsageCache.get(directAccountID, directKey)
    officialByCredential.push({
      credentialID: `auth:opencode-go:${directAccountID}`,
      accountID: directAccountID,
      windows: mergeOfficial(buildLocalWindows(bounds, []), official.snapshot ?? {}),
      official: {
        fetchedAt: official.fetchedAt,
        ageMs: official.ageMs,
        status: official.status,
      },
    })
  }

  return {
    result: {
      aggregate: aggregateWindows(
        aggregate,
        officialByCredential.map((entry) => entry.windows),
      ),
      byCredential: officialByCredential,
      ...routed,
      ...(poolDefault
        ? { defaultAccountID: poolDefault.accountId, defaultAccountLabel: poolDefault.label }
        : {}),
    },
    accountLabels,
  }
})

function mergeOfficial(local: LocalWindow[], official: OfficialUsage): LocalWindow[] {
  return local.map((window) => {
    const next = official[window.label]
    if (!next) return window
    return {
      ...window,
      spentUSD: window.limitUSD * (Math.max(0, Math.min(100, next.percent)) / 100),
      estimatedPercent: estimatePercent(window, next.percent),
      resetsAt: next.resetsAt,
      clearsAt: next.resetsAt,
      source: "api" as const,
      status: next.status,
    }
  })
}

function estimatePercent(window: LocalWindow, officialPercent: number) {
  const official = Math.max(0, Math.min(100, officialPercent))
  if (!Number.isInteger(official)) return official
  const local = percentFor(window.spentUSD, window.limitUSD)
  if (!Number.isFinite(local)) return undefined
  if (official >= 100) return 100
  if (Math.floor(local) === official) return roundPercent(local)
  if (Math.round(local) === official && Math.abs(local - official) <= 0.5) return roundPercent(local)
  return undefined
}

function percentFor(spentUSD: number, limitUSD: number) {
  if (limitUSD <= 0) return 0
  return Math.max(0, Math.min(100, (spentUSD / limitUSD) * 100))
}

function roundPercent(percent: number) {
  return Math.round(percent * 100) / 100
}

function aggregateWindows(local: LocalWindow[], byCredential: LocalWindow[][]) {
  return local.map((window) => {
    const windows = byCredential
      .map((items) => items.find((item) => item.label === window.label))
      .filter((item): item is LocalWindow => !!item)
    if (!windows.some((item) => item.source === "api")) return window
    const resetsAt = Math.min(...windows.map((item) => item.resetsAt))
    const spentUSD = windows.reduce((total, item) => total + item.spentUSD, 0)
    const limitUSD = windows.reduce((total, item) => total + item.limitUSD, 0)
    const estimatedSpentUSD = windows.reduce(
      (total, item) =>
        total + item.limitUSD * ((item.estimatedPercent ?? percentFor(item.spentUSD, item.limitUSD)) / 100),
      0,
    )
    return {
      ...window,
      spentUSD,
      limitUSD,
      estimatedPercent: windows.some((item) => item.estimatedPercent !== undefined)
        ? roundPercent(percentFor(estimatedSpentUSD, limitUSD))
        : undefined,
      resetsAt,
      clearsAt: resetsAt,
      source: "api" as const,
      status:
        windows.some((item) => item.source !== "api" || (item.status && item.status !== "ok")) ? "mixed" : "ok",
    }
  })
}
