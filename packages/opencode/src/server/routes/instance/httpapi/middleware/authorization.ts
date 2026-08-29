import { Device } from "@opencode-ai/core/device"
import { ServerAuth } from "@/server/auth"
import { Effect, Encoding, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { hasPtyConnectTicketURL } from "@/server/shared/pty-ticket"
import { isPublicUIPath } from "@/server/shared/public-ui"
export {
  Authorization as ServerAuthorization,
  authorizationLayer as serverAuthorizationLayer,
} from "@opencode-ai/server/middleware/authorization"

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function authenticationRequired(config: ServerAuth.Info) {
  return ServerAuth.required(config) || ServerAuth.publiclyExposed(config)
}

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export class PtyConnectAuthorization extends HttpApiMiddleware.Service<PtyConnectAuthorization>()(
  "@opencode/ExperimentalHttpApiPtyConnectAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  return Effect.gen(function* () {
    if (!authenticationRequired(config)) return yield* effect
    if (!ServerAuth.authorized(credential, config)) {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
      )
      return yield* new HttpApiError.Unauthorized({})
    }
    return yield* effect
  })
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

// Device-token candidates, tried only after the master password check fails:
// 1. `Authorization: Bearer <token>` header,
// 2. the raw `auth_token` query value (EventSource cannot set headers, so the
//    SSE route receives the paired token this way),
// 3. the decoded Basic/query password (username ignored) so clients can keep
//    sending the ServerConnection.Http credential shape unchanged.
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

function authorizeWithDevices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  url: URL,
  request: HttpServerRequest.HttpServerRequest,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  devices: Device.Interface | undefined,
) {
  return Effect.gen(function* () {
    if (ServerAuth.authorized(credential, config)) return yield* effect
    if (yield* deviceAuthorized(url, request, credential, devices)) return yield* effect
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
    )
    return yield* new HttpApiError.Unauthorized({})
  })
}

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  if (!authenticationRequired(config)) return effect
  if (!ServerAuth.authorized(credential, config))
    return Effect.succeed(
      HttpServerResponse.empty({
        status: UNAUTHORIZED,
        headers: { "www-authenticate": WWW_AUTHENTICATE },
      }),
    )
  return effect
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    // Optional dependency: harnesses that assemble the middleware without the
    // Device layer keep master-password-only auth; production provides Device.
    const devices = Option.getOrUndefined(yield* Effect.serviceOption(Device.Service))
    if (!authenticationRequired(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        const credential = yield* credentialFromURL(url, request)
        const authorized =
          ServerAuth.authorized(credential, config) ||
          (yield* deviceAuthorized(url, request, credential, devices))
        if (!authorized)
          return HttpServerResponse.empty({
            status: UNAUTHORIZED,
            headers: { "www-authenticate": WWW_AUTHENTICATE },
          })
        return yield* effect
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const devices = Option.getOrUndefined(yield* Effect.serviceOption(Device.Service))
    if (!authenticationRequired(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* Effect.flatMap(credentialFromRequest(request), (credential) =>
          authorizeWithDevices(effect, new URL(request.url, "http://localhost"), request, credential, config, devices),
        )
      }),
    )
  }),
)

export const ptyConnectAuthorizationLayer = Layer.effect(
  PtyConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!authenticationRequired(config)) return PtyConnectAuthorization.of((effect) => effect)
    return PtyConnectAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)
