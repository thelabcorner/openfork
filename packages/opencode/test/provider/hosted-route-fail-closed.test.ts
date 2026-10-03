import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import { ProviderRouteHealth } from "@opencode-ai/core/provider-route-health"
import { Integration } from "@opencode-ai/schema/integration"
import { Provider } from "@/provider/provider"
import { resetZenPoolForTest, setTestZenVaultCredentials } from "@/plugin/zen"
import { testEffect } from "../lib/effect"

/**
 * Real-boundary proof for the hosted route invariant.
 *
 * These tests run the production `Provider` layer (credential store, account
 * projection, route policy, public eligibility) rather than a fake, because the
 * defect they guard is precisely a fake-invisible one: a hosted provider that
 * resolves to `undefined` hands the caller back to ambient credentials.
 */

const integrationID = Integration.ID.make("opencode")
const methodID = Integration.MethodID.make("device")
const hostedProviderID = ProviderV2.ID.make("opencode")
const hostedModelID = ModelV2.ID.make("jev-1.13")
const thirdPartyProviderID = ProviderV2.ID.make("third-party-direct")
const thirdPartyModelID = ModelV2.ID.make("direct-model")

const AMBIENT_POOL_SECRET = "ambient-legacy-pool-secret"
const AMBIENT_CONFIG_KEY = "ambient-configured-provider-key"

const oauth = (access: string, accountID: string) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID,
    access,
    refresh: `refresh-${access}`,
    expires: Date.now() + 60 * 60_000,
    metadata: {
      server: "https://console.example/console",
      orgID: accountID,
      accountID,
      email: `${accountID}@example.test`,
    },
  })

// The hosted catalog witness is the only network-shaped input the hosted
// fail-closed path could reach. Advertising nothing keeps the model ineligible
// for Public, which is the exact production state under audit.
const client = HttpClient.make((request) =>
  Effect.sync(() => {
    if (request.url.startsWith("https://models.opencode.ai/models.json")) {
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } }),
      )
    }
    return HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify({ error: "not stubbed" }), { status: 404, headers: { "content-type": "application/json" } }),
    )
  }),
)

const layer = LayerNode.compile(
  LayerNode.group([Provider.node, Credential.node, ProviderRoute.node, ProviderRouteHealth.node, Database.node]),
  [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]],
)
const it = testEffect(layer)

afterEach(() => {
  setTestZenVaultCredentials(undefined)
  resetZenPoolForTest()
})

describe("hosted provider route authority", () => {
  it.instance(
    "refuses a hosted model when no credential is projectable at all",
    () =>
    Effect.gen(function* () {
      // Genuinely empty inventory: no env key, no fork-vault key, no legacy
      // auth key. A populated pool is now an authoritative projected compat
      // candidate and must never be used as this fixture.
      setTestZenVaultCredentials([])
      const provider = yield* Provider.Service

      const transient = yield* provider
        .resolveTransientRoutedModel({
          providerID: hostedProviderID,
          modelID: hostedModelID,
          routeIntent: { kind: "auto" },
        })
        .pipe(Effect.flip)

      expect(transient._tag).toBe("ProviderRouteResolutionError")
      expect(String((transient.cause as Error)?.message ?? "")).toContain("refusing ambient credential fallback")

      const durable = yield* provider
        .resolveRoutedModel({
          sessionID: "ses_hostedfailclosed" as never,
          providerID: hostedProviderID,
          modelID: hostedModelID,
          routeIntent: { kind: "auto" },
        })
        .pipe(Effect.flip)

      expect(durable._tag).toBe("ProviderRouteResolutionError")
      expect(String((durable.cause as Error)?.message ?? "")).toContain("refusing ambient credential fallback")
    }),
    30000,
  )

  it.instance("keeps the mature direct path for a third-party provider the routing domain does not own", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service

      const result = yield* provider.resolveTransientRoutedModel({
        providerID: thirdPartyProviderID,
        modelID: thirdPartyModelID,
        routeIntent: { kind: "auto" },
      })

      expect(result).toBeUndefined()
    }),
    30000,
  )

  it.instance("fails an explicit hosted account pin closed when the account cannot serve the model", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const credentials = yield* Credential.Service
      const added = yield* credentials.add({
        integrationID,
        label: "Unsupported model account",
        value: oauth("unsupported-model-access", "account-unsupported"),
      })
      yield* Effect.addFinalizer(() => credentials.remove(added.id).pipe(Effect.asVoid))

      const pinned = yield* provider
        .resolveTransientRoutedModel({
          providerID: hostedProviderID,
          modelID: hostedModelID,
          routeIntent: { kind: "account", accountID: "account-unsupported", pin: "hard" },
        })
        .pipe(Effect.flip)

      expect(pinned._tag).toBe("ProviderRouteResolutionError")
    }),
    30000,
  )

  it.instance("rejects a legacy account id that conflicts with an explicit public intent", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service

      const conflict = yield* provider
        .resolveTransientRoutedModel({
          providerID: hostedProviderID,
          modelID: hostedModelID,
          accountID: "account-a",
          routeIntent: { kind: "public" },
        })
        .pipe(Effect.flip)

      expect(conflict._tag).toBe("ProviderRouteResolutionError")
      expect((conflict.cause as { _tag?: string })?._tag).toBe("ProviderRouteIntent.Conflict")
    }),
    30000,
  )
})

// Referenced so the ambient configured key is part of this suite's stated
// preconditions even though the Provider layer never reads it for a hosted
// route.
void AMBIENT_CONFIG_KEY
