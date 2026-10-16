import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Service as Telegram, type TelegramNotificationService } from "../../src/notification/telegram"
import { TelegramApi } from "../../src/server/routes/instance/httpapi/groups/telegram"
import { telegramHandlers } from "../../src/server/routes/instance/httpapi/handlers/telegram"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

const connection = {
  enabled: false,
  configured: false,
  connected: false,
  owner: false,
  services: [{ id: "quota", title: "Quota resets", enabled: false }],
}
const quota = { enabled: false, subscriptions: [], scheduled: 0 }

let calls = 0
const service = Telegram.of({
  status: async () => connection,
  hub: {
    setEnabled: async (_enabled: boolean) => {
      calls++
      return connection
    },
    configure: async () => connection,
    disconnect: async () => connection,
    beginPairing: async () => connection,
    checkPairing: async () => connection,
    sendTest: async () => connection,
  } as unknown as TelegramNotificationService["hub"],
  quota: {
    status: () => quota,
    update: async () => quota,
  },
})

const routes = HttpRouter.serve(
  HttpApiBuilder.layer(TelegramApi).pipe(
    Layer.provide(telegramHandlers),
    Layer.provide([
      Layer.succeed(Authorization, Authorization.of((effect) => effect)),
      Layer.succeed(Telegram, service),
    ]),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const it = testEffect(routes)

describe("Telegram route to first-party generic hub", () => {
  it.live("GET status and GET quota settings stay separate and do not need InstanceStore", Effect.gen(function* () {
    const response = yield* HttpClientRequest.get("/global/telegram").pipe(HttpClient.execute)
    expect(response.status).toBe(200)
    expect(yield* response.json).toMatchObject({
      enabled: false, configured: false,
      services: [{ id: "quota", enabled: false }],
    })

    const quotas = yield* HttpClientRequest.get("/global/telegram/services/quota").pipe(HttpClient.execute)
    expect(quotas.status).toBe(200)
    expect(yield* quotas.json).toEqual(quota)
    // The route test deliberately did not provide Quota, InstanceStore, or
    // any project/session context. They must not be constructed for Settings.
  }))

  it.live("PATCH master enablement is delegated once to hub without editing quota-source preferences", Effect.gen(function* () {
    const before = calls
    const response = yield* HttpClientRequest.patch("/global/telegram").pipe(
      HttpClientRequest.bodyJsonUnsafe({ enabled: true }),
      HttpClient.execute,
    )
    expect(response.status).toBe(200)
    expect(calls - before).toBe(1)
    expect(yield* response.json).toMatchObject({ enabled: false, services: [{ id: "quota" }] })
    expect(quota.enabled).toBe(false)
  }))
})
