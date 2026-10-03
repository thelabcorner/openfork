import { afterAll, describe, expect } from "bun:test"
import { Credential } from "@opencode-ai/core/credential"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Credential as CredentialNode } from "@opencode-ai/core/credential"
import { projectCredential } from "@opencode-ai/core/plugin/provider/opencode-provider-account"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Integration } from "@opencode-ai/schema/integration"
import { Deferred, Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import * as ProviderCatalog from "@/provider/catalog"
import * as ProviderCatalogContributions from "@/provider/catalog-contributions"
import { Provider } from "@/provider/provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { ServerEvent } from "@opencode-ai/schema/server-event"
import { t3CodeAccountModelID, OPENFORK_COMPAT_PROFILE_ENV, T3_CODE_COMPAT_PROFILE } from "@/compat/t3code"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const providerExecution = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Provider.node,
      Env.node,
      Plugin.node,
      Config.node,
      Auth.node,
      RuntimeFlags.node,
      EventV2.node,
      ProviderCatalogContributions.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

const integrationID = Integration.ID.make("opencode")
const methodID = Integration.MethodID.make("device")
const accountSecret = "catalog-account-secret-never-return-this"
const account = Credential.OAuth.make({
  type: "oauth",
  methodID,
  access: accountSecret,
  refresh: "catalog-refresh-secret",
  expires: Date.now() + 60 * 60_000,
  metadata: {
    server: "https://console-catalog.example",
    accountID: "catalog-remote-user",
    orgID: "catalog-org",
    email: "catalog@example.test",
  },
})

const configResponse = {
  config: {
    provider: {
      "catalog-provider": {
        name: "Catalog Account Provider",
        api: "https://inference-catalog.example/v1",
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "must-be-redacted" },
        models: {
          flash: {
            id: "wire-flash",
            name: "Flash",
            cost: { input: 1, output: 2 },
            limit: { context: 32_000, output: 4_096 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
      hidden: {
        models: {
          secret: { id: "hidden", name: "Hidden", cost: { input: 1, output: 1 } },
        },
      },
    },
  },
}

let fetchCount = 0
let rejectAccountFetch = false
const priorProfile = process.env[OPENFORK_COMPAT_PROFILE_ENV]
process.env[OPENFORK_COMPAT_PROFILE_ENV] = T3_CODE_COMPAT_PROFILE
const client = HttpClient.make((request) =>
  Effect.sync(() => {
    fetchCount++
    if (request.method !== "GET" || !request.url.endsWith("/api/config")) {
      throw new Error(`Unexpected catalog request: ${request.method} ${request.url}`)
    }
    if (rejectAccountFetch) throw new Error("Console config temporarily unavailable")
    return HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(configResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }),
)
const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)
const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    LayerNode.compile(CredentialNode.node),
    LayerNode.compile(ProviderCatalogContributions.node),
    LayerNode.compile(ProviderCatalog.node, [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]]),
  ),
)

describe("ProviderCatalog T3 account projection", () => {
  it.effect(
    "bounds location contributions and keeps revisions monotonic after eviction",
    Effect.gen(function* () {
      const contributions = yield* ProviderCatalogContributions.Service
      const revisions: number[] = []
      for (let index = 0; index < 33; index++) {
        revisions.push(
          yield* contributions.publish({
            directory: `/catalog-location-${index}`,
            providers: {},
            status: "partial",
          }),
        )
      }
      expect(contributions.get("/catalog-location-0")).toBeUndefined()
      expect(contributions.get("/catalog-location-32")).toBeDefined()
      const reentered = yield* contributions.publish({
        directory: "/catalog-location-0",
        providers: {},
        status: "partial",
      })
      expect(reentered).toBeGreaterThan(revisions[32]!)
      expect(contributions.get("/catalog-location-1")).toBeUndefined()
    }),
  )

  providerExecution.instance(
    "selected model resolution does not wait for a blocked catalog update listener",
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const listenerStarted = yield* Deferred.make<void>()
      const releaseListener = yield* Deferred.make<void>()
      const latestNotified = yield* Deferred.make<void>()
      let finalRevision = Number.MAX_SAFE_INTEGER
      const revisions: number[] = []
      const unsubscribe = yield* events.listenType(ServerEvent.ProviderCatalogUpdated, (event) =>
        Effect.gen(function* () {
          revisions.push(event.data.revision)
          yield* Deferred.succeed(listenerStarted, undefined)
          yield* Deferred.await(releaseListener)
          if (event.data.revision >= finalRevision) yield* Deferred.succeed(latestNotified, undefined)
        }),
      )

      yield* Effect.gen(function* () {
        for (const count of [1, 3, 6]) {
          const result = yield* Effect.all(
            Array.from({ length: count }, (_, index) =>
              Provider.use.getModel(ProviderV2.ID.make(`catalog-selected-${index}`), ModelV2.ID.make("active-model")),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("3 seconds"))
          expect(result).toBeDefined()
          expect(result?.length).toBe(count)
          if (count === 1) yield* Deferred.await(listenerStarted).pipe(Effect.timeout("3 seconds"))
        }

        const directory = yield* InstanceState.directory
        finalRevision = (yield* ProviderCatalogContributions.Service).get(directory)!.revision
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseListener, undefined)),
        Effect.ensuring(unsubscribe),
      )

      yield* Deferred.await(latestNotified).pipe(Effect.timeout("3 seconds"))
      expect(revisions.length).toBeLessThanOrEqual(2)
      expect(revisions[revisions.length - 1]).toBe(finalRevision)
    }),
    {
      config: {
        provider: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
          `catalog-selected-${index}`,
          {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "catalog-selected-key" },
            models: { "active-model": { name: "Active model" } },
          },
        ])),
      },
    },
    15_000,
  )

  it.effect(
    "materializes filtered account aliases asynchronously and invalidates on credential changes",
    Effect.gen(function* () {
      fetchCount = 0
      rejectAccountFetch = false
      const credentials = yield* Credential.Service
      const stored = yield* credentials.add({ integrationID, label: "Catalog User", value: account })
      const identity = projectCredential(stored)!
      const catalog = yield* ProviderCatalog.Service
      const contributions = yield* ProviderCatalogContributions.Service
      yield* contributions.publish({ directory: "/catalog-workspace", providers: {}, status: "ready" })

      const first = yield* catalog.list({
        directory: "/catalog-workspace",
        config: { disabled_providers: ["hidden"] },
      })
      expect(first.catalog.status).toBe("partial")
      expect(first.all.some((provider) => provider.id === "catalog-provider")).toBe(false)

      // The call to Console /api/config runs in the detached projection owner;
      // waiting here models completion without making the catalog request wait.
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
      const ready = yield* catalog.list({
        directory: "/catalog-workspace",
        config: { disabled_providers: ["hidden"] },
      })
      const provider = ready.all.find((item) => item.id === ProviderV2.ID.make("catalog-provider"))
      const aliasID = ModelV2.ID.make(t3CodeAccountModelID("flash", identity.accountID))
      expect(ready.catalog.status).toBe("ready")
      expect(ready.catalog.revision).toBeGreaterThan(first.catalog.revision)
      expect(provider?.models[aliasID]?.name).toBe("Flash (Catalog User)")
      expect(ready.default["catalog-provider"]).toBe(aliasID)
      expect(ready.connected).toContain("catalog-provider")
      expect(ready.all.some((item) => item.id === "hidden")).toBe(false)
      expect(JSON.stringify(ready)).not.toContain(accountSecret)
      expect(JSON.stringify(ready)).not.toContain("must-be-redacted")

      yield* credentials.update(stored.id, { label: "Renamed Account" })
      const updatePending = yield* catalog.list({
        directory: "/catalog-workspace",
        config: { disabled_providers: ["hidden"] },
      })
      expect(updatePending.catalog.status).toBe("partial")
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
      const updated = yield* catalog.list({
        directory: "/catalog-workspace",
        config: { disabled_providers: ["hidden"] },
      })
      const updatedProvider = updated.all.find((item) => item.id === ProviderV2.ID.make("catalog-provider"))
      expect(updated.catalog.status).toBe("ready")
      expect(updated.catalog.revision).toBeGreaterThan(ready.catalog.revision)
      expect(updatedProvider?.models[aliasID]?.name).toBe("Flash (Renamed Account)")

      yield* credentials.remove(stored.id)
      const withdrawalPending = yield* catalog.list({
        directory: "/catalog-workspace",
        config: { disabled_providers: ["hidden"] },
      })
      expect(withdrawalPending.catalog.status).toBe("partial")
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
      const withdrawn = yield* catalog.list({
        directory: "/catalog-workspace",
        config: { disabled_providers: ["hidden"] },
      })
      expect(withdrawn.catalog.status).toBe("ready")
      expect(withdrawn.catalog.revision).toBeGreaterThan(updated.catalog.revision)
      expect(withdrawn.all.some((item) => item.id === "catalog-provider")).toBe(false)
    }),
    30000,
  )

  it.effect(
    "keeps failed account projections partial and retries after bounded backoff",
    Effect.gen(function* () {
      fetchCount = 0
      rejectAccountFetch = true
      const originalNow = Date.now
      let now = originalNow()
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          Date.now = () => now
        }),
        () =>
          Effect.sync(() => {
            Date.now = originalNow
            rejectAccountFetch = false
          }),
      )

      const credentials = yield* Credential.Service
      yield* credentials.add({ integrationID, label: "Retry User", value: account })
      const catalog = yield* ProviderCatalog.Service
      const contributions = yield* ProviderCatalogContributions.Service
      yield* contributions.publish({ directory: "/catalog-retry", providers: {}, status: "ready" })

      const first = yield* catalog.list({ directory: "/catalog-retry", config: {} })
      expect(first.catalog.status).toBe("partial")
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1_500)))
      const failed = yield* catalog.list({ directory: "/catalog-retry", config: {} })
      expect(failed.catalog.status).toBe("partial")
      expect(failed.catalog.revision).toBeGreaterThan(first.catalog.revision)
      expect(fetchCount).toBeGreaterThan(0)

      rejectAccountFetch = false
      now += 31_000
      const retryPending = yield* catalog.list({ directory: "/catalog-retry", config: {} })
      expect(retryPending.catalog.status).toBe("partial")
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
      const retried = yield* catalog.list({ directory: "/catalog-retry", config: {} })
      expect(retried.catalog.status).toBe("ready")
      expect(retried.catalog.revision).toBeGreaterThan(failed.catalog.revision)
      expect(fetchCount).toBe(2)
    }),
    30000,
  )
})

afterAll(() => {
  if (priorProfile === undefined) delete process.env[OPENFORK_COMPAT_PROFILE_ENV]
  else process.env[OPENFORK_COMPAT_PROFILE_ENV] = priorProfile
})
