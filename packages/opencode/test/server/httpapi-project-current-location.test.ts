import { NodeHttpServer } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Session } from "../../src/session/session"
import { Project } from "../../src/project/project"
import { ProjectCurrentApi } from "../../src/server/routes/instance/httpapi/groups/project"
import { projectCurrentHandlers } from "../../src/server/routes/instance/httpapi/handlers/project"
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

const projectLayer = LayerNode.compile(LayerNode.group([Project.node, ProjectV2.node, Database.node, FSUtil.node]))

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

// Project.CurrentApi and its actual Project service are served over HTTP, but
// this route graph deliberately has no InstanceStore service available.
const routes = HttpRouter.serve(
  HttpApiBuilder.layer(ProjectCurrentApi).pipe(
    Layer.provide(projectCurrentHandlers),
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

it.live("GET /project/current resolves explicit project identity without InstanceStore", Effect.gen(function* () {
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(async () => tmpdir({ git: true })),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
  const directory = tmp.path
  const missingLocation = yield* HttpClientRequest.get("/project/current").pipe(HttpClient.execute)
  expect(missingLocation.status).toBe(400)
  const relativeLocation = yield* HttpClientRequest.get("/project/current?directory=relative-workspace").pipe(
    HttpClient.execute,
  )
  expect(relativeLocation.status).toBe(400)

  const response = yield* HttpClientRequest.get(`/project/current?directory=${encodeURIComponent(directory)}`).pipe(
    HttpClient.execute,
  )
  expect(response.status).toBe(200)
  const body = (yield* response.json) as unknown as {
    id: string
    worktree: string
    vcs: string
    sandboxes: string[]
  }
  expect(body).toMatchObject({
    id: expect.any(String),
    worktree: directory,
    vcs: "git",
    sandboxes: [],
  })

  const { readDb } = yield* Database.Service
  const projectRow = yield* readDb
    .select()
    .from(ProjectTable)
    .where(eq(ProjectTable.worktree, AbsolutePath.make(directory)))
    .get()
  const sessionRows = yield* readDb
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.directory, AbsolutePath.make(directory)))
    .all()
  expect(projectRow).toBeUndefined()
  expect(sessionRows).toEqual([])

  // ProjectV2.resolve may read this legacy repo-local identity cache; only the
  // runtime `fromDirectory` path commits it. A cold identity read stays
  // read-only. The route graph also deliberately has no InstanceStore service.
  expect(yield* Effect.promise(() => Bun.file(path.join(directory, ".git", "opencode")).exists())).toBe(false)
}))
