import { afterEach, beforeEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient, requestExecutor } from "@opencode-ai/core/effect/app-node-platform"
import { OpenCodeHostedUserAgent } from "@opencode-ai/core/installation/version"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { MaintenanceUsageTable, UsageRecordTable } from "@opencode-ai/core/usage/sql"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { resetZenPoolForTest, setTestZenFetch, setTestZenVaultCredentials } from "@/plugin/zen"
import { stableZenIdentity } from "@/plugin/zen-accounts"
import { Provider } from "@/provider/provider"
import { SystemOne } from "@/system-one/system-one"
import { testEffect } from "../lib/effect"

/**
 * C4-T item 3: the System One REAL-resolver transient compat transport proof.
 *
 * `system-one-route.test.ts` proves System One's consumption of
 * `resolveTransientRoutedModel` and the returned `RouteTransport`, but against a
 * fake `ProviderTest`. `console-account-execution.test.ts` proves the real
 * `Provider` compat transport at the final wire, but only through the language
 * path (`getLanguage` -> `generateText`). Neither joins the two, so nothing yet
 * proved that a REAL System One dispatch over a REAL `Provider.Service` uses the
 * committed route's credential, model, and headers with no downstream
 * defaultAccount / env / config reselection.
 *
 * This file closes exactly that gap. Only catalog DATA and the two process
 * boundaries where bytes would leave the machine are stubbed:
 *
 *   - `ModelsDev` (supplies the trusted catalog row), and
 *   - `RequestExecutor` (the LAST boundary before the request is sent).
 *
 * Everything that decides authorization is production: the real
 * `Provider.Service`, the real `OpencodeProviderRoute` transient resolver, the
 * real Core candidate/route machinery, the real Zen/Go compat inventory and
 * materialization, the real `SystemOne.infer`, and the real
 * `SystemOneClient.infer`.
 *
 * The catalog model is a genuine trusted system-one row, not a hand-built
 * object: `type: "decision"` is what production
 * `ModelsDev.modelPrimitive` maps to `primitive: "system-one"`, and
 * `fromModelsDevModel` performs the real projection.
 */

const SYSTEM_ONE_MODEL = "jev-1.13-free"
const HOSTED_PROVIDER = "opencode"
const HOSTED_BASE_URL = "https://opencode.ai/zen/v1"

// Deliberately distinct ambient credentials. Every assertion proves one of these
// is NOT what reached the wire, so a reselection to pool-default, env, or
// instance config fails loudly instead of passing by accident.
const POOL_DEFAULT_KEY = "real-resolver-pool-default-secret"
const PINNED_KEY = "real-resolver-pinned-secret"
const AMBIENT_ENV_KEY = "real-resolver-ambient-env-secret"
const AMBIENT_CONFIG_KEY = "real-resolver-ambient-config-secret"
const AMBIENT = [POOL_DEFAULT_KEY, PINNED_KEY, AMBIENT_ENV_KEY, AMBIENT_CONFIG_KEY]

const ZEN_ENV_KEYS = ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"] as const

const questions = {
  verdict: {
    type: "choice" as const,
    instructions: "Classify the candidate.",
    criteria: { pass: "Looks useful", inspect: "Needs review" },
  },
}

const instanceConfig = { config: { provider: { opencode: { options: { apiKey: AMBIENT_CONFIG_KEY } } } } }
const testOptions = { timeout: 30_000 }

type Captured = {
  url: string
  authorization?: string
  headers: Readonly<Record<string, string>>
  body: unknown
}

const captured: Captured[] = []

