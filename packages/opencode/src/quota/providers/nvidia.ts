import { Effect } from "effect"
import type { Auth } from "@/auth"
import { buildResult, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import { authKey } from "./key"

/**
 * NVIDIA adapter: no external usage endpoint; manual tracking only.
 * Limit: 40 requests/minute (windowSeconds = 60).
 */
const NAME = "NVIDIA"
const ALIASES = ["nvidia"]
const LIMIT_PER_MINUTE = 40

// Manual tracking store (process-local; no endpoint to sync from).
// Consumers can call `trackNvidiaRequest()` externally; adapter reads this.
let manualCount = 0
let manualWindowStart = Date.now()

export function trackNvidiaRequest(): void {
  const now = Date.now()
  // Reset count if previous window (60s) has passed.
  if (now - manualWindowStart >= 60_000) {
    manualWindowStart = now
    manualCount = 0
  }
  manualCount++
}

export function resetNvidiaUsage(): void {
  manualWindowStart = Date.now()
  manualCount = 0
}

export const nvidia = (http?: unknown, auth?: Auth.Interface): Adapter => ({
  id: "nvidia",
  name: NAME,
  aliases: ALIASES,
  configured: () =>
    Effect.gen(function* () {
      // Always surface NVIDIA in limits pane; presence in server config
      // or provider list is sufficient (like Claude machine account).
      const key = auth ? yield* authKey(auth, ALIASES) : undefined
      return key !== undefined || true
    }),
  fetch: () =>
    Effect.gen(function* () {
      // Synthetic quota based on manually tracked requests.
      const now = Date.now()
      if (now - manualWindowStart >= 60_000) {
        manualWindowStart = now
        manualCount = 0
      }
      const usedPercent = Math.min(100, (manualCount / LIMIT_PER_MINUTE) * 100)
      const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}
      windows["1m"] = toUsageWindow({ usedPercent, windowSeconds: 60, resetAt: manualWindowStart + 60_000 })
      return buildResult({
        providerId: "nvidia",
        providerName: NAME,
        ok: true,
        configured: true,
        usage: { windows },
        fetchedAt: Date.now(),
      })
    }),
})
