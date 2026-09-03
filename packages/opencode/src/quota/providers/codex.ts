import { Effect } from "effect"
import type { Auth } from "@/auth"
import { HttpClient } from "effect/unstable/http"
import { buildResult, toTimestamp, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import { authKey } from "./key"
import { createQuotaCache, fetchJson, NEXT_REFRESH_NOW, outcomeError } from "./http"

/**
 * Codex / ChatGPT account quota. Ported from OpenChamber (MIT).
 */
const ALIASES = ["codex", "openai", "chatgpt"]
const NAME = "Codex"
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

export const codex = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => {
  const cache = createQuotaCache<ReturnType<typeof buildResult>>("codex", { persistentKey: "codex" })

  return {
    id: "codex",
    name: NAME,
    aliases: ALIASES,
    configured: () => Effect.map(authKey(auth, ALIASES), (key) => key !== undefined),
    fetch: () =>
      Effect.gen(function* () {
        const resolved = yield* authKey(auth, ALIASES)
        if (!resolved) {
          return buildResult({ providerId: "codex", providerName: NAME, ok: false, configured: false, error: "Not configured" })
        }
        const access = resolved.key ?? ""
        const fresh = cache.fresh(access)
        if (fresh) return withNextRefresh(fresh, cache)
        if (cache.isCoolingDown()) {
          const cachedResult = cache.cachedResult()
          if (cachedResult) return withNextRefresh(cachedResult, cache)
          return buildResult({
            providerId: "codex",
            providerName: NAME,
            ok: false,
            configured: true,
            error: "Rate limited — OpenAI is throttling usage checks",
            nextRefreshAt: cache.nextRefreshAt(),
          })
        }
        // ChatGPT account scoping: prefer an explicit accountId field, then a
        // well-known block, matching upstream's JWT/chatgpt_account_id lookup.
        const entry = yield* Effect.catch(auth.get(resolved.id), () => Effect.succeed(undefined))
        const record = entry as unknown as Record<string, unknown> | undefined
        const wellKnown = record && typeof record.wellknown === "object" && record.wellknown !== null ? (record.wellknown as Record<string, unknown>) : undefined
        const accountId =
          (record && typeof record.accountId === "string" ? record.accountId : undefined) ??
          (wellKnown && typeof wellKnown.account_id === "string" ? wellKnown.account_id : undefined)
        const outcome = yield* fetchJson(http, USAGE_URL, access, accountId ? { "chatgpt-account-id": accountId } : undefined)
        if (!outcome.ok) {
          const msg = outcomeError(outcome)
          const reauthMsg = msg.includes("401") || msg.includes("403") ? "Session expired — please re-authenticate with OpenAI" : msg
          const errorResult = buildResult({ providerId: "codex", providerName: NAME, ok: false, configured: true, error: reauthMsg })
          if (outcome.error === "status" && outcome.status === 429) {
            cache.coolDown(errorResult, outcome.retryAfterMs, access)
            return withNextRefresh(errorResult, cache)
          }
          return { ...errorResult, nextRefreshAt: NEXT_REFRESH_NOW }
        }
        const payload = outcome.body as Record<string, unknown> | null
        const result = parseUsage(payload)
        cache.store(result, access)
        return withNextRefresh(result, cache)
      }),
  }
}

function withNextRefresh(result: ReturnType<typeof buildResult>, cache: ReturnType<typeof createQuotaCache<ReturnType<typeof buildResult>>>) {
  return { ...result, nextRefreshAt: cache.nextRefreshAt() }
}

function parseUsage(payload: unknown): ReturnType<typeof buildResult> {
  if (typeof payload !== "object" || payload === null) {
    return buildResult({ providerId: "codex", providerName: NAME, ok: false, configured: true, error: "No quota data in response" })
  }
  const p = payload as Record<string, unknown>
  const rateLimit = p.rate_limit as Record<string, unknown> | undefined
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}

  // Primary / secondary rate windows.
  if (rateLimit && typeof rateLimit === "object") {
    const primary = rateLimit.primary_window as Record<string, unknown> | undefined
    const secondary = rateLimit.secondary_window as Record<string, unknown> | undefined

    if (primary) {
      const seconds = typeof primary.limit_window_seconds === "number" ? primary.limit_window_seconds : null
      const label = seconds ? (seconds === 18000 ? "5h" : seconds === 604800 ? "weekly" : `${Math.round(seconds / 3600)}h`) : "rate"
      const percent = typeof primary.used_percent === "number" ? primary.used_percent : null
      windows[label] = toUsageWindow({ usedPercent: percent, windowSeconds: seconds, resetAt: toTimestamp(primary.reset_at) })
    }
    if (secondary) {
      const seconds = typeof secondary.limit_window_seconds === "number" ? secondary.limit_window_seconds : null
      const label = seconds ? (seconds === 18000 ? "5h" : seconds === 604800 ? "weekly" : `${Math.round(seconds / 3600)}h`) : "rate"
      const percent = typeof secondary.used_percent === "number" ? secondary.used_percent : null
      const key = label === "rate" || windows[label] !== undefined ? `${label}_secondary` : label
      windows[key] = toUsageWindow({ usedPercent: percent, windowSeconds: seconds, resetAt: toTimestamp(secondary.reset_at) })
    }
  }

  // Credits / balance (no percent — monetary value label).
  const credits = p.credits as Record<string, unknown> | undefined
  if (credits && typeof credits === "object") {
    const balance = typeof credits.balance === "number" ? credits.balance : null
    const unlimited = credits.unlimited === true
    windows.credits = toUsageWindow({ usedPercent: null, valueLabel: unlimited ? "Unlimited" : (balance !== null ? `Credits: $${balance.toFixed(2)}` : undefined) })
  }

  // Spend control (optional monthly spend cap).
  const spendControl = p.spend_control as Record<string, unknown> | undefined
  if (spendControl && typeof spendControl === "object") {
    const individualLimit = spendControl.individual_limit as Record<string, unknown> | undefined
    if (individualLimit && individualLimit.enabled === true) {
      const spent = typeof individualLimit.spent === "number" ? individualLimit.spent : null
      const limit = typeof individualLimit.limit === "number" ? individualLimit.limit : null
      const percent = spent !== null && limit !== null && limit > 0 ? (spent / limit) * 100 : null
      windows.credits_spend = toUsageWindow({ usedPercent: percent, valueLabel: spent !== null && limit !== null ? `$${spent.toFixed(2)} / $${limit.toFixed(2)} spent` : undefined })
    }
  }

  return buildResult({ providerId: "codex", providerName: NAME, ok: true, configured: true, usage: { windows }, fetchedAt: Date.now() })
}