const ok = () =>
  new Response(
    JSON.stringify({
      model: SYSTEM_ONE_MODEL,
      answers: {
        verdict: { type: "choice", choice: "inspect", confidence: 0.9, probabilities: { pass: 0.1, inspect: 0.9 } },
      },
      usage: { input_tokens: 120, output_tokens: 3 },
      request_id: "system-one-real-resolver",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

/**
 * Trusted hosted catalog with one decision (system-one) model.
 *
 * `type: "decision"` is the production signal for the system-one primitive, and
 * zero cost keeps it a trusted zero-cost catalog row.
 */
const modelsDevStub = Layer.succeed(
  ModelsDev.Service,
  ModelsDev.Service.of({
    getCached: () => Effect.succeed({}),
    getForSelectedProvider: () => Effect.succeed({}),
    get: () =>
      Effect.succeed({
        [HOSTED_PROVIDER]: {
          id: HOSTED_PROVIDER,
          name: "OpenCode Zen",
          env: ["OPENCODE_API_KEY"],
          models: {
            [SYSTEM_ONE_MODEL]: {
              id: SYSTEM_ONE_MODEL,
              type: "decision" as const,
              name: "Jev 1.13 Free",
              family: "jev",
              release_date: "2025-01-01",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: false,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              limit: { context: 0, output: 0 },
              provider: { api: HOSTED_BASE_URL, npm: "@ai-sdk/openai-compatible" },
            },
          },
        },
      } satisfies Record<string, ModelsDev.Provider>),
    getDecisionModels: () => Effect.succeed({}),
    refresh: () => Effect.void,
  }),
)

/** The final physical boundary: what would actually be sent over the wire. */
const executorLayer = Layer.succeed(
  RequestExecutor.Service,
  RequestExecutor.Service.of({
    execute: (request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        const body = JSON.parse(yield* Effect.promise(() => web.text())) as unknown
        captured.push({
          url: request.url,
          authorization: request.headers.authorization,
          headers: request.headers as Readonly<Record<string, string>>,
          body,
        })
        return HttpClientResponse.fromWeb(request, ok())
      }),
  }),
)

/** Hosted catalog metadata only. No inference may pass through here. */
const httpLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    ),
  ),
)

const layer = LayerNode.compile(LayerNode.group([SystemOne.node, Provider.node, Database.node]), [
  [ModelsDev.node, modelsDevStub],
  [httpClient, httpLayer],
  [requestExecutor, executorLayer],
])
const it = testEffect(layer)

/** Advertise the same id so an explicit Public route is genuinely eligible. */
const hostedFetch = () =>
  setTestZenFetch(async (input) => {
    if (String(input).endsWith("/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: SYSTEM_ONE_MODEL, object: "model", owned_by: "opencode" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    throw new Error(`unexpected Zen fetch: ${String(input)}`)
  })

/**
 * Reset order matters: `resetZenPoolForTest()` clears the process-local test
 * seams, so the fetch and vault credentials must be re-applied after it.
 */
const prime = (credentials: Array<{ apiKey: string; label: string; isDefault: boolean }>) => {
  resetZenPoolForTest()
  hostedFetch()
  setTestZenVaultCredentials(credentials)
  process.env.OPENCODE_API_KEY = AMBIENT_ENV_KEY
}

const usageRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const records = yield* db.select().from(UsageRecordTable).run()
  const maintenance = yield* db.select().from(MaintenanceUsageTable).run()
  return { records: records.length, maintenance: maintenance.length }
})

const infer = (input: Parameters<SystemOne.Interface["infer"]>[0]) =>
  SystemOne.Service.pipe(Effect.flatMap((service) => service.infer(input)))

const systemOneRequest = (extra: Partial<Parameters<SystemOne.Interface["infer"]>[0]>) =>
  infer({
    providerID: HOSTED_PROVIDER as never,
    modelID: SYSTEM_ONE_MODEL as never,
    state: "candidate",
    questions,
    ...extra,
  })

let savedEnv: Array<[string, string | undefined]> = []

beforeEach(() => {
  captured.length = 0
  savedEnv = ZEN_ENV_KEYS.map((name) => [name, process.env[name]] as [string, string | undefined])
  for (const name of ZEN_ENV_KEYS) delete process.env[name]
  prime([])
})

