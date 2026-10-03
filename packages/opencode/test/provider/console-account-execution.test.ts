import { expect, test } from "bun:test"
import { generateText } from "ai"
import { Effect, Exit, Layer } from "effect"
import { unlink, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import type { AccountProviderCapability } from "@opencode-ai/core/plugin/provider/opencode-account-capability"
import { OpencodeProviderRoute } from "@opencode-ai/core/plugin/provider/opencode-provider-route"
import { projectCredential as projectOpencodeCredential } from "@opencode-ai/core/plugin/provider/opencode-provider-account"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import { ProviderRouteHealth } from "@opencode-ai/core/provider-route-health"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Integration } from "@opencode-ai/schema/integration"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { Provider } from "@/provider/provider"
import {
  consoleClientIdentity,
  type ConsoleAccountExecution,
} from "@/provider/console-account-execution"
import {
  resetZenPoolForTest,
  setTestZenFetch,
  setTestZenVaultCredentials,
  zenLimitSnapshot,
} from "@/plugin/zen"
import { stableZenIdentity } from "@/plugin/zen-accounts"
import { testEffect } from "../lib/effect"

const integrationID = Integration.ID.make("opencode")
const methodID = Integration.MethodID.make("device")
const providerID = ProviderV2.ID.make("console-test")
const modelID = ModelV2.ID.make("alpha")

const oauth = (access: string, server: string, orgID: string) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID,
    access,
    refresh: `refresh-${access}`,
    expires: Date.now() + 60 * 60_000,
    metadata: {
      server,
      orgID,
      accountID: `account-${orgID}`,
      email: `${orgID}@example.test`,
    },
  })

