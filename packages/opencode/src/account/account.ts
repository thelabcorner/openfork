import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cache, Clock, Duration, Effect, Layer, Option, Schema, Context } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import {
  getOrganizations,
  getProviderConfig,
  getUser,
  pollDeviceToken,
  refreshToken as refreshDeviceToken,
  resolveVerificationUrl,
  startDeviceAuthorization,
} from "@opencode-ai/core/plugin/provider/opencode-console"
import type { PollResult as DevicePollResult } from "@opencode-ai/core/plugin/provider/opencode-console"
import { HttpClient, HttpClientError } from "effect/unstable/http"

import { withTransientReadRetry } from "@/util/effect-http-client"
import { AccountRepo, type AccountRow } from "./repo"
import { normalizeServerUrl } from "./url"
import {
  type AccountError,
  AccessToken,
  AccountID,
  DeviceCode,
  Info,
  RefreshToken,
  AccountServiceError,
  AccountTransportError,
  Login,
  Org,
  OrgID,
  PollDenied,
  PollError,
  PollExpired,
  PollPending,
  type PollResult,
  PollSlow,
  PollSuccess,
  UserCode,
} from "./schema"

export {
  AccountID,
  type AccountError,
  AccountRepoError,
  AccountServiceError,
  AccountTransportError,
  AccessToken,
  RefreshToken,
  DeviceCode,
  UserCode,
  Info,
  Org,
  OrgID,
  Login,
  PollSuccess,
  PollPending,
  PollSlow,
  PollExpired,
  PollDenied,
  PollError,
  PollResult,
} from "./schema"

export type AccountOrgs = {
  account: Info
  orgs: readonly Org[]
}

export type ActiveOrg = {
  account: Info
  org: Org
}

class User extends Schema.Class<User>("User")({
  id: AccountID,
  email: Schema.String,
}) {}

const eagerRefreshThreshold = Duration.minutes(5)
const eagerRefreshThresholdMs = Duration.toMillis(eagerRefreshThreshold)

const isTokenFresh = (tokenExpiry: number | null, now: number) =>
  tokenExpiry != null && tokenExpiry > now + eagerRefreshThresholdMs

const mapSharedAccountError = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AccountError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      accountErrorFromCause(
        cause,
        HttpClientError.isHttpClientError(cause) ? "HTTP request failed" : "Failed to decode response",
      ),
    ),
  )

const accountErrorFromCause = (cause: unknown, message: string): AccountError => {
  if (cause instanceof AccountServiceError || cause instanceof AccountTransportError) {
    return cause
  }

  if (HttpClientError.isHttpClientError(cause)) {
    switch (cause.reason._tag) {
      case "TransportError": {
        return AccountTransportError.fromHttpClientError(cause.reason)
      }
      default: {
        return new AccountServiceError({ message, cause })
      }
    }
  }

  return new AccountServiceError({ message, cause })
}

