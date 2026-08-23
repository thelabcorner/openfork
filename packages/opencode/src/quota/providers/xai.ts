import { Effect } from "effect"
import type { Auth } from "@/auth"
import { HttpClient } from "effect/unstable/http"
import { buildResult, toUsageWindow } from "../format"
import type { Adapter } from "../registry"
import type { ProviderResult } from "../schema"
import { authKey } from "./key"

/**
 * xAI (Grok) billing cycle quota. Ported from OpenChamber (MIT).
 * Uses gRPC-Web + protobuf for usage, JWT-aware refresh for auth.
 */
const ALIASES = ["xai"]
const NAME = "xAI"
const USAGE_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"
const REFRESH_SKEW_MS = 120_000

export const xai = (http: HttpClient.HttpClient, auth: Auth.Interface): Adapter => ({
  id: "xai",
  name: NAME,
  aliases: ALIASES,
  configured: () => Effect.map(authKey(auth, ALIASES), (key) => key !== undefined),
  fetch: (): Effect.Effect<ProviderResult> => (Effect.gen(function* () {
      const resolved = yield* authKey(auth, ALIASES)
      // xAI auth is OAuth-style with access/refresh/expires; we treat the
      // access token stored in auth.json as the bearer token.
      const accessToken = resolved?.key ?? undefined
      if (!accessToken) {
        return buildResult({ providerId: "xai", providerName: NAME, ok: false, configured: false, error: "Not configured" })
      }
      try {
        // The upstream uses a binary protobuf body [0,0,0,0,0].
        const body = new Uint8Array([0, 0, 0, 0, 0])
        const resPromise = fetch(USAGE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/grpc-web+proto",
            Origin: "https://grok.com",
          },
          body: new Uint8Array([0, 0, 0, 0, 0]),
          signal: AbortSignal.timeout(15_000),
        })
        const res = yield* Effect.tryPromise({ try: () => resPromise, catch: (e) => e })
        const resObj = res as unknown as Response
        if (resObj.status === 429) {
          return buildResult({ providerId: "xai", providerName: NAME, ok: false, configured: true, error: "Rate limited" })
        }
        if (!resObj.ok) {
          const msg = resObj.status === 401 || resObj.status === 403 ? "Session expired — please re-authenticate with xAI" : `API error: ${resObj.status}`
          return buildResult({ providerId: "xai", providerName: NAME, ok: false, configured: true, error: msg })
        }
        const arrayBufferPromise = resObj.arrayBuffer()
        const arrayBuffer = yield* Effect.tryPromise({ try: () => arrayBufferPromise, catch: () => undefined })
        const payload = arrayBuffer ? decodeUsage(arrayBuffer) : null
        return parseUsage(payload)
      } catch (e) {
        return buildResult({ providerId: "xai", providerName: NAME, ok: false, configured: true, error: e instanceof Error ? e.message : String(e) })
      }
    }) as Effect.Effect<ProviderResult>),
})

function decodeUsage(buffer: ArrayBuffer): { percent?: number; resetsAt?: number } | null {
  try {
    const bytes = new Uint8Array(buffer)
    // Very basic protobuf scanner for the known field shapes.
    let percent: number | undefined
    let resetsAt: number | undefined
    let i = 0
    while (i < bytes.length - 1) {
      const tag = (bytes[i] << 3) | (bytes[i + 1] >> 5)
      const wireType = bytes[i + 1] & 7
      i += 2
      if (wireType === 0) {
        // varint — scan until MSB clear
        let val = 0
        let shift = 0
        while (i < bytes.length && (bytes[i] & 0x80) !== 0) {
          val |= (bytes[i] & 0x7f) << shift
          shift += 7
          i++
        }
        if (i < bytes.length) {
          val |= (bytes[i] & 0x7f) << shift
          i++
        }
        if (tag === 1) percent = val / 10 // approximate normalization from upstream
      } else if (wireType === 5) {
        // fixed32 (4 bytes)
        if (i + 4 <= bytes.length) {
          const val = new DataView(buffer, i, 4).getUint32(0, true)
          i += 4
          if (tag === 1 && val > 0 && val < 200) percent = val // approximate
          if (tag === 5) resetsAt = val * 1000 // approximate epoch-sec
        }
      } else {
        break
      }
    }
    return percent !== undefined || resetsAt !== undefined ? { percent, resetsAt } : null
  } catch {
    return null
  }
}

function parseUsage(payload: { percent?: number; resetsAt?: number } | null): ReturnType<typeof buildResult> {
  if (!payload || payload.percent === undefined) {
    return buildResult({ providerId: "xai", providerName: NAME, ok: false, configured: true, error: "Usage data unavailable" })
  }
  return buildResult({
    providerId: "xai",
    providerName: NAME,
    ok: true,
    configured: true,
    usage: {
      windows: {
        billing_cycle: toUsageWindow({ usedPercent: payload.percent, resetAt: payload.resetsAt ?? null }),
      },
    },
    fetchedAt: Date.now(),
  })
}
