import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { Device } from "@opencode-ai/core/device"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { ServerAuth } from "../../src/server/auth"
import {
  Authorization,
  authorizationLayer,
  ServerAuthorization,
  serverAuthorizationLayer,
} from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

const Api = HttpApi.make("test-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("missing", "/missing", {
        success: Schema.String,
        error: HttpApiError.NotFound,
      }),
    )
    .middleware(Authorization),
)

const ServerApi = HttpApi.make("test-server-authorization").add(
  HttpApiGroup.make("test.v2")
    .add(
      HttpApiEndpoint.get("probe", "/api/probe", {
        success: Schema.String,
      }),
    )
    .middleware(ServerAuthorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("missing", () => Effect.fail(new HttpApiError.NotFound({}))),
)

const serverHandlers = HttpApiBuilder.group(ServerApi, "test.v2", (handlers) =>
  handlers.handle("probe", () => Effect.succeed("ok")),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const v2ApiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(ServerApi).pipe(Layer.provide(serverHandlers), Layer.provide(serverAuthorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const noAuthLayer = ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })
const publicNoAuthLayer = ServerAuth.Config.configLayer({
  password: Option.none(),
  username: "opencode",
  publicUrl: "https://api.example.test",
})
const secretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "opencode" })
const kitSecretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "kit" })
const deviceLayer = AppNodeBuilderV1.build(Device.node)

// provideMerge keeps Device.Service (and its Database) in the test environment
// so bodies can mint devices against the SAME instance the middleware uses.
const withDevice = <A, E, R>(layer: Layer.Layer<A, E, R>) => layer.pipe(Layer.provideMerge(deviceLayer))

const it = testEffect(withDevice(apiLayer).pipe(Layer.provide(noAuthLayer)))
const itPublic = testEffect(withDevice(apiLayer).pipe(Layer.provide(publicNoAuthLayer)))
const itSecret = testEffect(withDevice(apiLayer).pipe(Layer.provide(secretLayer)))
const itKitSecret = testEffect(withDevice(apiLayer).pipe(Layer.provide(kitSecretLayer)))
const itV2Secret = testEffect(withDevice(v2ApiLayer).pipe(Layer.provide(secretLayer)))
const itV2Public = testEffect(withDevice(v2ApiLayer).pipe(Layer.provide(publicNoAuthLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")

const getProbe = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/probe").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

describe("HttpApi authorization middleware", () => {
  it.live("allows requests when server password is not configured", () =>
    Effect.gen(function* () {
      const response = yield* getProbe()

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
    }),
  )

  itPublic.live("fails closed without credentials when a public URL is configured", () =>
    Effect.gen(function* () {
      const response = yield* getProbe()
      expect(response.status).toBe(401)
    }),
  )

  itV2Public.live("fails closed on v2 routes when a public URL is configured", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/probe")
      expect(response.status).toBe(401)
    }),
  )

  itSecret.live("requires configured password for basic auth", () =>
    Effect.gen(function* () {
      const [missing, badPassword, good] = yield* Effect.all(
        [
          getProbe(),
          getProbe({ authorization: basic("opencode", "wrong") }),
          getProbe({ authorization: basic("opencode", "secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(missing.status).toBe(401)
      expect(missing.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(badPassword.status).toBe(401)
      expect(badPassword.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(good.status).toBe(200)
    }),
  )

  itKitSecret.live("respects configured basic auth username", () =>
    Effect.gen(function* () {
      const [defaultUser, configuredUser] = yield* Effect.all(
        [getProbe({ authorization: basic("opencode", "secret") }), getProbe({ authorization: basic("kit", "secret") })],
        { concurrency: "unbounded" },
      )

      expect(defaultUser.status).toBe(401)
      expect(configuredUser.status).toBe(200)
    }),
  )

  itSecret.live("accepts auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("opencode", "secret"))}`)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("prefers auth token query credentials over basic auth", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        `/probe?auth_token=${encodeURIComponent(token("opencode", "secret"))}`,
      ).pipe(HttpClientRequest.setHeader("authorization", basic("opencode", "wrong")), HttpClient.execute)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("preserves handler errors when basic auth succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/missing").pipe(
        HttpClientRequest.setHeader("authorization", basic("opencode", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("preserves handler errors when auth token query succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/missing?auth_token=${encodeURIComponent(token("opencode", "secret"))}`)

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("rejects malformed auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/probe?auth_token=not-base64")

      expect(response.status).toBe(401)
    }),
  )

  itV2Secret.live("returns bodyful v2 unauthorized errors", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/probe")
      const body = yield* response.json

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(body).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" })
    }),
  )

  itSecret.live("accepts a paired device token as a Bearer header", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const created = yield* devices.create()

      const response = yield* getProbe({ authorization: `Bearer ${created.token}` })
      expect(response.status).toBe(200)
      // last_seen is recorded on successful device auth.
      expect((yield* devices.verify(created.token))?.lastSeenAt).toBeDefined()
    }),
  )

  itSecret.live("accepts a paired device token as a Basic password with any username", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const created = yield* devices.create()

      const response = yield* getProbe({ authorization: basic("device", created.token) })
      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("accepts a paired device token as the raw auth_token query param", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const created = yield* devices.create()

      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(created.token)}`)
      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("rejects revoked device tokens in every form", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const created = yield* devices.create()
      yield* devices.revoke(created.device.id)

      const [bearer, basicAuth, query] = yield* Effect.all(
        [
          getProbe({ authorization: `Bearer ${created.token}` }),
          getProbe({ authorization: basic("device", created.token) }),
          HttpClient.get(`/probe?auth_token=${encodeURIComponent(created.token)}`),
        ],
        { concurrency: "unbounded" },
      )
      expect(bearer.status).toBe(401)
      expect(basicAuth.status).toBe(401)
      expect(query.status).toBe(401)
    }),
  )

  itSecret.live("master password still wins when presented alongside a device token", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      yield* devices.create()
      const response = yield* getProbe({ authorization: basic("opencode", "secret") })
      expect(response.status).toBe(200)
    }),
  )

  itV2Secret.live("accepts a paired device token on the v2 server surface", () =>
    Effect.gen(function* () {
      const devices = yield* Device.Service
      const created = yield* devices.create()

      const response = yield* HttpClientRequest.get("/api/probe").pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${created.token}`),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
    }),
  )
})