afterEach(() => {
  setTestZenFetch(undefined)
  setTestZenVaultCredentials(undefined)
  resetZenPoolForTest()
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

it.instance(
  "the real catalog projects a trusted system-one primitive for the hosted model",
  Effect.gen(function* () {
    prime([])
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(HOSTED_PROVIDER as never, SYSTEM_ONE_MODEL as never)
    // Production `ModelsDev.modelPrimitive` mapped `type: "decision"`.
    expect(model.primitive).toBe("system-one")
    expect(model.api.id).toBe(SYSTEM_ONE_MODEL)
    expect(model.api.url).toBe(HOSTED_BASE_URL)
  }),
  instanceConfig,
  testOptions,
)

it.instance(
  "a real System One Public dispatch keeps Bearer public with a populated pool, env key, and configured key",
  Effect.gen(function* () {
    // Three live credential sources, none of which may become the authority.
    prime([
      { apiKey: POOL_DEFAULT_KEY, label: "Pool default", isDefault: true },
      { apiKey: PINNED_KEY, label: "Pool second", isDefault: false },
    ])

    const result = yield* systemOneRequest({
      routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
      affinityID: "real-resolver-public",
    })

    // Real resolver + real System One produced exactly one physical request.
    expect(captured).toHaveLength(1)
    const request = captured[0]!

    // The committed Public route is the only credential at the final boundary.
    expect(request.authorization).toBe("Bearer public")
    for (const secret of AMBIENT) expect(request.authorization).not.toContain(secret)

    // Canonical hosted request identity, stamped by production System One.
    expect(request.url).toBe(`${HOSTED_BASE_URL}/systemone`)
    expect(request.headers["user-agent"]).toBe(OpenCodeHostedUserAgent())
    expect(request.headers["x-opencode-client"]).toBeTruthy()
    expect(request.headers["x-opencode-session"]).toMatch(/^ses_sem_[0-9a-f]{32}$/)
    expect(request.headers["x-opencode-request"]).toMatch(/^msg_/)
    expect(request.headers["x-opencode-project"]).toBeTruthy()

    // The wire model is the committed catalog model, not a reselection.
    expect(request.body).toEqual({ model: SYSTEM_ONE_MODEL, state: "candidate", questions })
    expect(result.model).toBe(SYSTEM_ONE_MODEL)
    expect(result.cost).toEqual({ input: 0, output: 0, total: 0 })

    // No secret reaches the returned contract.
    const serialized = JSON.stringify(result)
    for (const secret of AMBIENT) expect(serialized).not.toContain(secret)
  }),
  instanceConfig,
  testOptions,
)

it.instance(
  "a real System One hard-pinned compat account uses exactly its committed key, model, and headers",
  Effect.gen(function* () {
    prime([
      { apiKey: POOL_DEFAULT_KEY, label: "Pool default", isDefault: true },
      { apiKey: PINNED_KEY, label: "Pool second", isDefault: false },
    ])

    const accountID = stableZenIdentity(PINNED_KEY)
    const result = yield* systemOneRequest({
      routeIntent: ProviderRouteIntent.Info.make({ kind: "account", accountID, pin: "hard" }),
      affinityID: "real-resolver-account",
    })

    expect(captured).toHaveLength(1)
    const request = captured[0]!

    // Exactly the committed non-default account secret, never the pool default,
    // the env key, or the instance-configured key.
    expect(request.authorization).toBe(`Bearer ${PINNED_KEY}`)
    expect(request.authorization).not.toBe(`Bearer ${POOL_DEFAULT_KEY}`)
    for (const secret of [POOL_DEFAULT_KEY, AMBIENT_ENV_KEY, AMBIENT_CONFIG_KEY]) {
      expect(request.authorization).not.toContain(secret)
    }

    // Same hosted identity contract as the Public dispatch.
    expect(request.url).toBe(`${HOSTED_BASE_URL}/systemone`)
    expect(request.headers["user-agent"]).toBe(OpenCodeHostedUserAgent())
    expect(request.headers["x-opencode-client"]).toBeTruthy()
    expect(request.headers["x-opencode-session"]).toMatch(/^ses_sem_[0-9a-f]{32}$/)
    expect(request.headers["x-opencode-request"]).toMatch(/^msg_/)
    expect(request.body).toEqual({ model: SYSTEM_ONE_MODEL, state: "candidate", questions })
    expect(result.model).toBe(SYSTEM_ONE_MODEL)

    // The stable account identity and route internals never leave the wire.
    const serialized = JSON.stringify({ result, body: request.body, headers: request.headers })
    for (const secret of AMBIENT) expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(accountID)
    expect(serialized).not.toContain("credentialHandle")
    expect(serialized).not.toContain("credentialRevision")
  }),
  instanceConfig,
  testOptions,
)

it.instance(
  "a standalone real System One dispatch records no fabricated maintenance or usage settlement",
  Effect.gen(function* () {
    prime([{ apiKey: PINNED_KEY, label: "Pool only", isDefault: true }])

    yield* systemOneRequest({
      routeIntent: ProviderRouteIntent.Info.make({
        kind: "account",
        accountID: stableZenIdentity(PINNED_KEY),
        pin: "hard",
      }),
    })

    expect(captured).toHaveLength(1)
    // Settlement ownership is unchanged: a standalone semantic inference has no
    // durable Session/lease identity, so it must not invent a settlement row.
    expect(yield* usageRows).toEqual({ records: 0, maintenance: 0 })
  }),
  instanceConfig,
  testOptions,
)
