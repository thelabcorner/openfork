import { Effect } from "effect"
import type { Auth } from "@/auth"
import { HttpClient } from "effect/unstable/http"
import {
  asObject,
  buildResult,
  computeUsedPercent,
  durationToLabel,
  durationToSeconds,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../format"
import type { UsageWindow } from "../schema"
import type { Adapter } from "../registry"
import { authKey } from "./key"
import { fetchJson, outcomeError } from "./http"

/**
 * Kimi for Coding weekly usage. Ported from OpenChamber (MIT)
 * packages/web/server/lib/quota/providers/kimi.js: the weekly `usage` block
 * reports `used` while rate-limit `limits[].detail` blocks report
 * `remaining`, so usedPercent is derived from whichever the API returned.
 */

const ALIASES = ["kimi-for-coding", "kimi"]
const NAME = "Kimi for Coding"
const KIMI_QUOTA_URL = "https://api.kimi.com/coding/v1/usages"

export const kimi = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => ({
  id: "kimi-for-coding",
  name: NAME,
  aliases: ALIASES,
  configured: () => Effect.map(authKey(auth, ALIASES), (key) => key !== undefined),
  fetch: () =>
    Effect.gen(function* () {
      const resolved = yield* authKey(auth, ALIASES)
      if (!resolved) {
        return buildResult({ providerId: "kimi-for-coding", providerName: NAME, ok: false, configured: false, error: "Not configured" })
      }
      const outcome = yield* fetchJson(http, KIMI_QUOTA_URL, resolved.key)
      if (!outcome.ok) {
        return buildResult({ providerId: "kimi-for-coding", providerName: NAME, ok: false, configured: true, error: outcomeError(outcome) })
      }
      const payload = asObject(outcome.body) ?? {}
      const windows: Record<string, UsageWindow> = {}
      const usage = asObject(payload.usage)
      if (usage) {
        windows.weekly = toUsageWindow({
          usedPercent: computeUsedPercent(toNumber(usage.limit), toNumber(usage.used), toNumber(usage.remaining)),
          resetAt: toTimestamp(usage.resetTime),
        })
      }
      for (const limit of Array.isArray(payload.limits) ? payload.limits : []) {
        const entry = asObject(limit)
        if (!entry) continue
        const window = asObject(entry.window)
        const detail = asObject(entry.detail)
        const rawLabel = durationToLabel(window?.duration, window?.timeUnit)
        const windowSeconds = durationToSeconds(window?.duration, window?.timeUnit)
        const label = windowSeconds === 5 * 60 * 60 ? `Rate Limit (${rawLabel})` : rawLabel
        windows[label] = toUsageWindow({
          usedPercent: computeUsedPercent(toNumber(detail?.limit), toNumber(detail?.used), toNumber(detail?.remaining)),
          windowSeconds,
          resetAt: toTimestamp(detail?.resetTime),
        })
      }
      return buildResult({
        providerId: "kimi-for-coding",
        providerName: NAME,
        ok: true,
        configured: true,
        usage: { windows },
      })
    }),
})