const toPollResult = (result: Exclude<DevicePollResult, { _tag: "success" }>): PollResult => {
  switch (result._tag) {
    case "pending":
      return new PollPending()
    case "slow_down":
      return new PollSlow()
    case "expired":
      return new PollExpired()
    case "access_denied":
      return new PollDenied()
    case "error":
      return new PollError({ cause: result.error })
  }
}

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountError>
  readonly activeOrg: () => Effect.Effect<Option.Option<ActiveOrg>, AccountError>
  readonly list: () => Effect.Effect<Info[], AccountError>
  readonly orgsByAccount: () => Effect.Effect<readonly AccountOrgs[], AccountError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountError>
  readonly orgs: (accountID: AccountID) => Effect.Effect<readonly Org[], AccountError>
  readonly config: (
    accountID: AccountID,
    orgID: OrgID,
  ) => Effect.Effect<Option.Option<Record<string, unknown>>, AccountError>
  readonly token: (accountID: AccountID) => Effect.Effect<Option.Option<AccessToken>, AccountError>
  readonly login: (url: string) => Effect.Effect<Login, AccountError>
  readonly poll: (input: Login) => Effect.Effect<PollResult, AccountError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Account") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, AccountRepo.Service | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* AccountRepo.Service
    const http = yield* HttpClient.HttpClient
    const httpRead = withTransientReadRetry(http)

    const refreshToken = Effect.fnUntraced(function* (row: AccountRow) {
      const now = yield* Clock.currentTimeMillis

      const parsed = yield* refreshDeviceToken(http, row.url, row.refresh_token).pipe(mapSharedAccountError)

      const expiry = Option.some(now + parsed.expires_in * 1000)
      const accessToken = AccessToken.make(parsed.access_token)

      yield* repo.persistToken({
        accountID: row.id,
        accessToken,
        refreshToken: RefreshToken.make(parsed.refresh_token),
        expiry,
      })

      return accessToken
    })

    const refreshTokenCache = yield* Cache.make<AccountID, AccessToken, AccountError>({
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: Duration.zero,
      lookup: Effect.fnUntraced(function* (accountID) {
        const maybeAccount = yield* repo.getRow(accountID)
        if (Option.isNone(maybeAccount)) {
          return yield* Effect.fail(new AccountServiceError({ message: "Account not found during token refresh" }))
        }

        const account = maybeAccount.value
        const now = yield* Clock.currentTimeMillis
        if (isTokenFresh(account.token_expiry, now)) {
          return account.access_token
        }

        return yield* refreshToken(account)
      }),
    })

    const resolveToken = Effect.fnUntraced(function* (row: AccountRow) {
      const now = yield* Clock.currentTimeMillis
      if (isTokenFresh(row.token_expiry, now)) {
        return row.access_token
      }

      return yield* Cache.get(refreshTokenCache, row.id)
    })

    const resolveAccess = Effect.fnUntraced(function* (accountID: AccountID) {
      const maybeAccount = yield* repo.getRow(accountID)
      if (Option.isNone(maybeAccount)) return Option.none()

      const account = maybeAccount.value
      const accessToken = yield* resolveToken(account)
      return Option.some({ account, accessToken })
    })

    const fetchOrgs = Effect.fnUntraced(function* (url: string, accessToken: AccessToken) {
      const orgs = yield* getOrganizations(httpRead, url, accessToken).pipe(mapSharedAccountError)

      return orgs.map((org) => new Org({ id: OrgID.make(org.id), name: org.name }))
    })

    const fetchUser = Effect.fnUntraced(function* (url: string, accessToken: AccessToken) {
      const user = yield* getUser(httpRead, url, accessToken).pipe(mapSharedAccountError)

      return new User({ id: AccountID.make(user.id), email: user.email })
    })

    const token = Effect.fn("Account.token")((accountID: AccountID) =>
      resolveAccess(accountID).pipe(Effect.map(Option.map((r) => r.accessToken))),
    )

    const activeOrg = Effect.fn("Account.activeOrg")(function* () {
      const activeAccount = yield* repo.active()
      if (Option.isNone(activeAccount)) return Option.none<ActiveOrg>()

      const account = activeAccount.value
      if (!account.active_org_id) return Option.none<ActiveOrg>()

      const accountOrgs = yield* orgs(account.id)
      const org = accountOrgs.find((item) => item.id === account.active_org_id)
      if (!org) return Option.none<ActiveOrg>()

      return Option.some({ account, org })
    })

    const orgsByAccount = Effect.fn("Account.orgsByAccount")(function* () {
      const accounts = yield* repo.list()
      return yield* Effect.forEach(
        accounts,
        (account) =>
          orgs(account.id).pipe(
            Effect.catch(() => Effect.succeed([] as readonly Org[])),
            Effect.map((orgs) => ({ account, orgs })),
          ),
        { concurrency: 3 },
      )
    })

    const orgs = Effect.fn("Account.orgs")(function* (accountID: AccountID) {
      const resolved = yield* resolveAccess(accountID)
      if (Option.isNone(resolved)) return []

      const { account, accessToken } = resolved.value

      return yield* fetchOrgs(account.url, accessToken)
    })

    const remove = Effect.fn("Account.remove")(function* (accountID: AccountID) {
      const active = yield* repo.active()
      yield* repo.remove(accountID)
      if (Option.isNone(active) || active.value.id !== accountID) return

      const next = (yield* orgsByAccount()).flatMap((group) =>
        group.orgs.map((org) => ({ accountID: group.account.id, orgID: org.id })),
      )[0]
      if (!next) return
      yield* repo.use(next.accountID, Option.some(next.orgID))
    })

    const config = Effect.fn("Account.config")(function* (accountID: AccountID, orgID: OrgID) {
      const resolved = yield* resolveAccess(accountID)
      if (Option.isNone(resolved)) return Option.none()

      const { account, accessToken } = resolved.value

      const remote = yield* getProviderConfig(httpRead, account.url, accessToken, orgID).pipe(mapSharedAccountError)
      return remote === undefined ? Option.none() : Option.some(remote)
    })

    const login = Effect.fn("Account.login")(function* (server: string) {
      const normalizedServer = normalizeServerUrl(server)
      const parsed = yield* startDeviceAuthorization(http, normalizedServer).pipe(mapSharedAccountError)

      const verification = yield* Effect.try({
        try: () => resolveVerificationUrl(normalizedServer, parsed.verification_uri_complete),
        catch: (cause) => new AccountServiceError({ message: "Invalid device verification URL", cause }),
      })
      return new Login({
        code: DeviceCode.make(parsed.device_code),
        user: UserCode.make(parsed.user_code),
        url: verification,
        server: normalizedServer,
        expiry: Duration.seconds(parsed.expires_in),
        interval: Duration.seconds(parsed.interval),
      })
    })

    const poll = Effect.fn("Account.poll")(function* (input: Login) {
      const result = yield* pollDeviceToken(http, input.server, input.code).pipe(mapSharedAccountError)

      if (result._tag !== "success") return toPollResult(result)

      const accessToken = AccessToken.make(result.accessToken)
      const user = fetchUser(input.server, accessToken)
      const orgs = fetchOrgs(input.server, accessToken)

      const [account, remoteOrgs] = yield* Effect.all([user, orgs], { concurrency: 2 })

      // TODO: When there are multiple orgs, let the user choose
      const firstOrgID = remoteOrgs.length > 0 ? Option.some(remoteOrgs[0].id) : Option.none<OrgID>()

      const now = yield* Clock.currentTimeMillis
      const expiry = now + result.expiresIn * 1000
      const refreshToken = RefreshToken.make(result.refreshToken)

      yield* repo.persistAccount({
        id: account.id,
        email: account.email,
        url: input.server,
        accessToken,
        refreshToken,
        expiry,
        orgID: firstOrgID,
      })

      return new PollSuccess({ email: account.email })
    })

    return Service.of({
      active: repo.active,
      activeOrg,
      list: repo.list,
      orgsByAccount,
      remove,
      use: repo.use,
      orgs,
      config,
      token,
      login,
      poll,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [AccountRepo.node, httpClient] })

export * as Account from "./account"
