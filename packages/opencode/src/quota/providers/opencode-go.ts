import { Effect } from "effect"
import type { Auth } from "@/auth"
import type { ForkCredentials } from "@/fork/credentials"
import { officialUsageCache, type OfficialSnapshot, type OfficialUsageCache } from "@/fork/usage-cache"
import { buildResult, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import { authKey } from "./key"

/**
 * OpenCode Go account quota. Ported from OpenChamber (MIT)
 * packages/web/server/lib/quota/providers/opencode-go.js, adapted to read
 * through the fork's process-global official usage gate
 * (>=5 min per credential, single-flight, stale-last-good) so the quota
 * surface can never add a second caller of the usage endpoint.
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
      const active = yield* credentials.active()
      if (active) return true
      return (yield* authKey(auth, ALIASES)) !== undefined
    }),
  fetch: () =>
    Effect.gen(function* () {
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
  if (!usage) {
    return buildResult({
      providerId: "opencode-go",
      providerName: NAME,
      ok: false,
      configured: true,
      error: "Usage data unavailable",
      fetchedAt: snapshot.fetchedAt || undefined,
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
  })
}
