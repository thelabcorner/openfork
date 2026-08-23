import { Effect } from "effect"
import type { Auth } from "@/auth"
import { HttpClient } from "effect/unstable/http"
import { asObject, buildResult, formatMoney, toNumber, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import { authKey } from "./key"
import { fetchJson, outcomeError } from "./http"

/**
 * OpenRouter prepaid credits. Ported from OpenChamber (MIT)
 * packages/web/server/lib/quota/providers/openrouter.js. A credit balance is
 * not a window: null percents, a currency valueLabel, no reset.
 */

const ALIASES = ["openrouter"]
const NAME = "OpenRouter"
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"

export const openrouter = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => ({
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
      const outcome = yield* fetchJson(http, OPENROUTER_CREDITS_URL, resolved.key)
      if (!outcome.ok) {
        return buildResult({ providerId: "openrouter", providerName: NAME, ok: false, configured: true, error: outcomeError(outcome) })
      }
      const payload = asObject(outcome.body) ?? {}
      const credits = asObject(payload.data) ?? {}
      const totalCredits = toNumber(credits.total_credits)
      const totalUsage = toNumber(credits.total_usage)
      if (totalCredits === null || totalUsage === null) {
        return buildResult({ providerId: "openrouter", providerName: NAME, ok: false, configured: true, error: "No quota data in response" })
      }
      const remaining = Math.max(0, totalCredits - totalUsage)
      return buildResult({
        providerId: "openrouter",
        providerName: NAME,
        ok: true,
        configured: true,
        usage: {
          windows: {
            credits: toUsageWindow({
              usedPercent: null,
              valueLabel: `$${formatMoney(remaining)} left · $${formatMoney(totalUsage)} spent`,
            }),
          },
        },
      })
    }),
})
