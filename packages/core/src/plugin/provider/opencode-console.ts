import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export const DEFAULT_SERVER = "https://opencode.ai/console"
export const CLIENT_ID = "opencode-cli"

export const DeviceAuthorization = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
})
export type DeviceAuthorization = Schema.Schema.Type<typeof DeviceAuthorization>

export const TokenSuccess = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
})
export type TokenSuccess = Schema.Schema.Type<typeof TokenSuccess>

export const DeviceTokenError = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
})
export type DeviceTokenError = Schema.Schema.Type<typeof DeviceTokenError>

export const DeviceToken = Schema.Union([TokenSuccess, DeviceTokenError])
export type DeviceToken = Schema.Schema.Type<typeof DeviceToken>

export const User = Schema.Struct({ id: Schema.String, email: Schema.String })
export type User = Schema.Schema.Type<typeof User>

export const Organization = Schema.Struct({ id: Schema.String, name: Schema.String })
export type Organization = Schema.Schema.Type<typeof Organization>

export const RemoteConfig = Schema.Struct({
  config: Schema.Record(Schema.String, Schema.Json),
})
export type RemoteConfig = Schema.Schema.Type<typeof RemoteConfig>

export type PollResult =
  | { readonly _tag: "success"; readonly accessToken: string; readonly refreshToken: string; readonly expiresIn: number }
  | { readonly _tag: "pending"; readonly error: string }
  | { readonly _tag: "slow_down"; readonly error: string }
  | { readonly _tag: "expired"; readonly error: string }
  | { readonly _tag: "access_denied"; readonly error: string }
  | { readonly _tag: "error"; readonly error: string; readonly description?: string }

export function resolveVerificationUrl(server: string, verificationUriComplete: string): string {
  const url = new URL(verificationUriComplete, `${server}/`)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("expected HTTP(S)")
  return url.href
}

export const startDeviceAuthorization = (http: HttpClient.HttpClient, server: string) =>
  post(http, `${server}/auth/device/code`, { client_id: CLIENT_ID }, DeviceAuthorization)

export const pollDeviceToken = (http: HttpClient.HttpClient, server: string, deviceCode: string) =>
  post(
    http,
    `${server}/auth/device/token`,
    {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: CLIENT_ID,
    },
    DeviceToken,
    false,
  ).pipe(Effect.map(toPollResult))

export const refreshToken = (http: HttpClient.HttpClient, server: string, refreshToken: string) =>
  post(
    http,
    `${server}/auth/device/token`,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID },
    TokenSuccess,
  )

export const getUser = (http: HttpClient.HttpClient, server: string, accessToken: string) =>
  get(http, `${server}/api/user`, accessToken, User)

export const getOrganizations = (http: HttpClient.HttpClient, server: string, accessToken: string) =>
  get(http, `${server}/api/orgs`, accessToken, Schema.Array(Organization))

export const getProviderConfig = (
  http: HttpClient.HttpClient,
  server: string,
  accessToken: string,
  orgID?: string,
) =>
  http
    .execute(
      HttpClientRequest.get(`${server}/api/config`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.setHeaders(orgID ? { "x-org-id": orgID } : {}),
      ),
    )
    .pipe(
      Effect.flatMap((response) => {
        if (response.status === 404) return Effect.succeed<Record<string, unknown> | undefined>(undefined)
        return HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RemoteConfig)),
          Effect.map((remote) => remote.config),
        )
      }),
    )

function toPollResult(result: DeviceToken): PollResult {
  if ("access_token" in result) {
    return {
      _tag: "success",
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresIn: result.expires_in,
    }
  }
  if (result.error === "authorization_pending") return { _tag: "pending", error: result.error }
  if (result.error === "slow_down") return { _tag: "slow_down", error: result.error }
  if (result.error === "expired_token") return { _tag: "expired", error: result.error }
  if (result.error === "access_denied") return { _tag: "access_denied", error: result.error }
  return { _tag: "error", error: result.error, description: result.error_description }
}

function get<S extends Schema.Top>(http: HttpClient.HttpClient, url: string, token: string, schema: S) {
  return HttpClient.filterStatusOk(http)
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(token)))
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
}

function post<S extends Schema.Top>(
  http: HttpClient.HttpClient,
  url: string,
  body: Record<string, string>,
  schema: S,
  statusOk = true,
) {
  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.String))(body),
    Effect.flatMap((request) => http.execute(request)),
    Effect.flatMap((response) => (statusOk ? HttpClientResponse.filterStatusOk(response) : Effect.succeed(response))),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  )
}
