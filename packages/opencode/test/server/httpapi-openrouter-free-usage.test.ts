import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Credential } from "@opencode-ai/core/credential"
import { Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "@/auth"
import { ServerAuth } from "../../src/server/auth"
import {
  OpenRouterFreeUsageApi,
  OpenRouterFreeUsagePath,
} from "../../src/server/routes/instance/httpapi/groups/openrouter-free-usage"
import { openRouterFreeUsageHandlers } from "../../src/server/routes/instance/httpapi/handlers/openrouter-free-usage"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"
import { request } from "./httpapi-layer"

const auth = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

const credential = Layer.succeed(
  Credential.Service,
  Credential.Service.of({ list: () => Effect.succeed([]) } as unknown as Credential.Interface),
)

// Deliberately provide only the Tier-0 handler dependencies. There is no
// InstanceStore, WorkspaceRouteContext, workspace router, or execution graph.
const ownershipLayer = HttpRouter.serve(
  HttpApiBuilder.layer(OpenRouterFreeUsageApi).pipe(
    Layer.provide(openRouterFreeUsageHandlers),
    Layer.provide(auth),
    Layer.provide(credential),
    Layer.provide(authorizationLayer),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(NodeServices.layer))

const it = testEffect(ownershipLayer)

it.live("OpenRouter free usage is account-global with or without legacy workspace query values", () =>
  Effect.gen(function* () {
    const previousManagementKey = process.env.OPENROUTER_MANAGEMENT_KEY
    const previousApiKey = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    delete process.env.OPENROUTER_API_KEY
    const restore = Effect.sync(() => {
      if (previousManagementKey === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY
      else process.env.OPENROUTER_MANAGEMENT_KEY = previousManagementKey
      if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = previousApiKey
    })
    return yield* Effect.gen(function* () {
      const explicit = yield* request(
        `${OpenRouterFreeUsagePath}?directory=${encodeURIComponent("C:/never-loaded/openrouter")}&workspace=workspace-never-loaded`,
      )
      const global = yield* request(OpenRouterFreeUsagePath)

      expect(explicit.status).toBe(200)
      expect(global.status).toBe(200)
      const explicitBody = yield* explicit.json
      const globalBody = yield* global.json
      expect(explicitBody).toMatchObject({
        free: { limit: 50, remaining: 0, status: "depleted" },
        source: { scope: "account", stale: true, upstreamCalls: 0 },
      })
      expect(globalBody).toMatchObject({
        free: { limit: 50, remaining: 0, status: "depleted" },
        source: { scope: "account", stale: true, upstreamCalls: 0 },
      })
    }).pipe(Effect.ensuring(restore))
  }),
)
