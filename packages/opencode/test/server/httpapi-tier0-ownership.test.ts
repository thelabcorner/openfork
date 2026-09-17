import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ForkCredentials } from "../../src/fork/credentials"
import { Usage } from "../../src/usage/usage"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { forkCredentialHandlers } from "../../src/server/routes/instance/httpapi/handlers/fork-credential"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { providerSettingsHandlers } from "../../src/server/routes/instance/httpapi/handlers/provider-settings"
import { usageHandlers } from "../../src/server/routes/instance/httpapi/handlers/usage"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

/**
 * Negative ownership invariant.
 *
 * This layer intentionally does NOT provide InstanceStore, workspace routing,
 * Location, Provider, Plugin, MCP, ToolRegistry, LSP, or any directory runtime.
 * These requests must therefore remain process-global by construction.
 */
const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([
      controlHandlers,
      controlPlaneHandlers,
      forkCredentialHandlers,
      globalHandlers,
      providerSettingsHandlers,
      usageHandlers,
    ]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(
    Layer.mock(Auth.Service)({
      all: () => Effect.succeed({}),
    }),
  ),
  Layer.provide(
    Layer.mock(Config.Service)({
      getGlobal: () => Effect.succeed({}),
    }),
  ),
  Layer.provide(Layer.mock(ForkCredentials.Service)({})),
  Layer.provide(Layer.mock(SessionUsage.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(ModelsDev.Service)({
      get: () => Effect.succeed({}),
      refresh: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(Credential.Service)({
      all: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(
    Layer.mock(EventV2.Service)({
      publish: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(Usage.Service)({
      summary: () => Effect.die("unused usage summary"),
      modelProfile: () => Effect.succeed({ models: [] }),
      pricingCatalog: () => Effect.succeed({ models: [] }),
      recordMaintenance: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
)

const it = testEffect(apiLayer)

describe("Tier-0 root ownership", () => {
  it.live("serves provider settings without a workspace runtime", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/provider-settings").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ providers: [] })
    }),
  )

  it.live("serves provider settings models without a workspace runtime", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/provider-settings/models").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ models: [] })
    }),
  )

  it.live("serves usage model profile without a workspace runtime", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/usage/model-profile").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ models: [] })
    }),
  )
})