const remoteConfig = (input: {
  providerName: string
  endpoint: string
  wireModelID: string
  modelName: string
  inputCost: number
  outputCost: number
}) => ({
  config: {
    provider: {
      "console-test": {
        name: input.providerName,
        api: input.endpoint,
        npm: "@ai-sdk/openai-compatible",
        options: {
          // The Core capability projector must discard credential-bearing
          // provider options rather than carrying them into V1 state.
          apiKey: "{env:OPENCODE_CONSOLE_TOKEN}",
        },
        models: {
          alpha: {
            id: input.wireModelID,
            name: input.modelName,
            cost: {
              input: input.inputCost,
              output: input.outputCost,
              cache_read: input.inputCost / 10,
              cache_write: input.outputCost / 10,
            },
            limit: { context: 32_000, output: 4_096 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
  },
})

const fixture = {
  "Bearer account-a-v1": {
    org: "org-a",
    config: remoteConfig({
      providerName: "Console Account A",
      endpoint: "https://inference-a.example/v1",
      wireModelID: "wire-a-v1",
      modelName: "Alpha A v1",
      inputCost: 1,
      outputCost: 2,
    }),
  },
  "Bearer account-a-v2": {
    org: "org-a",
    config: remoteConfig({
      providerName: "Console Account A rotated",
      endpoint: "https://inference-a-rotated.example/v1",
      wireModelID: "wire-a-v2",
      modelName: "Alpha A v2",
      inputCost: 11,
      outputCost: 12,
    }),
  },
  "Bearer account-b-v1": {
    org: "org-b",
    config: remoteConfig({
      providerName: "Console Account B",
      endpoint: "https://inference-b.example/v1",
      wireModelID: "wire-b-v1",
      modelName: "Alpha B v1",
      inputCost: 7,
      outputCost: 8,
    }),
  },
} as const

type FixtureAuth = keyof typeof fixture

const seen: Array<{ url: string; authorization?: string; orgID?: string }> = []
let executionEndpoint: string | undefined
const client = HttpClient.make((request) =>
  Effect.sync(() => {
    if (request.method === "GET" && request.url.startsWith("https://models.opencode.ai/models.json")) {
      return HttpClientResponse.fromWeb(
        request,
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      )
    }

    const authorization = request.headers.authorization
    const orgID = request.headers["x-org-id"]
    seen.push({ url: request.url, authorization, orgID })

    if (request.method !== "GET" || !request.url.endsWith("/api/config")) {
      throw new Error(`Unexpected Console HTTP request: ${request.method} ${request.url}`)
    }
    if (authorization === "Bearer account-exec-v1") {
      if (orgID !== "org-exec") throw new Error(`Wrong organization for execution fixture: ${orgID ?? "<missing>"}`)
      if (!executionEndpoint) throw new Error("Execution endpoint was not initialized")
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify(
            remoteConfig({
              providerName: "Console Execution",
              endpoint: executionEndpoint,
              wireModelID: "wire-exec-v1",
              modelName: "Alpha Execution",
              inputCost: 13,
              outputCost: 17,
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }
    const current = authorization ? fixture[authorization as FixtureAuth] : undefined
    if (!current) throw new Error(`Unexpected Console authorization: ${authorization ?? "<missing>"}`)
    if (orgID !== current.org) {
      throw new Error(`Wrong organization for ${authorization}: ${orgID ?? "<missing>"}`)
    }
    return HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(current.config), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }),
)

const layer = LayerNode.compile(
  LayerNode.group([Provider.node, Credential.node, ProviderRoute.node, ProviderRouteHealth.node, Database.node]),
  [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]],
)
const it = testEffect(layer)

const routeProjectID = ProjectV2.ID.global
const routeProjectDirectory = AbsolutePath.make("/openfork-provider-route-test")
const routeSessionDirectory = AbsolutePath.make("/openfork-provider-route-test/workspace")

const seedRouteSession = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: routeProjectID, worktree: routeProjectDirectory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: routeProjectID,
        slug: sessionID,
        directory: routeSessionDirectory,
        title: "Provider route execution test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const languageBaseURL = (language: unknown) => {
  const url = (language as { config: { url: (input: { path: string }) => string } }).config.url
  return url({ path: "/chat/completions" }).replace(/\/chat\/completions$/, "")
}

const identityAccount = (
  overrides: Partial<ConsoleAccountExecution> = {},
): ConsoleAccountExecution =>
  ({
    realm: "realm-a",
    credentialID: Credential.ID.make("cred_account_a"),
    credentialRevision: 3,
    server: "https://console-a.example/console",
    orgID: "org-a",
    configVersion: 9,
    secret: "secret-a",
    snapshot: {} as ConsoleAccountExecution["snapshot"],
    capabilities: {} as ConsoleAccountExecution["capabilities"],
    ...overrides,
  }) as ConsoleAccountExecution

const identityProvider = (
  overrides: Partial<AccountProviderCapability> = {},
): AccountProviderCapability => ({
  id: "console-test",
  api: "https://inference-a.example/v1",
  npm: "@ai-sdk/openai-compatible",
  options: {},
  headers: {},
  models: {},
  configIdentity: "config-a",
  ...overrides,
})

test("Console client identity is secret-free and generation-scoped by realm/account/revision/org/config", () => {
  const provider = identityProvider()
  const base = consoleClientIdentity(identityAccount(), "console-test", provider)
  const secretOnly = consoleClientIdentity(identityAccount({ secret: "completely-different-secret" }), "console-test", provider)
  expect(secretOnly).toEqual(base)

  const revision = consoleClientIdentity(identityAccount({ credentialRevision: 4 }), "console-test", provider)
  expect(revision.slot).toBe(base.slot)
  expect(revision.generation).not.toBe(base.generation)

  const config = consoleClientIdentity(identityAccount({ configVersion: 10 }), "console-test", provider)
  expect(config.slot).toBe(base.slot)
  expect(config.generation).not.toBe(base.generation)

  const transport = consoleClientIdentity(
    identityAccount(),
    "console-test",
    identityProvider({ configIdentity: "config-b" }),
  )
  expect(transport.slot).toBe(base.slot)
  expect(transport.generation).not.toBe(base.generation)

  expect(
    consoleClientIdentity(identityAccount({ realm: "realm-b" }), "console-test", provider).slot,
  ).not.toBe(base.slot)
  expect(
    consoleClientIdentity(
      identityAccount({ credentialID: Credential.ID.make("cred_account_b") }),
      "console-test",
      provider,
    ).slot,
  ).not.toBe(base.slot)
  expect(
    consoleClientIdentity(identityAccount({ orgID: "org-b" }), "console-test", provider).slot,
  ).not.toBe(base.slot)
})

it.instance(
  "two Console OAuth credentials cannot cross endpoint, org, model, cost, provider, or client caches",
  Effect.gen(function* () {
    seen.length = 0
    const credentials = yield* Credential.Service
    const provider = yield* Provider.Service

    const accountA = yield* credentials.add({
      integrationID,
      label: "Console A",
      value: oauth("account-a-v1", "https://console-a.example/console", "org-a"),
    })
    const accountB = yield* credentials.add({
      integrationID,
      label: "Console B",
      value: oauth("account-b-v1", "https://console-b.example/console", "org-b"),
    })
    yield* Effect.addFinalizer(() =>
      Effect.all([credentials.remove(accountA.id), credentials.remove(accountB.id)], { discard: true }),
    )

    const a1 = yield* provider.getModel(providerID, modelID, accountA.id)
    const b1 = yield* provider.getModel(providerID, modelID, accountB.id)

    expect(a1.id).toBe(modelID)
    expect(b1.id).toBe(modelID)
    expect(a1.api.id).toBe("wire-a-v1")
    expect(b1.api.id).toBe("wire-b-v1")
    expect(a1.api.url).toBe("https://inference-a.example/v1")
    expect(b1.api.url).toBe("https://inference-b.example/v1")
    expect(a1.name).toBe("Alpha A v1")
    expect(b1.name).toBe("Alpha B v1")
    expect(a1.cost.input).toBe(1)
    expect(a1.cost.output).toBe(2)
    expect(b1.cost.input).toBe(7)
    expect(b1.cost.output).toBe(8)

    const providerA = yield* provider.getProvider(providerID, a1)
    const providerB = yield* provider.getProvider(providerID, b1)
    expect(providerA.name).toBe("Console Account A")
    expect(providerB.name).toBe("Console Account B")
    expect(providerA).not.toBe(providerB)
    expect(JSON.stringify(providerA)).not.toContain("account-a-v1")
    expect(JSON.stringify(providerB)).not.toContain("account-b-v1")
    expect(JSON.stringify(providerA)).not.toContain("OPENCODE_CONSOLE_TOKEN")
    expect(JSON.stringify(providerB)).not.toContain("OPENCODE_CONSOLE_TOKEN")
    expect(JSON.stringify([a1, b1, providerA, providerB])).not.toContain("local-config-secret")
    expect(JSON.stringify([a1, b1, providerA, providerB])).not.toContain("local-model-secret")

    const languageA1 = yield* provider.getLanguage(a1)
    const languageB1 = yield* provider.getLanguage(b1)
    expect(languageA1).not.toBe(languageB1)
    expect(languageBaseURL(languageA1)).toBe("https://inference-a.example/v1")
    expect(languageBaseURL(languageB1)).toBe("https://inference-b.example/v1")

    // Re-materializing the same account/model hits the same account config and
    // same language/client generation without performing another /api/config.
    const a1Again = yield* provider.getModel(providerID, modelID, accountA.id)
    const b1Again = yield* provider.getModel(providerID, modelID, accountB.id)
    const languageA1Again = yield* provider.getLanguage(a1Again)
    const languageB1Again = yield* provider.getLanguage(b1Again)
    expect(languageA1Again).toBe(languageA1)
    expect(languageB1Again).toBe(languageB1)
    expect(seen.filter((request) => request.url.endsWith("/api/config"))).toHaveLength(2)

    // Rotate only account A. Credential.update increments the trusted P2
    // revision, so the account-config cache refetches and only A's SDK/language
    // generation is replaced. Account B must remain object-identical.
    yield* credentials.update(accountA.id, {
      value: oauth("account-a-v2", "https://console-a.example/console", "org-a"),
    })

    const a2 = yield* provider.getModel(providerID, modelID, accountA.id)
    const languageA2 = yield* provider.getLanguage(a2)
    const bAfterRotation = yield* provider.getModel(providerID, modelID, accountB.id)
    const languageBAfterRotation = yield* provider.getLanguage(bAfterRotation)

    expect(a2.api.id).toBe("wire-a-v2")
    expect(a2.api.url).toBe("https://inference-a-rotated.example/v1")
    expect(a2.name).toBe("Alpha A v2")
    expect(a2.cost.input).toBe(11)
    expect(a2.cost.output).toBe(12)
    expect(languageA2).not.toBe(languageA1)
    expect(languageBaseURL(languageA2)).toBe("https://inference-a-rotated.example/v1")
    expect(languageBAfterRotation).toBe(languageB1)
    expect(languageBaseURL(languageBAfterRotation)).toBe("https://inference-b.example/v1")

    const consoleRequests = seen.filter((request) => request.url.endsWith("/api/config"))
    expect(consoleRequests).toHaveLength(3)
    expect(consoleRequests.map(({ authorization, orgID }) => ({ authorization, orgID }))).toEqual([
      { authorization: "Bearer account-a-v1", orgID: "org-a" },
      { authorization: "Bearer account-b-v1", orgID: "org-b" },
      { authorization: "Bearer account-a-v2", orgID: "org-a" },
    ])
    expect(consoleRequests[0]!.url).toBe("https://console-a.example/console/api/config")
    expect(consoleRequests[1]!.url).toBe("https://console-b.example/console/api/config")
    expect(consoleRequests[2]!.url).toBe("https://console-a.example/console/api/config")
  }),
  {
    // Prevent the unrelated anonymous hosted-catalog lane from needing a
    // network witness during Provider initialization. P5 never consumes this
    // config value and the Zen/Public regression suite is run separately.
    config: {
      provider: {
        opencode: {
          options: { apiKey: "provider-test-only" },
        },
        "console-test": {
          api: "https://local-config-endpoint.invalid/v1",
          npm: "@ai-sdk/openai-compatible",
          options: {
            apiKey: "local-config-secret",
            headers: { Authorization: "Bearer local-config-secret" },
          },
          models: {
            alpha: {
              options: { apiKey: "local-model-secret" },
              headers: { Authorization: "Bearer local-model-secret" },
            },
          },
        },
      },
    },
  },
  { timeout: 15_000 },
)


it.instance(
  "Auto routing excludes a health-quarantined stable account without disabling healthy accounts",
  Effect.gen(function* () {
    seen.length = 0
    const credentials = yield* Credential.Service
    const provider = yield* Provider.Service
    const health = yield* ProviderRouteHealth.Service

    const accountA = yield* credentials.add({
      integrationID,
      label: "Console Health A",
      value: oauth("account-a-v1", "https://console-a.example/console", "org-a"),
    })
    const accountB = yield* credentials.add({
      integrationID,
      label: "Console Health B",
      value: oauth("account-b-v1", "https://console-b.example/console", "org-b"),
    })
    yield* Effect.addFinalizer(() =>
      Effect.all([credentials.remove(accountA.id), credentials.remove(accountB.id)], { discard: true }),
    )

    const projectedA = projectOpencodeCredential(accountA)
    const projectedB = projectOpencodeCredential(accountB)
    if (!projectedA || !projectedB) throw new Error("expected trusted ProviderAccount projections")

    yield* health.observeFailure({
      lease: {
        sessionID: SessionSchema.ID.make("ses_health_seed"),
        affinityDomain: OpencodeProviderRoute.affinityDomain(providerID),
        routeRevision: 1,
        route: {
          kind: "account",
          providerID,
          accountID: projectedA.accountID,
          credentialHandle: accountA.id,
          credentialRevision: accountA.revision,
        },
      },
      modelID,
      effect: "account-auth-invalid",
    })

    const sessionID = SessionSchema.ID.make("ses_provider_route_health_selection")
    yield* seedRouteSession(sessionID)
    const routed = yield* provider.resolveRoutedModel({
      sessionID,
      providerID,
      modelID,
      routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
    })
    if (!routed) throw new Error("expected routed model")

    expect(routed.route.lease.route).toMatchObject({
      kind: "account",
      accountID: projectedB.accountID,
      credentialHandle: accountB.id,
    })
    expect(routed.route.attribution).toEqual({
      sessionID,
      affinityDomain: OpencodeProviderRoute.affinityDomain(providerID),
      providerID,
      routeRevision: 1,
      routeKind: "account",
      accountID: projectedB.accountID,
    })

    const aHealth = yield* health.assessAccount({
      providerID,
      accountID: projectedA.accountID,
      modelID,
      credentialRevision: accountA.revision,
    })
    expect(aHealth).toMatchObject({
      admissible: false,
      state: "auth-invalid",
      ineligibleReason: "auth-invalid",
    })
  }),
  {
    config: {
      provider: {
        opencode: {
          options: { apiKey: "provider-test-only" },
        },
      },
    },
  },
  { timeout: 15_000 },
)

it.instance(
  "executes a committed account route with the exact selected bearer and wire model",
  Effect.gen(function* () {
    seen.length = 0
    const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = []
    const inference = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const body = (await request.json()) as Record<string, unknown>
            requests.push({
              url: request.url,
              authorization: request.headers.get("authorization"),
              body,
            })
            return new Response(
              JSON.stringify({
                id: "chatcmpl-console-test",
                object: "chat.completion",
                created: 0,
                model: "wire-exec-v1",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "ACCOUNT_OK" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    executionEndpoint = new URL("/v1", inference.url).toString().replace(/\/$/, "")
    yield* Effect.addFinalizer(() => Effect.sync(() => (executionEndpoint = undefined)))

    const credentials = yield* Credential.Service
    const provider = yield* Provider.Service
    const routes = yield* ProviderRoute.Service
    const account = yield* credentials.add({
      integrationID,
      label: "Console Execution",
      value: oauth("account-exec-v1", "https://console-exec.example/console", "org-exec"),
    })
    yield* Effect.addFinalizer(() => credentials.remove(account.id))

    const projected = projectOpencodeCredential(account)
    if (!projected) throw new Error("expected trusted ProviderAccount projection")
    const sessionID = SessionSchema.ID.make("ses_provider_route_account_execution")
    yield* seedRouteSession(sessionID)
    const routed = yield* provider.resolveRoutedModel({
      sessionID,
      providerID,
      modelID,
      routeIntent: ProviderRouteIntent.Info.make({
        kind: "account",
        accountID: projected.accountID,
        pin: "hard",
      }),
    })
    if (!routed) throw new Error("expected committed account route")
    const model = routed.model
    expect(routed.route.lease.route).toMatchObject({
      kind: "account",
      accountID: projected.accountID,
      credentialHandle: account.id,
    })
    expect(projected.accountID).not.toBe(account.id)
    expect(routed.route.attribution).toEqual({
      sessionID,
      affinityDomain: OpencodeProviderRoute.affinityDomain(providerID),
      providerID,
      routeRevision: 1,
      routeKind: "account",
      accountID: projected.accountID,
    })
    const durable = yield* routes.get(sessionID, OpencodeProviderRoute.affinityDomain(providerID))
    expect(durable).toMatchObject({
      routeKind: "account",
      accountID: projected.accountID,
      credentialHandle: account.id,
    })
    const inherited = yield* provider.resolveInheritedRoutedModel({
      sessionID,
      providerID,
      modelID,
      route: routed.route.attribution,
    })
    expect(inherited.route.attribution).toEqual(routed.route.attribution)
    expect(inherited.route.lease.route).toMatchObject({
      kind: "account",
      accountID: projected.accountID,
      credentialHandle: account.id,
    })
    expect(inherited.model.api.id).toBe("wire-exec-v1")
    expect((yield* routes.get(sessionID, OpencodeProviderRoute.affinityDomain(providerID)))?.routeRevision).toBe(1)

    const language = yield* provider.getLanguage(inherited.model)
    const result = yield* Effect.promise(() =>
      generateText({
        model: language,
        prompt: "Reply with exactly ACCOUNT_OK",
        maxRetries: 0,
      }),
    )

    expect(result.text).toBe("ACCOUNT_OK")
    expect(model.api.id).toBe("wire-exec-v1")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(`${executionEndpoint}/chat/completions`)
    expect(requests[0]!.authorization).toBe("Bearer account-exec-v1")
    expect(requests[0]!.body.model).toBe("wire-exec-v1")
    expect(JSON.stringify(requests[0]!.body)).not.toContain("local-config-secret")
    expect(seen.filter((request) => request.url.endsWith("/api/config"))).toEqual([
      {
        url: "https://console-exec.example/console/api/config",
        authorization: "Bearer account-exec-v1",
        orgID: "org-exec",
      },
    ])
  }),
  {
    config: {
      provider: {
        opencode: { options: { apiKey: "provider-test-only" } },
        "console-test": {
          api: "https://local-config-endpoint.invalid/v1",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "local-config-secret" },
          models: { alpha: { options: { apiKey: "local-model-secret" } } },
        },
      },
    },
  },
  { timeout: 15_000 },
)

it.instance(
  "suppresses a health-quarantined Public route before durable bind without inventing account identity",
  Effect.gen(function* () {
    resetZenPoolForTest()
    setTestZenFetch(async (input) => {
      if (String(input) === "https://opencode.ai/zen/v1/models") {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "big-pickle", object: "model", owned_by: "opencode" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected Public-health fetch: ${String(input)}`)
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        resetZenPoolForTest()
      }),
    )

    const provider = yield* Provider.Service
    const routes = yield* ProviderRoute.Service
    const health = yield* ProviderRouteHealth.Service
    const publicProviderID = ProviderV2.ID.make("opencode")
    const publicModelID = ModelV2.ID.make("big-pickle")
    const sessionID = SessionSchema.ID.make("ses_provider_route_public_health_block")
    yield* seedRouteSession(sessionID)

    yield* health.observeFailure({
      lease: {
        sessionID: SessionSchema.ID.make("ses_public_health_observation"),
        affinityDomain: OpencodeProviderRoute.affinityDomain(publicProviderID),
        routeRevision: 1,
        route: {
          kind: "public",
          providerID: publicProviderID,
          routeID: `${publicProviderID}:public`,
        },
      },
      modelID: publicModelID,
      effect: "public-quota-exhausted",
      resetAt: Date.now() + 60_000,
    })

    const exit = yield* Effect.exit(
      provider.resolveRoutedModel({
        sessionID,
        providerID: publicProviderID,
        modelID: publicModelID,
        routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(
      yield* routes.get(sessionID, OpencodeProviderRoute.affinityDomain(publicProviderID)),
    ).toBeUndefined()

    expect(
      yield* health.assessPublic({
        providerID: publicProviderID,
        modelID: publicModelID,
      }),
    ).toMatchObject({
      available: false,
      state: "quota-exhausted",
    })
  }),
  {
    config: {
      provider: {
        opencode: {
          options: { apiKey: "provider-test-only" },
        },
      },
    },
  },
  { timeout: 15_000 },
)

it.instance(
  "keeps a committed Public route credential-free even when a Zen default account exists",
  Effect.gen(function* () {
    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
    resetZenPoolForTest()
    setTestZenVaultCredentials([{ apiKey: "must-not-use-default", label: "Default account", isDefault: true }])
    setTestZenFetch(async (input, init) => {
      const url = String(input)
      if (url === "https://opencode.ai/zen/v1/models") {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "big-pickle", object: "model", owned_by: "opencode" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      const request = new Request(input, init)
      const body = (await request.json()) as Record<string, unknown>
      requests.push({ authorization: request.headers.get("authorization"), body })
      return new Response(
        JSON.stringify({
          id: "chatcmpl-public-route",
          object: "chat.completion",
          created: 0,
          model: "big-pickle",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "PUBLIC_OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        setTestZenVaultCredentials(undefined)
        resetZenPoolForTest()
      }),
    )

    const provider = yield* Provider.Service
    const routes = yield* ProviderRoute.Service
    const publicProviderID = ProviderV2.ID.make("opencode")
    const publicModelID = ModelV2.ID.make("big-pickle")
    const sessionID = SessionSchema.ID.make("ses_provider_route_public_execution")
    yield* seedRouteSession(sessionID)

    const routed = yield* provider.resolveRoutedModel({
      sessionID,
      providerID: publicProviderID,
      modelID: publicModelID,
      routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
    })
    if (!routed) throw new Error("expected committed Public route")
    expect(routed.route.lease.route.kind).toBe("public")
    expect(routed.route.attribution).toEqual({
      sessionID,
      affinityDomain: OpencodeProviderRoute.affinityDomain(publicProviderID),
      providerID: publicProviderID,
      routeRevision: 1,
      routeKind: "public",
    })
    expect("accountID" in routed.route.lease.route).toBe(false)
    expect("credentialHandle" in routed.route.lease.route).toBe(false)
    expect(
      yield* routes.get(sessionID, OpencodeProviderRoute.affinityDomain(publicProviderID)),
    ).toMatchObject({ routeKind: "public" })

    const inherited = yield* provider.resolveInheritedRoutedModel({
      sessionID,
      providerID: publicProviderID,
      modelID: publicModelID,
      route: routed.route.attribution,
    })
    expect(inherited.route.attribution).toEqual(routed.route.attribution)
    expect(inherited.route.lease.route.kind).toBe("public")
    expect("accountID" in inherited.route.lease.route).toBe(false)
    expect((yield* routes.get(sessionID, OpencodeProviderRoute.affinityDomain(publicProviderID)))?.routeRevision).toBe(1)

    const language = yield* provider.getLanguage(inherited.model)
    const result = yield* Effect.promise(() =>
      generateText({
        model: language,
        prompt: "Reply with exactly PUBLIC_OK",
        maxRetries: 0,
      }),
    )
    expect(result.text).toBe("PUBLIC_OK")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe("Bearer public")
    expect(requests[0]!.authorization).not.toContain("must-not-use-default")
    expect(requests[0]!.body.model).toBe("big-pickle")
  }),
  {
    config: {
      provider: {
        opencode: { options: { apiKey: "local-provider-key-must-not-win" } },
      },
    },
  },
  { timeout: 15_000 },
)

const COMPAT_KEY_A = "compat-key-a-default"
const COMPAT_KEY_B = "compat-key-b-pinned"
const ZEN_ENV_KEYS = [
  "OPENCODE_API_KEY",
  "OPENCODE_API_KEYS",
  ...Array.from({ length: 9 }, (_, index) => `OPENCODE_API_KEY_${index + 2}`),
]

it.instance(
  "real ProviderRoute compat hard pin keeps a non-default Zen account on the final wire",
  Effect.gen(function* () {
    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
    const savedEnv = ZEN_ENV_KEYS.map((name) => [name, process.env[name]] as const)
    for (const name of ZEN_ENV_KEYS) delete process.env[name]
    resetZenPoolForTest()
    // Two fork-vault keys only: A is the pool default, B is the pinned route.
    setTestZenVaultCredentials([
      { apiKey: COMPAT_KEY_A, label: "Default account", isDefault: true },
      { apiKey: COMPAT_KEY_B, label: "Pinned account", isDefault: false },
    ])
    setTestZenFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "big-pickle", object: "model", owned_by: "opencode" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      const request = new Request(input, init)
      const body = (await request.json()) as Record<string, unknown>
      requests.push({ authorization: request.headers.get("authorization"), body })
      return new Response(
        JSON.stringify({
          id: "chatcmpl-compat-route",
          object: "chat.completion",
          created: 0,
          model: "big-pickle",
          choices: [
            { index: 0, message: { role: "assistant", content: "COMPAT_OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        setTestZenVaultCredentials(undefined)
        resetZenPoolForTest()
        for (const [name, value] of savedEnv) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
    )

    const provider = yield* Provider.Service
    const compatProviderID = ProviderV2.ID.make("opencode")
    const compatModelID = ModelV2.ID.make("big-pickle")
    const accountB = stableZenIdentity(COMPAT_KEY_B)
    const sessionID = SessionSchema.ID.make("ses_provider_route_compat_execution")
    yield* seedRouteSession(sessionID)

    const routed = yield* provider.resolveRoutedModel({
      sessionID,
      providerID: compatProviderID,
      modelID: compatModelID,
      routeIntent: ProviderRouteIntent.Info.make({
        kind: "account",
        accountID: accountB,
        pin: "hard",
      }),
    })
    if (!routed) throw new Error("expected a committed compat account route")

    const lease = routed.route.lease.route
    expect(lease.kind).toBe("account")
    expect(lease.kind === "account" && lease.accountID).toBe(accountB)
    expect(lease.kind === "account" && lease.credentialHandle).toBe(`zen-compat:${accountB}`)
    expect(lease.kind === "account" && typeof lease.credentialRevision).toBe("number")

    // Route metadata is secret-free: stable identity plus an opaque handle only.
    const serializedRoute = JSON.stringify({ lease, attribution: routed.route.attribution })
    expect(serializedRoute).toContain(accountB)
    expect(serializedRoute).not.toContain(COMPAT_KEY_A)
    expect(serializedRoute).not.toContain(COMPAT_KEY_B)
    expect(routed.route.attribution.routeKind).toBe("account")
    expect(routed.route.attribution.accountID).toBe(accountB)
    expect("credentialHandle" in routed.route.attribution).toBe(false)
    expect("credentialRevision" in routed.route.attribution).toBe(false)

    // The provider view is secret-free: no key, no configured api key, no handle.
    const providerInfo = yield* provider.getProvider(compatProviderID, routed.model)
    expect(providerInfo.key).toBeUndefined()
    expect(providerInfo.options.apiKey).toBeUndefined()
    const serializedProvider = JSON.stringify({ providerInfo, model: routed.model })
    expect(serializedProvider).not.toContain(COMPAT_KEY_A)
    expect(serializedProvider).not.toContain(COMPAT_KEY_B)
    expect(serializedProvider).not.toContain("zen-compat:")

    const language = yield* provider.getLanguage(routed.model)
    const result = yield* Effect.promise(() =>
      generateText({ model: language, prompt: "Reply with exactly COMPAT_OK", maxRetries: 0 }),
    )
    expect(result.text).toBe("COMPAT_OK")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe(`Bearer ${COMPAT_KEY_B}`)
    expect(requests[0]!.authorization).not.toBe(`Bearer ${COMPAT_KEY_A}`)
    expect(requests[0]!.body.model).toBe("big-pickle")

    // The committed route is unchanged by the physical dispatch.
    const persisted = yield* (yield* ProviderRoute.Service).get(
      sessionID,
      OpencodeProviderRoute.affinityDomain(compatProviderID),
    )
    expect(persisted?.routeKind).toBe("account")
    expect(persisted?.routeKind === "account" ? persisted.accountID : undefined).toBe(accountB)
  }),
  { timeout: 30_000 },
)

const hostedWireStub = (
  requests: Array<{ authorization: string | null; body: Record<string, unknown> }>,
  options: { readonly advertiseFreeModel: boolean } = { advertiseFreeModel: true },
) =>
  setTestZenFetch(async (input, init) => {
    // Public eligibility additionally requires the hosted gateway to advertise the
    // model as free. Tests that must reach an account route keep it unadvertised.
    if (String(input).endsWith("/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: options.advertiseFreeModel
            ? [{ id: "big-pickle", object: "model", owned_by: "opencode" }]
            : [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    const request = new Request(input, init)
    requests.push({ authorization: request.headers.get("authorization"), body: (await request.json()) as Record<string, unknown> })
    return new Response(
      JSON.stringify({
        id: "chatcmpl-compat",
        object: "chat.completion",
        created: 0,
        model: "big-pickle",
        choices: [{ index: 0, message: { role: "assistant", content: "COMPAT_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })

const clearHostedEnv = () => {
  const saved = ZEN_ENV_KEYS.map((name) => [name, process.env[name]] as const)
  for (const name of ZEN_ENV_KEYS) delete process.env[name]
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const dispatchHostedCompat = (
  provider: Provider.Interface,
  sessionID: SessionSchema.ID,
  input: { readonly routeIntent: ProviderRouteIntent.Info },
) =>
  provider.resolveRoutedModel({
    sessionID,
    providerID: ProviderV2.ID.make("opencode"),
    modelID: ModelV2.ID.make("big-pickle"),
    routeIntent: input.routeIntent,
  })

it.instance(
  "an env-only Zen key becomes the authoritative compat account route and reaches the wire",
  Effect.gen(function* () {
    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
    const restoreEnv = clearHostedEnv()
    const KEY = "env-only-compat-key"
    process.env.OPENCODE_API_KEY = KEY
    resetZenPoolForTest()
    setTestZenVaultCredentials([])
    hostedWireStub(requests, { advertiseFreeModel: false })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        setTestZenVaultCredentials(undefined)
        resetZenPoolForTest()
        restoreEnv()
      }),
    )

    const provider = yield* Provider.Service
    const sessionID = SessionSchema.ID.make("ses_compat_env_only")
    yield* seedRouteSession(sessionID)

    const routed = yield* dispatchHostedCompat(provider, sessionID, {
      routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
    })
    if (!routed) throw new Error("expected an env-key compat route")
    const accountID = stableZenIdentity(KEY)
    const lease = routed.route.lease.route
    expect(lease.kind === "account" && lease.accountID).toBe(accountID)
    expect(lease.kind === "account" && lease.credentialHandle).toBe(`zen-compat:${accountID}`)
    expect(JSON.stringify(routed.route)).not.toContain(KEY)

    const language = yield* provider.getLanguage(routed.model)
    yield* Effect.promise(() => generateText({ model: language, prompt: "Reply with exactly COMPAT_OK", maxRetries: 0 }))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe(`Bearer ${KEY}`)
    expect(requests[0]!.body.model).toBe("big-pickle")
  }),
  { timeout: 30_000 },
)

it.instance(
  "a configured provider options.apiKey becomes the authoritative compat account route",
  Effect.gen(function* () {
    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
    const restoreEnv = clearHostedEnv()
    resetZenPoolForTest()
    setTestZenVaultCredentials([])
    hostedWireStub(requests, { advertiseFreeModel: false })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        setTestZenVaultCredentials(undefined)
        resetZenPoolForTest()
        restoreEnv()
      }),
    )

    const provider = yield* Provider.Service
    const sessionID = SessionSchema.ID.make("ses_compat_config_key_only")
    yield* seedRouteSession(sessionID)

    const routed = yield* dispatchHostedCompat(provider, sessionID, {
      routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
    })
    if (!routed) throw new Error("expected a configured-key compat route")
    const lease = routed.route.lease.route
    expect(lease.kind).toBe("account")
    expect(JSON.stringify(routed.route)).not.toContain("config-only-compat-key")
    const providerInfo = yield* provider.getProvider(ProviderV2.ID.make("opencode"), routed.model)
    expect(JSON.stringify({ providerInfo, model: routed.model })).not.toContain("config-only-compat-key")

    const language = yield* provider.getLanguage(routed.model)
    yield* Effect.promise(() => generateText({ model: language, prompt: "Reply with exactly COMPAT_OK", maxRetries: 0 }))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe("Bearer config-only-compat-key")
  }),
  { config: { provider: { opencode: { options: { apiKey: "config-only-compat-key" } } } }, timeout: 30_000 },
)

it.instance(
  "a legacy auth.json API key becomes the authoritative compat account route",
  Effect.gen(function* () {
    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
    const restoreEnv = clearHostedEnv()
    resetZenPoolForTest()
    setTestZenVaultCredentials([])
    hostedWireStub(requests, { advertiseFreeModel: false })
    const authPath = path.join(Global.Path.data, "auth.json")
    const original = yield* Effect.promise(() => readFile(authPath, "utf8").catch(() => undefined))
    yield* Effect.acquireRelease(
      Effect.promise(() =>
        writeFile(authPath, JSON.stringify({ opencode: { type: "api", key: "legacy-auth-compat-key" } })),
      ),
      () =>
        Effect.promise(async () => {
          if (original !== undefined) await writeFile(authPath, original)
          else await unlink(authPath).catch(() => undefined)
        }),
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        setTestZenVaultCredentials(undefined)
        resetZenPoolForTest()
        restoreEnv()
      }),
    )

    const provider = yield* Provider.Service
    const sessionID = SessionSchema.ID.make("ses_compat_legacy_auth_only")
    yield* seedRouteSession(sessionID)

    const routed = yield* dispatchHostedCompat(provider, sessionID, {
      routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
    })
    if (!routed) throw new Error("expected a legacy-auth compat route")
    const lease = routed.route.lease.route
    expect(lease.kind === "account" && lease.accountID).toBe(stableZenIdentity("legacy-auth-compat-key"))
    expect(JSON.stringify(routed.route)).not.toContain("legacy-auth-compat-key")

    const language = yield* provider.getLanguage(routed.model)
    yield* Effect.promise(() => generateText({ model: language, prompt: "Reply with exactly COMPAT_OK", maxRetries: 0 }))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe("Bearer legacy-auth-compat-key")
  }),
  { timeout: 30_000 },
)

it.instance(
  "an explicit Public route stays Public with a populated compat pool",
  Effect.gen(function* () {
    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
    const restoreEnv = clearHostedEnv()
    resetZenPoolForTest()
    setTestZenVaultCredentials([
      { apiKey: "public-must-not-win-a", label: "Pool A", isDefault: true },
      { apiKey: "public-must-not-win-b", label: "Pool B", isDefault: false },
    ])
    // The gateway advertises the model as free, so Public is a genuine
    // alternative even though two compat accounts exist.
    hostedWireStub(requests)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        setTestZenVaultCredentials(undefined)
        resetZenPoolForTest()
        restoreEnv()
      }),
    )

    const provider = yield* Provider.Service
    const sessionID = SessionSchema.ID.make("ses_compat_public_with_pool")
    yield* seedRouteSession(sessionID)

    const routed = yield* dispatchHostedCompat(provider, sessionID, {
      routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
    })
    if (!routed) throw new Error("expected a Public route with a populated pool")
    expect(routed.route.lease.route.kind).toBe("public")
    expect("accountID" in routed.route.lease.route).toBe(false)
    expect(routed.route.attribution.routeKind).toBe("public")

    const language = yield* provider.getLanguage(routed.model)
    yield* Effect.promise(() => generateText({ model: language, prompt: "Reply with exactly COMPAT_OK", maxRetries: 0 }))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe("Bearer public")
    expect(requests[0]!.authorization).not.toContain("public-must-not-win")
  }),
  { timeout: 30_000 },
)

it.instance(
  "a quota failure on a committed compat route is observed against that exact account",
  Effect.gen(function* () {
    const requests: Array<{ authorization: string | null }> = []
    const restoreEnv = clearHostedEnv()
    const KEY = "health-observed-compat-key"
    resetZenPoolForTest()
    setTestZenVaultCredentials([{ apiKey: KEY, label: "Observed account", isDefault: true }])
    setTestZenFetch(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      requests.push({ authorization: new Request(input, init).headers.get("authorization") })
      return new Response(JSON.stringify({ error: "quota exceeded" }), {
        status: 402,
        headers: { "content-type": "application/json" },
      })
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        setTestZenVaultCredentials(undefined)
        resetZenPoolForTest()
        restoreEnv()
      }),
    )

    const provider = yield* Provider.Service
    const sessionID = SessionSchema.ID.make("ses_compat_health_observed")
    yield* seedRouteSession(sessionID)

    const routed = yield* dispatchHostedCompat(provider, sessionID, {
      routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
    })
    if (!routed) throw new Error("expected a compat route before the quota failure")
    const accountID = stableZenIdentity(KEY)
    expect(routed.route.lease.route.kind === "account" && routed.route.lease.route.accountID).toBe(accountID)

    const language = yield* provider.getLanguage(routed.model)
    yield* Effect.promise(() =>
      generateText({ model: language, prompt: "Reply with exactly COMPAT_OK", maxRetries: 0 }),
    ).pipe(Effect.catchCause(() => Effect.void))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe(`Bearer ${KEY}`)
    // Pool health stays the single process-local compat health owner: the exact
    // committed account is recorded, and no durable second health row is created.
    expect(zenLimitSnapshot().find((row) => row.accountId === accountID)?.state).toBe("QUOTA_EXHAUSTED")
  }),
  { timeout: 30_000 },
)

it.instance(
  "a committed Public route stays Public at the wire with pool, env, and configured keys present",
  Effect.gen(function* () {
    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
    const restoreEnv = clearHostedEnv()
    resetZenPoolForTest()
    // Every ambient selector that the old committed-Public fetch could reach is
    // populated here: pool default + peer, an env key, and a configured key.
    process.env.OPENCODE_API_KEY = "public-ambient-env-key"
    setTestZenVaultCredentials([
      { apiKey: "public-ambient-pool-a", label: "Pool A", isDefault: true },
      { apiKey: "public-ambient-pool-b", label: "Pool B", isDefault: false },
    ])
    hostedWireStub(requests)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setTestZenFetch(undefined)
        setTestZenVaultCredentials(undefined)
        resetZenPoolForTest()
        restoreEnv()
      }),
    )

    const provider = yield* Provider.Service
    const sessionID = SessionSchema.ID.make("ses_public_no_downstream_reselection")
    yield* seedRouteSession(sessionID)

    const routed = yield* dispatchHostedCompat(provider, sessionID, {
      routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
    })
    if (!routed) throw new Error("expected a committed Public route")
    expect(routed.route.lease.route.kind).toBe("public")

    // Re-arm every ambient selector AFTER the commit, so nothing that happened
    // before resolution can be what keeps the sentinel.
    process.env.OPENCODE_API_KEY = "public-ambient-env-key-late"
    setTestZenVaultCredentials([
      { apiKey: "public-ambient-pool-a-late", label: "Pool A late", isDefault: true },
    ])

    const language = yield* provider.getLanguage(routed.model)
    yield* Effect.promise(() => generateText({ model: language, prompt: "Reply with exactly COMPAT_OK", maxRetries: 0 }))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe("Bearer public")
    for (const forbidden of [
      "public-ambient-pool-a",
      "public-ambient-pool-b",
      "public-ambient-pool-a-late",
      "public-ambient-env-key",
      "public-ambient-env-key-late",
      "public-must-not-win",
      "provider-test-only",
      "local-provider-key-must-not-win",
    ]) {
      expect(JSON.stringify({ requests, provider: yield* provider.getProvider(routed.model.providerID, routed.model) })).not.toContain(
        forbidden,
      )
    }
    expect(requests[0]!.body.model).toBe("big-pickle")
  }),
  { config: { provider: { opencode: { options: { apiKey: "public-ambient-config-key" } } } }, timeout: 30_000 },
)
