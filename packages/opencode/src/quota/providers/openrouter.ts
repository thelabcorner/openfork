import { Effect } from "effect"
import type { Auth } from "@/auth"
import { HttpClient } from "effect/unstable/http"
import { asObject, buildResult, formatMoney, toNumber, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import { authKey } from "./key"
import { createQuotaCache, fetchJson, NEXT_REFRESH_NOW, outcomeError } from "./http"

/**
 * OpenRouter prepaid credits. Ported from OpenChamber (MIT)
 * packages/web/server/lib/quota/providers/openrouter.js. A credit balance is
 * not a window: null percents, a currency valueLabel, no reset.
 */

const ALIASES = ["openrouter"]
const NAME = "OpenRouter"
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"

export const openrouter = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => {
  const cache = createQuotaCache<ReturnType<typeof buildResult>>("openrouter", { persistentKey: "openrouter", ttlMs: 120_000 })
  const withNext = (result: ReturnType<typeof buildResult>) => ({ ...result, nextRefreshAt: cache.nextRefreshAt() })
  return {
    id: "openrouter",
    name: NAME,
    aliases: ALIASES,
    configured: () => Effect.map(authKey(auth, ALIASES), (key) => key !== undefined),
    fetch: () =>
      Effect.gen(function* () {
        const resolved = yield* authKey(auth, ALIASES)
        if (!resolved) {
          return buildResult({ providerId: "openrouter", providerName: NAME, ok: false, configured: false, error: "Not configured" })
        }
        const fresh = cache.fresh(resolved.key)
        if (fresh) return withNext(fresh)
        if (cache.isCoolingDown()) {
          const c = cache.cachedResult()
          if (c) return withNext(c)
          return buildResult({ providerId: "openrouter", providerName: NAME, ok: false, configured: true, error: "Rate limited — OpenRouter is throttling usage checks", nextRefreshAt: cache.nextRefreshAt() })
        }
        const outcome = yield* fetchJson(http, OPENROUTER_CREDITS_URL, resolved.key)
        if (!outcome.ok) {
          if (outcome.error === "status" && outcome.status === 429) {
            const errRes = buildResult({ providerId: "openrouter", providerName: NAME, ok: false, configured: true, error: outcomeError(outcome) })
            cache.coolDown(errRes, outcome.retryAfterMs, resolved.key)
            return withNext(errRes)
          }
          const errRes = buildResult({ providerId: "openrouter", providerName: NAME, ok: false, configured: true, error: outcomeError(outcome), nextRefreshAt: NEXT_REFRESH_NOW })
          if (outcome.error === "status" && (outcome.status === 401 || outcome.status === 403)) {
            cache.coolDown(errRes, undefined, resolved.key)
            return withNext(errRes)
          }
          return errRes
        }
        const payload = asObject(outcome.body) ?? {}
        const credits = asObject(payload.data) ?? {}
        const totalCredits = toNumber(credits.total_credits)
        const totalUsage = toNumber(credits.total_usage)
        if (totalCredits === null || totalUsage === null) {
          return buildResult({ providerId: "openrouter", providerName: NAME, ok: false, configured: true, error: "No quota data in response", nextRefreshAt: NEXT_REFRESH_NOW })
        }
        const remaining = Math.max(0, totalCredits - totalUsage)
        const result = buildResult({
          providerId: "openrouter",
          providerName: NAME,
          ok: true,
          configured: true,
          usage: { windows: { credits: toUsageWindow({ usedPercent: null, valueLabel: `$${formatMoney(remaining)} left · $${formatMoney(totalUsage)} spent` }) } },
        })
        cache.store(result, resolved.key)
        return withNext(result)
      }),
  }
}
