import { Effect } from "effect"
import type { Auth } from "@/auth"
import { buildResult, toUsageWindow } from "../format"
import { NEXT_REFRESH_NOW } from "./http"
import type { Adapter } from "../registry"
import { authKey } from "./key"
import { NVIDIA_LIMIT_PER_MINUTE, nvidiaUsage } from "./nvidia-usage"

/**
 * NVIDIA adapter: no external usage endpoint; manual tracking only.
 * Limit: 40 requests/minute (windowSeconds = 60).
 */
const NAME = "NVIDIA"
const ALIASES = ["nvidia"]

export { resetNvidiaUsage, trackNvidiaRequest } from "./nvidia-usage"

export const nvidia = (auth: Auth.Interface): Adapter => ({
  id: "nvidia",
  name: NAME,
  aliases: ALIASES,
  configured: () =>
    Effect.gen(function* () {
      return (yield* authKey(auth, ALIASES)) !== undefined
    }),
  fetch: () => {
    const usage = nvidiaUsage()
    const usedPercent = Math.min(100, (usage.requestCount / NVIDIA_LIMIT_PER_MINUTE) * 100)
    const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
    windows["1m"] = toUsageWindow({ usedPercent, windowSeconds: 60, resetAt: usage.resetAt })
    return Effect.succeed(
      buildResult({
        providerId: "nvidia",
        providerName: NAME,
        ok: true,
        configured: true,
        usage: { windows },
        fetchedAt: Date.now(),
        // Purely local computation — a refresh always recomputes.
        nextRefreshAt: NEXT_REFRESH_NOW,
      }),
    )
  },
})
