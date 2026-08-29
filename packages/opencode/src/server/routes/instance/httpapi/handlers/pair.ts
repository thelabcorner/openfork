import { Device } from "@opencode-ai/core/device"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { PairBeginApi, PairClaimApi, ApiClaimRateLimitedError, ApiPairCodeError } from "../groups/pair"

function clientIP(request: HttpServerRequest.HttpServerRequest) {
  return Option.getOrUndefined(request.remoteAddress)
}

function configuredPWAURL(code: string) {
  const configured = process.env.OPENCODE_PWA_URL?.trim()
  if (!configured) return

  try {
    const pwa = new URL(configured)
    if (pwa.protocol !== "http:" && pwa.protocol !== "https:") return

    const server = process.env.OPENCODE_PUBLIC_URL?.trim()
    if (server) {
      const api = new URL(server)
      if (api.protocol !== "http:" && api.protocol !== "https:") return
      api.hash = ""
      pwa.searchParams.set("server", api.toString().replace(/\/$/, ""))
    }
    pwa.hash = `pair=${encodeURIComponent(code)}`
    return pwa.toString()
  } catch {
    return
  }
}

function pairURL(request: HttpServerRequest.HttpServerRequest, code: string) {
  const configured = configuredPWAURL(code)
  if (configured) return configured

  const url = new URL(request.url, "http://localhost")
  const protocol = request.headers["x-forwarded-proto"] ?? url.protocol.replace(":", "")
  const host =
    request.headers["x-forwarded-host"]?.split(",")[0].trim() ??
    (request.headers as Record<string, string | undefined>)["host"]?.split(",")[0].trim() ??
    (request.headers as Record<string, string | undefined>)["Host"]?.split(",")[0].trim() ??
    url.host
  // Fragment, not query: the code must never reach server access logs or
  // referrers — clients consume and strip it from location.hash.
  const server = process.env.OPENCODE_PUBLIC_URL?.trim()
  const query = server ? `?server=${encodeURIComponent(server.replace(/\/$/, ""))}` : ""
  return `${protocol}://${host}/${query}#pair=${encodeURIComponent(code)}`
}

export const pairHandlers = HttpApiBuilder.group(PairBeginApi, "pair-begin", (handlers) =>
  Effect.gen(function* () {
    const devices = yield* Device.Service

    return handlers.handle(
      "begin",
      Effect.fn("PairHttpApi.begin")(function* () {
        const pairing = yield* devices.beginPairing()
        const request = yield* HttpServerRequest.HttpServerRequest
        return { code: pairing.code, url: pairURL(request, pairing.code), expiresAt: pairing.expiresAt }
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
