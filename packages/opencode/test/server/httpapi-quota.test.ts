import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import { QuotaApi } from "../../src/server/routes/instance/httpapi/groups/quota"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))

/**
 * Negative ownership invariant for the quota group.
 *
 * Quota is advisory, process-global display state, so it must not cross
 * `InstanceContextMiddleware` / `WorkspaceRoutingMiddleware`. This layer mounts
 * the *production* `QuotaApi` group definition but provides none of the
 * instance/workspace runtime: no InstanceStore, no workspace routing, no
 * instance context. If the group ever starts depending on them, building or
 * serving this layer fails instead of silently bootstrapping a workspace.
 */
const quotaOwnershipLayer = HttpRouter.serve(
  HttpApiBuilder.layer(QuotaApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(QuotaApi, "quota", (handlers) =>
        handlers
          .handle("providers", () => Effect.succeed({ providers: [] }))
          .handle("get", () => Effect.die("quota.get is not exercised by the ownership probe")),
      ),
    ),
    Layer.provide(authorizationLayer),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode", publicUrl: "" })),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(NodeServices.layer))

const itProbe = testEffect(quotaOwnershipLayer)

// Quota reads target live provider account endpoints, so these route tests
// only exercise the registry envelope and error mapping; provider payload
// semantics are covered by test/quota/providers.test.ts with fakes.
describe("QuotaHttpApi", () => {
  it.effect("lists registered quota providers", () =>
    Effect.gen(function* () {
      const response = yield* request("/quota/providers")
      expect(response.status).toBe(200)
      const body = yield* response.json as unknown as Effect.Effect<{ providers?: unknown[] }>
      expect(Array.isArray(body.providers)).toBe(true)
      const ids = (body.providers as { providerId: string }[]).map((provider) => provider.providerId)
      expect(ids).toContain("opencode-go")
      expect(ids).toContain("openrouter")
      expect(ids).toContain("kimi-for-coding")
      expect(ids).toContain("deepseek")
      for (const provider of body.providers as { configured: unknown }[]) {
        expect(typeof provider.configured).toBe("boolean")
      }
    }))

  it.effect("returns 404 for an unsupported quota provider", () =>
    Effect.gen(function* () {
      const response = yield* request("/quota/does-not-exist")
      expect(response.status).toBe(404)
    }))
})

describe("QuotaHttpApi ownership", () => {
  itProbe.live("serves quota providers with no instance or workspace runtime", () =>
    Effect.gen(function* () {
      // No x-opencode-directory header and no directory/workspace query: a
      // Tier 0/1 read must answer without materializing a workspace.
      const response = yield* request("/quota/providers")
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ providers: [] })
    }),
  )
})
