import { ServerAuth } from "../auth"
import { Device } from "@opencode-ai/core/device"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
export { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@opencode-ai/protocol/groups/pty"
import { Effect, Encoding, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

// Device-token candidates, tried only after the master password check fails:
// Bearer header, the raw auth_token query value (EventSource cannot set
// headers), and the decoded Basic/query password (username ignored).
function deviceTokensFromRequest(
  url: URL,
  request: HttpServerRequest.HttpServerRequest,
  credential: ServerAuth.DecodedCredentials,
) {
  const tokens: string[] = []
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (bearer) tokens.push(bearer[1]!)
  const query = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (query) tokens.push(query)
  const password = Redacted.value(credential.password)
  if (password) tokens.push(password)
  return tokens
}

function deviceAuthorized(
  url: URL,
  request: HttpServerRequest.HttpServerRequest,
  credential: ServerAuth.DecodedCredentials,
  devices: Device.Interface | undefined,
) {
  if (!devices) return Effect.succeed(false)
  return Effect.gen(function* () {
    for (const token of deviceTokensFromRequest(url, request, credential)) {
      const device = yield* devices.verify(token)
      if (!device) continue
      yield* devices.touch(device.id)
      return true
    }
    return false
  })
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    // Optional dependency: harnesses that assemble the middleware without the
    // Device layer keep master-password-only auth; production provides Device.
    const devices = Option.getOrUndefined(yield* Effect.serviceOption(Device.Service))
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url)) return yield* effect
        const credential = yield* credentialFromRequest(request)
        if (ServerAuth.authorized(credential, config)) return yield* effect
        if (yield* deviceAuthorized(url, request, credential, devices)) return yield* effect
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
        )
        return yield* new UnauthorizedError({ message: "Authentication required" })
      }),
    )
  }),
)
