import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  WorkspaceRouteContext | HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = Date.now()
    const ctx = yield* store.load({
      directory: route.directory,
      attribution: {
        caller: "http",
        route: `${request.method} ${new URL(request.url, "http://localhost").pathname}`,
      },
    })
    const waitedMs = Date.now() - startedAt
    // Diagnostics: requests queue behind cold instance bootstraps (see
    // InstanceStore.boot); surface any meaningful wait so slow first paints
    // on a directory can be attributed without attaching a profiler.
    if (waitedMs > 200)
      yield* Effect.logWarning("instance load delayed request", { directory: route.directory, ms: waitedMs })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
