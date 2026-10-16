import { Device } from "@opencode-ai/core/device"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PairBeginApi, PairClaimApi, ApiClaimRateLimitedError, ApiPairCodeError } from "../groups/pair"

function clientIP(request: HttpServerRequest.HttpServerRequest) {
  return Option.getOrUndefined(request.remoteAddress)
}

function isLoopback(hostname: string) {
  const host = hostname.toLowerCase()
  // Match packages/mobile/src/pairing-input.ts exactly. Broader loopback
  // aliases would generate QR targets the mobile parser deliberately rejects.
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"
}

function configuredPWAURL(code: string) {
  const configured = process.env.OPENCODE_PWA_URL?.trim()
  if (!configured) return

  const publicURL = process.env.OPENCODE_PUBLIC_URL?.trim()
  if (!publicURL) return

  try {
    const pwa = new URL(configured)
    const api = new URL(publicURL)
    if (
      (pwa.protocol !== "http:" && pwa.protocol !== "https:") ||
      (api.protocol !== "http:" && api.protocol !== "https:")
    ) {
      return
    }
    if (pwa.username || pwa.password || api.username || api.password) return
    if (api.pathname !== "/" || api.search || api.hash) return

    const secureOrigins = pwa.protocol === "https:" && api.protocol === "https:"
    // Plain HTTP is limited to explicit local development/test endpoints;
    // production and remote LAN/tunnel QR targets must use HTTPS.
    const localDevelopmentOrigins =
      (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") &&
      pwa.protocol === "http:" &&
      api.protocol === "http:" &&
      isLoopback(pwa.hostname) &&
      isLoopback(api.hostname)
    if (!secureOrigins && !localDevelopmentOrigins) return

    // A QR must open the independently hosted PWA, not the protected API
    // origin. Distinct paths do not make a same-origin PWA safe here.
    if (pwa.origin === api.origin) return
    pwa.searchParams.set("server", api.origin)
    pwa.hash = `pair=${encodeURIComponent(code)}`
    return pwa.toString()
  } catch {
    return
  }
}

function pairURL(code: string) {
  const configured = configuredPWAURL(code)
  if (configured) return configured
  // The API origin is not necessarily the independently hosted PWA origin.
  // Returning it as a QR destination can navigate into a protected API and
  // trigger a browser-owned Basic-auth prompt before pairing can begin.
  // Keep manual code entry available, and require an explicit PWA URL for QR.
  return ""
}

export const pairHandlers = HttpApiBuilder.group(PairBeginApi, "pair-begin", (handlers) =>
  Effect.gen(function* () {
    const devices = yield* Device.Service

    return handlers.handle(
      "begin",
      Effect.fn("PairHttpApi.begin")(function* () {
        const pairing = yield* devices.beginPairing()
        return { code: pairing.code, url: pairURL(pairing.code), expiresAt: pairing.expiresAt }
      }),
    )
  }),
)

export const pairClaimHandlers = HttpApiBuilder.group(PairClaimApi, "pair-claim", (handlers) =>
  Effect.gen(function* () {
    const devices = yield* Device.Service

    const claim = Effect.fn("PairHttpApi.claim")(function* (ctx: { payload: { code: string; name?: string } }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const claimed = yield* devices
        .claim({ code: ctx.payload.code, ip: clientIP(request), name: ctx.payload.name })
        .pipe(
          Effect.mapError((error) => {
            if (error._tag === "ClaimRateLimitedError") {
              return new ApiClaimRateLimitedError({
                name: "ClaimRateLimitedError",
                data: { message: "Too many claim attempts; slow down.", retryAfterMs: error.retryAfterMs },
              })
            }
            return new ApiPairCodeError({
              name: "PairCodeError",
              data: {
                message:
                  error.reason === "exhausted"
                    ? "This code is dead after too many failed attempts."
                    : error.reason === "expired"
                      ? "This code has expired."
                      : "Unknown or already used code.",
                reason: error.reason,
              },
            })
          }),
        )
      return {
        token: claimed.token,
        device: { id: claimed.device.id, name: claimed.device.name },
        server: { name: "opencode", version: InstallationVersion },
      }
    })

    return handlers.handle("claim", claim)
  }),
)
