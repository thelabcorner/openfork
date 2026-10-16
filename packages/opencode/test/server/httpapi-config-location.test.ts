import { NodeHttpServer } from "@effect/platform-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { ProjectV2 } from "@opencode-ai/core/project"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { Session } from "../../src/session/session"
import { ConfigReadApi } from "../../src/server/routes/instance/httpapi/groups/config"
import { configReadHandlers } from "../../src/server/routes/instance/httpapi/handlers/config"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import path from "path"
import os from "os"
import fs from "fs/promises"

const unexpectedHttp = HttpClient.make((request) => Effect.die(`unexpected config HTTP request: ${request.url}`))
const npmInstallCalls = Ref.makeUnsafe(0)
const npmLayer = Layer.mock(Npm.Service)({
  install: () => Ref.update(npmInstallCalls, (count) => count + 1),
})

const configLayer = LayerNode.compile(
  LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node, ProjectV2.node]),
  [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, npmLayer],
    [httpClient, Layer.succeed(HttpClient.HttpClient, unexpectedHttp)],
  ],
)

const explicitWorkspaceRouting = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      const directory = url.searchParams.get("directory") ?? request.headers["x-opencode-directory"]
      if (!directory || !path.isAbsolute(directory)) {
        return HttpServerResponse.text("an absolute directory is required", { status: 400 })
      }
      return yield* effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory }))
    }),
  ),
)

const routes = HttpRouter.serve(
  HttpApiBuilder.layer(ConfigReadApi).pipe(
    Layer.provide(configReadHandlers),
    Layer.provide([
      explicitWorkspaceRouting,
      Layer.succeed(Authorization, Authorization.of((effect) => effect)),
      Layer.mock(Session.Service)({}),
    ]),
    Layer.provide(configLayer),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const it = testEffect(routes)

it.live("GET /config returns explicit workspace config without InstanceStore", Effect.gen(function* () {
  const configSource = JSON.stringify({ username: "explicit-http-config", formatter: false, lsp: false })
  const directory = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-config-http-"))
      await fs.writeFile(path.join(root, "openfork.json"), configSource)
      return root
    }),
    (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
  )
  const missingLocation = yield* HttpClientRequest.get("/config").pipe(HttpClient.execute)
  expect(missingLocation.status).toBe(400)
  const relativeLocation = yield* HttpClientRequest.get("/config?directory=relative-workspace").pipe(HttpClient.execute)
  expect(relativeLocation.status).toBe(400)
  const response = yield* HttpClientRequest.get(`/config?directory=${encodeURIComponent(directory)}`).pipe(
    HttpClient.execute,
  )
  expect(response.status).toBe(200)
  expect(yield* response.json).toMatchObject({
    username: "explicit-http-config",
    formatter: false,
    lsp: false,
  })
  // This route graph deliberately has no InstanceStore service. A request that
  // reintroduces InstanceContextMiddleware cannot satisfy the route graph.
  expect(
    yield* Effect.promise(() =>
      Bun.file(`${directory}/.gitignore`).exists(),
    ),
  ).toBe(false)
  expect(yield* Ref.get(npmInstallCalls)).toBe(0)
  expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "openfork.json"), "utf8"))).toBe(configSource)
}))
