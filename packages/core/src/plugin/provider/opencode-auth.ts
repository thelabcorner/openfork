export * as OpencodeAuth from "./opencode-auth"

import { Duration, Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Integration } from "@opencode-ai/schema/integration"
import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/v2/effect/integration"
import { Credential } from "../../credential"
import type { OAuthImplementation } from "../../integration/auth-kernel"
import {
  DEFAULT_SERVER,
  getOrganizations,
  getUser,
  pollDeviceToken,
  refreshToken,
  resolveVerificationUrl,
  startDeviceAuthorization,
} from "./opencode-console"

export const integrationID = Integration.ID.make("opencode")
export const deviceMethodID = Integration.MethodID.make("device")

export const keyMethod = {
  type: "key",
  label: "API key (service account)",
} satisfies Integration.KeyMethod

export function oauth(http: HttpClient.HttpClient) {
  return {
    integrationID,
    method: {
      id: deviceMethodID,
      type: "oauth",
      label: "OpenCode Console account",
    },
    authorize: () =>
      Effect.gen(function* () {
        const device = yield* startDeviceAuthorization(http, DEFAULT_SERVER)
        const verification = yield* Effect.try({
          try: () => resolveVerificationUrl(DEFAULT_SERVER, device.verification_uri_complete),
          catch: (cause) =>
            new Error(`Invalid device verification URL: ${cause instanceof Error ? cause.message : String(cause)}`),
        })
        return {
          mode: "auto" as const,
          url: verification,
          instructions: `Enter code: ${device.user_code}`,
          callback: poll(http, DEFAULT_SERVER, device.device_code, Duration.seconds(device.interval)),
        }
      }),
    refresh: (credential) =>
      Effect.gen(function* () {
        const server = typeof credential.metadata?.server === "string" ? credential.metadata.server : DEFAULT_SERVER
        const token = yield* refreshToken(http, server, credential.refresh)
        return Credential.OAuth.make({
          ...credential,
          methodID: Integration.MethodID.make(credential.methodID),
          access: token.access_token,
          refresh: token.refresh_token,
          expires: Date.now() + token.expires_in * 1000,
        })
      }),
    label: (credential) => {
      return typeof credential.metadata?.orgName === "string" ? credential.metadata.orgName : undefined
    },
  } satisfies OAuthImplementation & IntegrationOAuthMethodRegistration
}

function poll(http: HttpClient.HttpClient, server: string, deviceCode: string, interval: Duration.Duration) {
  const loop = (wait: Duration.Duration): Effect.Effect<Credential.OAuth, unknown> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* pollDeviceToken(http, server, deviceCode)
      if (result._tag === "success") return yield* makeCredential(http, server, result)
      if (result._tag === "pending") return yield* loop(wait)
      if (result._tag === "slow_down") return yield* loop(Duration.sum(wait, Duration.seconds(5)))
      return yield* Effect.fail(new Error(`Device authorization failed: ${result.error}`))
    })
  return loop(interval)
}

function makeCredential(
  http: HttpClient.HttpClient,
  server: string,
  token: { accessToken: string; refreshToken: string; expiresIn: number },
) {
  return Effect.gen(function* () {
    const [user, orgs] = yield* Effect.all(
      [getUser(http, server, token.accessToken), getOrganizations(http, server, token.accessToken)],
      { concurrency: 2 },
    )
    const org = orgs.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
    return Credential.OAuth.make({
      type: "oauth",
      methodID: deviceMethodID,
      access: token.accessToken,
      refresh: token.refreshToken,
      expires: Date.now() + token.expiresIn * 1000,
      metadata: {
        server,
        accountID: user.id,
        email: user.email,
        orgID: org?.id,
        orgName: org?.name,
      },
    })
  })
}
