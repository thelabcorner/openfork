import { NodeHttpServer } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Git } from "../../src/git"
import { Session } from "../../src/session/session"
import { VcsBranchApi } from "../../src/server/routes/instance/httpapi/groups/instance"
import { vcsBranchHandlers } from "../../src/server/routes/instance/httpapi/handlers/vcs-branch"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import path from "path"

const gitLayer = LayerNode.compile(Git.node)

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

// This is the production branch route/handler with the real explicit Git
// service, served over HTTP in a graph that has no InstanceStore service.
const routes = HttpRouter.serve(
  HttpApiBuilder.layer(VcsBranchApi).pipe(
    Layer.provide(vcsBranchHandlers),
    Layer.provide([
      explicitWorkspaceRouting,
      Layer.succeed(Authorization, Authorization.of((effect) => effect)),
      Layer.mock(Session.Service)({}),
    ]),
    Layer.provide(gitLayer),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const it = testEffect(Layer.merge(routes, gitLayer))

it.live("GET /vcs returns branch metadata without InstanceStore", Effect.gen(function* () {
  const gitTmp = yield* Effect.acquireRelease(
    Effect.promise(async () => tmpdir({ git: true })),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
  const nonGitTmp = yield* Effect.acquireRelease(
    Effect.promise(async () => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
  const gitService = yield* Git.Service

  const missingLocation = yield* HttpClientRequest.get("/vcs").pipe(HttpClient.execute)
  expect(missingLocation.status).toBe(400)
  const relativeLocation = yield* HttpClientRequest.get("/vcs?directory=relative-workspace").pipe(HttpClient.execute)
  expect(relativeLocation.status).toBe(400)

  const assertParity = Effect.fnUntraced(function* (directory: string) {
    const response = yield* HttpClientRequest.get(`/vcs?directory=${encodeURIComponent(directory)}`).pipe(
      HttpClient.execute,
    )
    expect(response.status).toBe(200)
    const body = (yield* response.json) as unknown as { branch?: string | null; default_branch?: string | null }
    const [branch, defaultBranch] = yield* Effect.all(
      [gitService.branch(directory), gitService.defaultBranch(directory)],
      { concurrency: 2 },
    )
    expect(body).toEqual({
      branch: branch ?? null,
      default_branch: defaultBranch?.name ?? null,
    })
    return body
  })

  const gitInfo = yield* assertParity(gitTmp.path)
  expect(gitInfo.branch).toBeTruthy()
  expect(gitInfo.default_branch).toBeTruthy()
  expect(yield* assertParity(nonGitTmp.path)).toEqual({ branch: null, default_branch: null })
}))
