import { Effect } from "effect"
import type { Auth } from "@/auth"
import type { ForkCredentials } from "@/fork/credentials"
import { officialUsageCache, OFFICIAL_TTL_MS, type OfficialSnapshot, type OfficialUsageCache } from "@/fork/usage-cache"
import { zenQuotaAccounts } from "@/plugin/zen"
import { buildResult, toUsageWindow } from "../format"
import { NEXT_REFRESH_NOW } from "./http"
import type { Adapter } from "../registry"
import { authKey } from "./key"

/**
 * OpenCode Go account quota. Ported from OpenChamber (MIT)
 * packages/web/server/lib/quota/providers/opencode-go.js, adapted to read
 * through the fork's process-global official usage gate
 * (>=5 min per credential, single-flight, stale-last-good) so the quota
 * surface can never add a second caller of the usage endpoint.
 *
 * Key resolution follows the unified pool: the ROUTED key for a bare
 * opencode-go request is the pool's default account (env-first, else the
 * vault-designated default), so the card reflects exactly what a request will
 * be charged against. Vault-only pools fall back to `credentials.active()`
 * before the legacy auth-token path, which keeps this adapter honest in
 * processes where the pool has not been synced yet.
 */

const ALIASES = ["opencode-go", "opencode"]
const NAME = "OpenCode Go"

export const opencodeGo = (
  auth: Auth.Interface,
  credentials: ForkCredentials.Interface,
  usageCache: OfficialUsageCache = officialUsageCache,
): Adapter => ({
  id: "opencode-go",
  name: NAME,
  aliases: ALIASES,
  configured: () =>
    Effect.gen(function* () {
      if (zenQuotaAccounts().length > 0) return true
      const active = yield* credentials.active()
      if (active) return true
      return (yield* authKey(auth, ALIASES)) !== undefined
    }),
  fetch: () =>
    Effect.gen(function* () {
      const poolDefault = zenQuotaAccounts().find((account) => account.isDefault) ?? zenQuotaAccounts()[0]
      if (poolDefault) {
        return snapshotToResult(yield* usageCache.get(poolDefault.accountId, poolDefault.apiKey))
      }
      const active = yield* credentials.active()
      if (active) return snapshotToResult(yield* usageCache.get(active.id, active.key))
      const resolved = yield* authKey(auth, ALIASES)
      if (!resolved) {
        return buildResult({ providerId: "opencode-go", providerName: NAME, ok: false, configured: false, error: "Not configured" })
      }
      return snapshotToResult(yield* usageCache.get(`auth:${resolved.id}`, resolved.key))
    }),
})

function snapshotToResult(snapshot: OfficialSnapshot): ReturnType<typeof buildResult> {
  const usage = snapshot.snapshot
  // The gate holds one remote read per OFFICIAL_TTL_MS, so a refresh before
  // that expires just re-serves this same snapshot.
  const nextRefreshAt = snapshot.fetchedAt > 0 ? snapshot.fetchedAt + OFFICIAL_TTL_MS : NEXT_REFRESH_NOW
  if (!usage) {
    return buildResult({
      providerId: "opencode-go",
      providerName: NAME,
      ok: false,
      configured: true,
      error: "Usage data unavailable",
      fetchedAt: snapshot.fetchedAt || undefined,
      nextRefreshAt,
    })
  }
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
  if (usage["5h"]) windows["5h"] = toUsageWindow({ usedPercent: usage["5h"].percent, resetAt: usage["5h"].resetsAt })
  if (usage.week) windows.weekly = toUsageWindow({ usedPercent: usage.week.percent, resetAt: usage.week.resetsAt })
  if (usage.month) windows.monthly = toUsageWindow({ usedPercent: usage.month.percent, resetAt: usage.month.resetsAt })
  // fetchedAt reflects when the official endpoint was actually read, so a
  // stale-last-good snapshot displays its true age.
  return buildResult({
    providerId: "opencode-go",
    providerName: NAME,
    ok: true,
    configured: true,
    usage: { windows },
    fetchedAt: snapshot.fetchedAt || undefined,
    nextRefreshAt,
  })
}
