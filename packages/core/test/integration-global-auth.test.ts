import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalIntegrationAuth } from "@opencode-ai/core/integration/global-auth"
import { Integration } from "@opencode-ai/schema/integration"
import { testEffect } from "./lib/effect"

const http = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      request.url.endsWith("/auth/device/code")
        ? Response.json({
            device_code: "device-global",
            user_code: "USER-CODE",
            verification_uri_complete: "/console/device?user_code=USER-CODE&client_id=opencode-cli",
            expires_in: 600,
            interval: 0,
          })
        : request.url.endsWith("/auth/device/token")
          ? Response.json({
              access_token: "access-global",
              refresh_token: "refresh-global",
              expires_in: 3600,
            })
          : request.url.endsWith("/api/user")
            ? Response.json({ id: "user-global", email: "global@example.com" })
            : request.url.endsWith("/api/orgs")
              ? Response.json([{ id: "org-global", name: "Global Org" }])
              : new Response("not found", { status: 404 }),
    ),
  ),
)

const layer = AppNodeBuilder.build(LayerNode.group([GlobalIntegrationAuth.node, Credential.node]), [
  [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, http)],
])

const it = testEffect(layer)

describe("GlobalIntegrationAuth", () => {
  it.effect("registers OpenCode auth methods without a location runtime", () =>
    Effect.gen(function* () {
      const auth = yield* GlobalIntegrationAuth.Service
      expect(yield* auth.methods(Integration.ID.make("opencode"))).toEqual([
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          label: "OpenCode Console account",
        },
        {
          type: "key",
          label: "API key (service account)",
        },
      ])
      expect(yield* auth.methods(Integration.ID.make("unknown"))).toEqual([])
    }),
  )

  it.effect("settles the real OpenCode device flow into the global Credential store", () =>
    Effect.gen(function* () {
      const auth = yield* GlobalIntegrationAuth.Service
      const credentials = yield* Credential.Service

      const attempt = yield* auth.oauth({
        integrationID: Integration.ID.make("opencode"),
        methodID: Integration.MethodID.make("device"),
        inputs: {},
      })

      expect(attempt).toMatchObject({
        mode: "auto",
        url: "https://opencode.ai/console/device?user_code=USER-CODE&client_id=opencode-cli",
        instructions: "Enter code: USER-CODE",
      })

      let status = yield* auth.attempt.status(attempt.attemptID)
      for (let i = 0; i < 100 && status.status === "pending"; i++) {
        yield* Effect.yieldNow
        status = yield* auth.attempt.status(attempt.attemptID)
      }
      expect(status).toEqual({
        status: "complete",
        time: attempt.time,
      })

      const saved = yield* credentials.list(Integration.ID.make("opencode"))
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({
        integrationID: "opencode",
        label: "Global Org",
        revision: 1,
        value: {
          type: "oauth",
          methodID: "device",
          access: "access-global",
          refresh: "refresh-global",
          metadata: {
            server: "https://opencode.ai/console",
            accountID: "user-global",
            email: "global@example.com",
            orgID: "org-global",
            orgName: "Global Org",
          },
        },
      })
    }),
  )
})
