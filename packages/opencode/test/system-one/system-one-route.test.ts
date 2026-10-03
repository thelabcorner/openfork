import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ModelV2 } from "@opencode-ai/core/model"
import { OpenCodeHostedUserAgent } from "@opencode-ai/core/installation/version"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { Provider } from "@/provider/provider"
import { resetZenPoolForTest, setTestZenVaultCredentials } from "@/plugin/zen"
import { SystemOne } from "@/system-one/system-one"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const questions = {
  verdict: {
    type: "choice" as const,
    instructions: "Classify the candidate.",
    criteria: { pass: "Looks useful", inspect: "Needs review" },
  },
}

const POOL_DEFAULT = "ambient-pool-default-secret"
const AMBIENT_CONFIG_KEY = "ambient-configured-provider-key"
const SELECTED_ACCOUNT_SECRET = "selected-account-secret"
const PEER_ACCOUNT_SECRET = "peer-account-secret"

const hostedModel = ProviderTest.model({
  id: ModelV2.ID.make("jev-1.13-free"),
  providerID: ProviderV2.ID.make("opencode"),
  primitive: "system-one",
  api: {
    id: "jev-1.13-free",
    url: "https://opencode.ai/zen/v1",
    npm: "@ai-sdk/openai-compatible",
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
})

type RouteInput = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  accountID?: string
  routeIntent?: ProviderRouteIntent.Info
}

type RoutePlan = (input: RouteInput) => Effect.Effect<Provider.TransientRoutedModel | undefined, Provider.RouteResolutionError>

type Captured = {
  url: string
  authorization?: string
  headers: Readonly<Record<string, string>>
  body: unknown
}

const publicRoute = {
  kind: "public",
  providerID: "opencode",
  routeID: "opencode:public",
} as const

const accountRoute = (accountID: string) =>
  ({
    kind: "account",
    providerID: "opencode",
    accountID,
    credentialHandle: `cred-${accountID}`,
    credentialRevision: 7,
  }) as const

const resolution = (route: typeof publicRoute | ReturnType<typeof accountRoute>) => ({
  route,
  clientRouteIdentity: {
    providerID: "opencode",
    route:
      route.kind === "public"
        ? { kind: "public" as const, routeID: route.routeID }
        : {
            kind: "account" as const,
            credentialHandle: route.credentialHandle,
            credentialRevision: route.credentialRevision,
          },
  },
  candidateIssues: [],
})

const routedModel = (route: typeof publicRoute | ReturnType<typeof accountRoute>, apiKey: string) => ({
  model: hostedModel,
  route: resolution(route),
  transport: { baseURL: "https://opencode.ai/zen/v1", apiKey, headers: { "x-account-origin": "console" } },
})

const routeInputs: RouteInput[] = []
const accountSelectors: string[] = []
const directLookups: string[] = []
const captured: Captured[] = []
let plan: RoutePlan = () => Effect.succeed(undefined)
let respond: (() => Response) | undefined

