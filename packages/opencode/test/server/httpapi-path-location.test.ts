import { NodeHttpServer } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Session } from "../../src/session/session"
import { PathApi } from "../../src/server/routes/instance/httpapi/groups/path"
import { pathHandlers } from "../../src/server/routes/instance/httpapi/handlers/path"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import path from "path"

const projectLayer = LayerNode.compile(LayerNode.group([ProjectV2.node, FSUtil.node]))

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

// The production path route is served without an InstanceStore in the layer
// graph. Its explicit location is resolved through the durable project owner.
const routes = HttpRouter.serve(
  HttpApiBuilder.layer(PathApi).pipe(
    Layer.provide(pathHandlers),
    Layer.provide([
      explicitWorkspaceRouting,
      Layer.succeed(Authorization, Authorization.of((effect) => effect)),
      Layer.mock(Session.Service)({}),
    ]),
    Layer.provide(projectLayer),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const it = testEffect(Layer.merge(routes, projectLayer))

it.live("GET /path returns explicit location metadata without InstanceStore", Effect.gen(function* () {
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(async () => tmpdir({ git: true })),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
  const missingLocation = yield* HttpClientRequest.get("/path").pipe(HttpClient.execute)
  expect(missingLocation.status).toBe(400)
  const relativeLocation = yield* HttpClientRequest.get("/path?directory=relative-workspace").pipe(HttpClient.execute)
  expect(relativeLocation.status).toBe(400)

  const response = yield* HttpClientRequest.get(`/path?directory=${encodeURIComponent(tmp.path)}`).pipe(
    HttpClient.execute,
  )
  expect(response.status).toBe(200)
  const body = (yield* response.json) as unknown as {
    home: string
    state: string
    config: string
    worktree: string
    directory: string
  }
  expect(body).toMatchObject({
    home: expect.any(String),
    state: expect.any(String),
    config: expect.any(String),
    worktree: tmp.path,
    directory: tmp.path,
  })
}))
