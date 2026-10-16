import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import { TelegramApi } from "../../src/server/routes/instance/httpapi/groups/telegram"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"
import { request } from "./httpapi-layer"

/** Tests the production, standalone Tier-0 route definitions, not a mock URL tree. */
const sanitized = {
  enabled: false,
  configured: true,
  connected: true,
  botUsername: "OpenForkBot",
  chatLabel: "private test chat",
  owner: false,
  services: [{ id: "quota", title: "Quota resets", enabled: false }],
}
const quota = { enabled: false, subscriptions: [], scheduled: 0 }

const httpLayer = HttpRouter.serve(
  HttpApiBuilder.layer(TelegramApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(TelegramApi, "telegram", (handlers) =>
        handlers
          .handle("status", () => Effect.succeed(sanitized))
          .handle("update", (ctx) => Effect.succeed({ ...sanitized, enabled: ctx.payload.enabled }))
          .handle("configure", () => Effect.succeed(sanitized))
          .handle("disconnect", () => Effect.succeed({ ...sanitized, configured: false, connected: false }))
          .handle("beginPairing", () => Effect.succeed({ ...sanitized, connected: false, pairingUrl: "https://t.me/OpenForkBot?start=test" }))
          .handle("checkPairing", () => Effect.succeed(sanitized))
          .handle("test", () => Effect.succeed(sanitized))
          .handle("quotaStatus", () => Effect.succeed(quota))
          .handle("quotaUpdate", (ctx) =>
            Effect.succeed({ enabled: ctx.payload.enabled, subscriptions: ctx.payload.subscriptions, scheduled: 0 })),
      ),
    ),
    Layer.provide(authorizationLayer),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(NodeServices.layer))

const it = testEffect(httpLayer)

describe("Telegram notification group / standalone Tier-0 HTTP contract", () => {
  it.live("serves generic connection status without workspace context or credentials", () =>
    Effect.gen(function* () {
      const response = yield* request("/global/telegram")
      expect(response.status).toBe(200)
      const json = yield* response.json
      expect(json).toMatchObject({ configured: true, connected: true, services: [{ id: "quota", enabled: false }] })
      expect(JSON.stringify(json)).not.toContain("123456789:")
    }),
  )

  it.live("updates the master switch without touching per-service subscriptions", () =>
    Effect.gen(function* () {
      const response = yield* request("/global/telegram", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ enabled: true, services: [{ id: "quota", enabled: false }] })
    }),
  )

  it.live("keeps the quota service under its own namespace with stable account identity", () =>
    Effect.gen(function* () {
      const response = yield* request("/global/telegram/services/quota", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          subscriptions: [{
            providerId: "opencode-go", scope: "account", accountId: "stable-A",
            windowKey: "weekly", enabled: true,
          }],
        }),
      })
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        enabled: true, scheduled: 0,
        subscriptions: [{ providerId: "opencode-go", scope: "account", accountId: "stable-A", windowKey: "weekly", enabled: true }],
      })
    }),
  )

  it.live("rejects malformed input at schema boundary", () =>
    Effect.gen(function* () {
      const response = yield* request("/global/telegram/services/quota", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, subscriptions: "not-an-array" }),
      })
      expect(response.status).toBe(400)
    }),
  )
})
