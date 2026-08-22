import { Effect } from "effect"
import type { Auth } from "@/auth"
import { HttpClient } from "effect/unstable/http"
import { asObject, buildResult, formatMoney, toNumber, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import { authKey } from "./key"
import { fetchJson, outcomeError, type FetchOutcome } from "./http"

/**
 * DeepSeek prepaid balance. Ported from OpenChamber (MIT)
 * packages/web/server/lib/quota/providers/deepseek.js. A balance is not a
 * window: null percents, a currency valueLabel, no reset.
 */

const ALIASES = ["deepseek"]
const NAME = "DeepSeek"
const DEEPSEEK_QUOTA_URL = "https://api.deepseek.com/user/balance"

function deepseekError(outcome: Extract<FetchOutcome, { ok: false }>): string {
  if (outcome.error === "status" && (outcome.status === 401 || outcome.status === 403)) {
    return "Session expired — please re-authenticate with DeepSeek"
  }
  return outcomeError(outcome)
}

export const deepseek = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => ({
  id: "deepseek",
  name: NAME,
  aliases: ALIASES,
  configured: () => Effect.map(authKey(auth, ALIASES), (key) => key !== undefined),
  fetch: () =>
    Effect.gen(function* () {
      const resolved = yield* authKey(auth, ALIASES)
      if (!resolved) {
        return buildResult({ providerId: "deepseek", providerName: NAME, ok: false, configured: false, error: "Not configured" })
      }
      const outcome = yield* fetchJson(http, DEEPSEEK_QUOTA_URL, resolved.key, { "Accept-Encoding": "identity" })
      if (!outcome.ok) {
        return buildResult({ providerId: "deepseek", providerName: NAME, ok: false, configured: true, error: deepseekError(outcome) })
      }
      const payload = asObject(outcome.body) ?? {}
      const balanceInfos = Array.isArray(payload.balance_infos) ? payload.balance_infos : []
      const balanceInfo =
        balanceInfos.map(asObject).find((info) => info?.currency === "USD") ??
        balanceInfos.map(asObject).find((info) => info?.currency === "CNY")
      const totalBalance = toNumber(balanceInfo?.total_balance)
      if (totalBalance === null) {
        return buildResult({ providerId: "deepseek", providerName: NAME, ok: false, configured: true, error: "No quota data in response" })
      }
      const symbol = balanceInfo?.currency === "CNY" ? "¥" : "$"
      const money = formatMoney(totalBalance)
      return buildResult({
        providerId: "deepseek",
        providerName: NAME,
        ok: true,
        configured: true,
        usage: {
          windows: {
            credits_balance: toUsageWindow({ usedPercent: null, valueLabel: money === null ? null : `${symbol}${money}` }),
          },
        },
      })
    }),
})