const ok = () =>
  new Response(
    JSON.stringify({
      model: "jev-1.13-free",
      answers: {
        verdict: { type: "choice", choice: "inspect", confidence: 0.81, probabilities: { pass: 0.19, inspect: 0.81 } },
      },
      usage: { input_tokens: 250, output_tokens: 4 },
      request_id: "system-one-route-test",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

// A hosted System One request must reach exactly one authority: the transient
// route resolver. Both legacy escape hatches are booby-trapped so any fallback
// to ambient provider options or a direct catalog lookup fails the test.
const provider = ProviderTest.fake({
  model: hostedModel,
  info: ProviderTest.info({ key: AMBIENT_CONFIG_KEY, options: { apiKey: AMBIENT_CONFIG_KEY } }, hostedModel),
  getModel: () =>
    Effect.sync(() => {
      directLookups.push("getModel")
    }).pipe(Effect.flatMap(() => Effect.die(new Error("routed System One must not perform a direct model lookup")))),
  getProvider: () =>
    Effect.sync(() => {
      directLookups.push("getProvider")
    }).pipe(Effect.flatMap(() => Effect.die(new Error("routed System One must not read ambient provider options")))),
  resolveAccountID: (_providerID, selector) =>
    Effect.sync(() => {
      accountSelectors.push(selector)
      return selector.trim() === "Team Key 2" ? "account-a" : selector
    }),
  resolveTransientRoutedModel: (input) =>
    Effect.sync(() => {
      routeInputs.push({ ...input })
      return plan(input)
    }).pipe(Effect.flatten),
})

const requestLayer = Layer.succeed(
  RequestExecutor.Service,
  RequestExecutor.Service.of({
    execute: (request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        const body = JSON.parse(yield* Effect.promise(() => web.text()))
        captured.push({ url: request.url, authorization: request.headers.authorization, headers: request.headers, body })
        return HttpClientResponse.fromWeb(request, respond ? respond() : ok())
      }),
  }),
)

const it = testEffect(SystemOne.layer.pipe(Layer.provide(Layer.mergeAll(provider.layer, requestLayer))))

const infer = (input: Partial<Parameters<SystemOne.Interface["infer"]>[0]> = {}) =>
  SystemOne.Service.pipe(
    Effect.flatMap((service) =>
      service.infer({
        providerID: hostedModel.providerID,
        modelID: hostedModel.id,
        state: "candidate",
        questions,
        ...input,
      }),
    ),
  )

beforeEach(() => {
  routeInputs.length = 0
  accountSelectors.length = 0
  directLookups.length = 0
  captured.length = 0
  plan = () => Effect.succeed(undefined)
  respond = undefined
  setTestZenVaultCredentials([{ apiKey: POOL_DEFAULT, label: "ambient pool default", isDefault: true }])
})

afterEach(() => {
  setTestZenVaultCredentials(undefined)
  resetZenPoolForTest()
})

describe("System One routed transient authority", () => {
  it.effect("sends an explicit Public request with the public sentinel and canonical hosted identity", () =>
    Effect.gen(function* () {
      plan = () => Effect.succeed(routedModel(publicRoute, "public"))

      const result = yield* infer({ routeIntent: { kind: "public" }, affinityID: "proofgate-run-42" })

      expect(routeInputs).toHaveLength(1)
      expect(routeInputs[0]).toEqual({
        providerID: hostedModel.providerID,
        modelID: hostedModel.id,
        routeIntent: { kind: "public" },
      })
      expect(captured).toHaveLength(1)
      const request = captured[0]!
      expect(request.url).toBe("https://opencode.ai/zen/v1/systemone")
      expect(request.authorization).toBe("Bearer public")
      // Populated legacy pool and configured provider key are not authorities.
      expect(request.authorization).not.toContain(POOL_DEFAULT)
      expect(request.authorization).not.toContain(AMBIENT_CONFIG_KEY)
      expect(request.headers["x-account-origin"]).toBe("console")
      expect(request.headers["user-agent"]).toBe(OpenCodeHostedUserAgent())
      expect(request.headers["x-opencode-client"]).toBeTruthy()
      expect(request.headers["x-opencode-session"]).toMatch(/^ses_sem_[0-9a-f]{32}$/)
      expect(request.headers["x-opencode-request"]).toMatch(/^msg_/)
      expect(request.body).toEqual({ model: "jev-1.13-free", state: "candidate", questions })
      expect(result.cost).toEqual({ input: 0, output: 0, total: 0 })
      expect(directLookups).toEqual([])
    }),
  )

  it.effect("uses only the exact selected account secret for a hard-pinned account route", () =>
    Effect.gen(function* () {
      plan = () => Effect.succeed(routedModel(accountRoute("account-b"), SELECTED_ACCOUNT_SECRET))

      yield* infer({ routeIntent: { kind: "account", accountID: "account-b", pin: "hard" } })

      expect(routeInputs[0]).toEqual({
        providerID: hostedModel.providerID,
        modelID: hostedModel.id,
        routeIntent: { kind: "account", accountID: "account-b", pin: "hard" },
      })
      expect(captured[0]?.authorization).toBe(`Bearer ${SELECTED_ACCOUNT_SECRET}`)
      expect(captured[0]?.authorization).not.toContain(POOL_DEFAULT)
      expect(captured[0]?.authorization).not.toContain(AMBIENT_CONFIG_KEY)
      expect(captured[0]?.authorization).not.toContain(PEER_ACCOUNT_SECRET)
      expect(directLookups).toEqual([])
    }),
  )

  it.effect("normalizes a legacy human account label into the single route decision", () =>
    Effect.gen(function* () {
      plan = () => Effect.succeed(routedModel(accountRoute("account-a"), SELECTED_ACCOUNT_SECRET))

      yield* infer({ accountID: "  Team Key 2  " })

      expect(accountSelectors).toEqual(["  Team Key 2  "])
      expect(routeInputs).toHaveLength(1)
      expect(routeInputs[0]).toEqual({
        providerID: hostedModel.providerID,
        modelID: hostedModel.id,
        accountID: "account-a",
      })
      expect(captured[0]?.authorization).toBe(`Bearer ${SELECTED_ACCOUNT_SECRET}`)
      expect(directLookups).toEqual([])
    }),
  )

  it.effect("follows the resolver-selected Auto route instead of the populated default pool", () =>
    Effect.gen(function* () {
      plan = (input) =>
        Effect.succeed(
          routedModel(
            accountRoute(input.accountID === "account-a" ? "account-a" : "account-b"),
            input.accountID === "account-a" ? SELECTED_ACCOUNT_SECRET : PEER_ACCOUNT_SECRET,
          ),
        )

      yield* infer({ routeIntent: { kind: "auto" }, accountID: "account-a" })
      yield* infer({ routeIntent: { kind: "auto" } })

      expect(captured.map((request) => request.authorization)).toEqual([
        `Bearer ${SELECTED_ACCOUNT_SECRET}`,
        `Bearer ${PEER_ACCOUNT_SECRET}`,
      ])
      for (const request of captured) {
        expect(request.authorization).not.toContain(POOL_DEFAULT)
        expect(request.authorization).not.toContain(AMBIENT_CONFIG_KEY)
      }
      expect(directLookups).toEqual([])
    }),
  )

  it.effect("proves affinity is request identity, never route authorization", () =>
    Effect.gen(function* () {
      plan = (input) =>
        Effect.succeed(
          input.routeIntent?.kind === "public"
            ? routedModel(publicRoute, "public")
            : routedModel(accountRoute("account-b"), SELECTED_ACCOUNT_SECRET),
        )

      yield* infer({ routeIntent: { kind: "public" }, affinityID: "proofgate:campaign-17" })
      yield* infer({ routeIntent: { kind: "account", accountID: "account-b" }, affinityID: "proofgate:campaign-17" })
      yield* infer({ routeIntent: { kind: "public" }, affinityID: "proofgate:campaign-17" })

      expect(captured.map((request) => request.authorization)).toEqual([
        "Bearer public",
        `Bearer ${SELECTED_ACCOUNT_SECRET}`,
        "Bearer public",
      ])
      const sessions = new Set(captured.map((request) => request.headers["x-opencode-session"]))
      expect(sessions.size).toBe(1)
      expect([...sessions][0]).toMatch(/^ses_sem_[0-9a-f]{32}$/)
    }),
  )

  it.effect("fails a hosted request closed when the route authority resolves nothing", () =>
    Effect.gen(function* () {
      const error = yield* infer({ routeIntent: { kind: "auto" } }).pipe(Effect.flip)

      expect(error._tag).toBe("ProviderRouteResolutionError")
      expect(captured).toEqual([])
      expect(directLookups).toEqual([])
    }),
  )

  it.effect("fails closed on a missing or stale account without touching ambient credentials", () =>
    Effect.gen(function* () {
      plan = () =>
        Effect.fail(
          new Provider.RouteResolutionError({
            providerID: hostedModel.providerID,
            modelID: hostedModel.id,
            cause: new Error("Selected OpenCode account account-gone is no longer available"),
          }),
        )

      const error = yield* infer({ routeIntent: { kind: "account", accountID: "account-gone", pin: "hard" } }).pipe(
        Effect.flip,
      )

      expect(error._tag).toBe("ProviderRouteResolutionError")
      expect(captured).toEqual([])
      expect(directLookups).toEqual([])
    }),
  )

  it.effect("propagates a route-intent conflict without selecting any credential", () =>
    Effect.gen(function* () {
      plan = () =>
        Effect.fail(
          new Provider.RouteResolutionError({
            providerID: hostedModel.providerID,
            modelID: hostedModel.id,
            cause: new Error("ProviderRouteIntent.Conflict"),
          }),
        )

      const error = yield* infer({ accountID: "account-a", routeIntent: { kind: "public" } }).pipe(Effect.flip)

      expect(error._tag).toBe("ProviderRouteResolutionError")
      expect(captured).toEqual([])
      expect(directLookups).toEqual([])
    }),
  )

  it.effect("keeps one logical attempt and the same selected route after an upstream quota failure", () =>
    Effect.gen(function* () {
      plan = () => Effect.succeed(routedModel(accountRoute("account-b"), SELECTED_ACCOUNT_SECRET))
      respond = () => new Response(JSON.stringify({ error: "quota" }), { status: 429, headers: { "content-type": "application/json" } })

      const failure = yield* infer({ routeIntent: { kind: "account", accountID: "account-b" } }).pipe(Effect.flip)
      respond = undefined
      const success = yield* infer({ routeIntent: { kind: "account", accountID: "account-b" } })

      expect(failure._tag).toBe("LLM.Error")
      expect(captured).toHaveLength(2)
      expect(captured.map((request) => request.authorization)).toEqual([
        `Bearer ${SELECTED_ACCOUNT_SECRET}`,
        `Bearer ${SELECTED_ACCOUNT_SECRET}`,
      ])
      expect(success.model).toBe("jev-1.13-free")
    }),
  )

  it.effect("never exposes credential handle, revision, or bearer outside the wire request", () =>
    Effect.gen(function* () {
      plan = () => Effect.succeed(routedModel(accountRoute("account-b"), SELECTED_ACCOUNT_SECRET))

      const result = yield* infer({ routeIntent: { kind: "account", accountID: "account-b" } })

      const serialized = JSON.stringify({ result, body: captured[0]?.body, headers: captured[0]?.headers })
      expect(serialized).not.toContain("cred-account-b")
      expect(serialized).not.toContain("credentialRevision")
      expect(serialized).not.toContain(SELECTED_ACCOUNT_SECRET)
      expect(Object.keys(result).sort()).toEqual(["answers", "cost", "model", "raw", "usage"])
    }),
  )

})
