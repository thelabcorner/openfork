import { expect, spyOn } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"

// No outer AppNodeBuilder or execution owner: the production route graph
// itself must supply every dependency used by first-project bootstrap.
const served: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> =
  HttpRouter.serve(HttpApiApp.routes, { disableListenLog: true, disableLogger: true })
const routes = served.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(routes)
const withStore = testEffect(Layer.merge(routes, AppNodeBuilder.build(InstanceStore.node, [
  [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({
    gate: Effect.never,
    warmup: Effect.never,
  }))],
])))

it.live("standalone served graph answers global and cold-project session status", () =>
  Effect.gen(function* () {
    for (const count of [1, 3, 6]) {
      const responses = yield* Effect.forEach(
        Array.from({ length: count }, (_, index) => index),
        (index) => HttpClient.execute(HttpClientRequest.get(
          index === 0 ? "/session/status" : `/session/status?directory=${encodeURIComponent(`C:/never-loaded/status-project-${index}`)}`,
        )),
        { concurrency: count },
      )
      for (const response of responses) {
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({})
      }
    }
  }),
)

withStore.live("cold-project status never enters workspace bootstrap", () =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const load = spyOn(store, "load").mockImplementation(() => Effect.never as never)
    try {
      for (const count of [1, 3, 6]) {
        const responses = yield* Effect.forEach(
          Array.from({ length: count }, (_, index) => index),
          (index) => HttpClient.execute(HttpClientRequest.get(
            `/session/status?directory=${encodeURIComponent(`C:/never-loaded/status-project-${index}`)}`,
          )),
          { concurrency: count },
        )
        expect(responses.map((response) => response.status)).toEqual(Array.from({ length: count }, () => 200))
      }
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  }),
)
