import { expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import * as Stream from "effect/Stream"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLMEvent, Message } from "@opencode-ai/llm"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { SessionSchema as CoreSessionSchema } from "@opencode-ai/core/session/schema"
import { GoalAuditor } from "@opencode-ai/core/goal/auditor"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { makeRuntime } from "@/goal/auditor-runtime"
import { ProviderTest } from "../fake/provider"

const parentProviderID = ProviderV2.ID.make("test")
const otherProviderID = ProviderV2.ID.make("other")
const parentModelID = ModelV2.ID.make("test-model")
const otherModelID = ModelV2.ID.make("other-model")

function fixture() {
  const model = ProviderTest.model({ providerID: parentProviderID, id: parentModelID })
  const otherModel = ProviderTest.model({ providerID: otherProviderID, id: otherModelID })
  const sessionID = CoreSessionSchema.ID.make("ses_goal_route_lineage")
  const route = {
    sessionID,
    affinityDomain: "opencode-provider/test",
    providerID: parentProviderID,
    routeRevision: 3,
    routeKind: "account",
    accountID: "account-test",
  } satisfies ProviderRouteResolution.RouteAttribution
  const direct: Array<{ providerID: string; modelID: string }> = []
  const inherited: Array<{ providerID: string; modelID: string }> = []
  const transient: Array<{ providerID: string; modelID: string }> = []
  const streamInputs: LLM.StreamInput[] = []
  const provider = ProviderTest.fake({
    model,
    getModel: Effect.fn("GoalRuntimeTest.getModel")((providerID, modelID) => {
      direct.push({ providerID, modelID })
      if (providerID === parentProviderID && modelID === parentModelID) return Effect.succeed(model)
      if (providerID === otherProviderID && modelID === otherModelID) return Effect.succeed(otherModel)
      return Effect.die(new Error(`unexpected direct lookup: ${providerID}/${modelID}`))
    }),
    resolveInheritedRoutedModel: Effect.fn("GoalRuntimeTest.resolveInheritedRoutedModel")((input) => {
      inherited.push({ providerID: input.providerID, modelID: input.modelID })
      const attribution = {
        ...route,
        providerID: input.providerID,
      } satisfies ProviderRouteResolution.RouteAttribution
      return Effect.succeed({ model, route: { attribution } as never })
    }),
    // A cross-provider maintenance override may use a distinct provider/account,
    // but it must not create a durable ProviderRoute row on the parent Session.
    // It therefore resolves a one-call transient route.
    resolveRoutedModel: () => Effect.die("maintenance overrides must not resolve a durable Session route"),
    resolveTransientRoutedModel: (input: { providerID: ProviderV2.ID; modelID: ModelV2.ID }) =>
      Effect.sync(() => {
        transient.push({ providerID: input.providerID, modelID: input.modelID })
        if (input.providerID !== otherProviderID || input.modelID !== otherModelID) return undefined
        return {
          model: otherModel,
          route: {
            route: { kind: "public" as const, providerID: otherProviderID, routeID: "other:public" },
          } as never,
          transport: { baseURL: "https://example.com", apiKey: "public", headers: {} },
        } as never
      }),
  })
  const llm = LLM.Service.of({
    stream: (input) => {
      streamInputs.push(input)
      return Stream.make(
        LLMEvent.toolCall({
          id: "audit-terminal",
          name: "audit_verdict",
          input: { decision: "complete" },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      )
    },
  })

  return { model, otherModel, provider, llm, sessionID, route, direct, inherited, transient, streamInputs }
}

test("Goal runtime lets an explicit cross-provider override use its own transient route", async () => {
  const f = fixture()
  const resolved = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const runtime = makeRuntime(provider, f.llm, { sessionID: f.sessionID, route: f.route })
      return yield* runtime.resolveModel({
        configured: { providerID: otherProviderID, id: otherModelID },
        workerModel: { providerID: parentProviderID, id: parentModelID },
      })
    }).pipe(Effect.provide(f.provider.layer)),
  )

  expect(resolved.value).toBe(f.otherModel)
  expect(resolved.route).toEqual({ routeKind: "public" })
  expect(resolved.ref).toEqual({ providerID: otherProviderID, id: otherModelID })
  expect(f.transient).toEqual([{ providerID: "other", modelID: "other-model" }])
  expect(f.direct).toEqual([])
  expect(f.inherited).toEqual([])
})

test("Goal runtime resolves the worker model through the exact inherited route", async () => {
  const f = fixture()
  const resolved = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const runtime = makeRuntime(provider, f.llm, { sessionID: f.sessionID, route: f.route })
      return yield* runtime.resolveModel({
        workerModel: { providerID: parentProviderID, id: parentModelID },
      })
    }).pipe(Effect.provide(f.provider.layer)),
  )

  expect(resolved.value).toBe(f.model)
  expect(resolved.route).toEqual({ routeKind: "account", accountID: "account-test" })
  expect(resolved.ref.accountID).toBe("account-test")
  expect(f.direct).toEqual([])
  expect(f.inherited).toEqual([{ providerID: "test", modelID: "test-model" }])
})


test("Goal runtime generation uses the route selected during resolution rather than the parent route", async () => {
  const f = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const runtime = makeRuntime(provider, f.llm, { sessionID: f.sessionID, route: f.route })
      const resolved = yield* runtime.resolveModel({
        configured: { providerID: otherProviderID, id: otherModelID },
      })
      yield* runtime.generate({
        model: resolved,
        sessionID: f.sessionID,
        system: "audit",
        messages: [Message.user("verify")],
        tools: [],
        toolChoice: "required",
        generation: {},
        publish: () => Effect.void,
      })
    }).pipe(Effect.provide(f.provider.layer)),
  )

  expect(f.streamInputs).toHaveLength(1)
  expect(f.streamInputs[0]?.route).toEqual({ routeKind: "public" })
  expect(f.streamInputs[0]?.user.model.accountID).toBeUndefined()
})

test("Goal runtime preserves direct model lookup when no parent route exists", async () => {
  const f = fixture()
  const resolved = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const runtime = makeRuntime(provider, f.llm)
      return yield* runtime.resolveModel({
        workerModel: { providerID: parentProviderID, id: parentModelID },
      })
    }).pipe(Effect.provide(f.provider.layer)),
  )

  expect(resolved.value).toBe(f.model)
  expect(f.direct).toEqual([{ providerID: "test", modelID: "test-model" }])
  expect(f.inherited).toEqual([])
})

test("Goal runtime fails closed on an account identity that conflicts with the parent route", async () => {
  const f = fixture()
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const runtime = makeRuntime(provider, f.llm, { sessionID: f.sessionID, route: f.route })
      return yield* Effect.exit(
        runtime.resolveModel({
          configured: {
            providerID: parentProviderID,
            id: parentModelID,
            accountID: "another-account",
          },
          workerModel: { providerID: parentProviderID, id: parentModelID },
        }),
      )
    }).pipe(Effect.provide(f.provider.layer)),
  )

  expect(exit._tag).toBe("Failure")
  expect(f.direct).toEqual([])
  expect(f.inherited).toEqual([])
})

test("Goal auditor uses an account-backed transient route when the parent is on hosted Public", async () => {
  const hostedProvider = ProviderV2.ID.make("opencode")
  const hostedModelID = ModelV2.ID.make("gpt-5-nano")
  const model = ProviderTest.model({ providerID: hostedProvider, id: hostedModelID })
  const sessionID = CoreSessionSchema.ID.make("ses_goal_public_parent")
  const parentRoute = {
    sessionID,
    affinityDomain: "opencode-provider/opencode",
    providerID: hostedProvider,
    routeRevision: 4,
    routeKind: "public",
  } satisfies ProviderRouteResolution.RouteAttribution
  const attempted: unknown[] = []
  const providerLayer = ProviderTest.fake({
    model,
    resolveRoutedModel: () => Effect.die("Goal auditor must not create or rebind a durable route"),
    resolveInheritedRoutedModel: () => Effect.die("Goal auditor must not inherit restricted hosted Public"),
    getModel: () => Effect.die("Goal auditor must not use hosted ambient auth"),
    resolveTransientRoutedModel: (input) => Effect.sync(() => {
      attempted.push(input)
      return {
        model,
          route: {
            route: {
              kind: "account",
              providerID: hostedProvider,
              accountID: "auditor-account",
              credentialHandle: "opaque-transport-only",
            },
          },
          transport: { baseURL: "https://example.test", apiKey: "transient-account-secret", headers: {} },
        } as unknown as Provider.TransientRoutedModel
    }),
  })
  const f = fixture()
  const resolved = await Effect.runPromise(Effect.gen(function* () {
    const provider = yield* Provider.Service
    return yield* makeRuntime(provider, f.llm, { sessionID, route: parentRoute }).resolveModel({
      workerModel: { providerID: hostedProvider, id: hostedModelID },
    })
  }).pipe(Effect.provide(providerLayer.layer)))

  expect(attempted).toEqual([{
    providerID: "opencode",
    modelID: "gpt-5-nano",
    routeIntent: { kind: "auto" },
    executionPurpose: "special-agent",
  }])
  expect(resolved.value).toBe(model)
  expect(resolved.route).toEqual({ routeKind: "account", accountID: "auditor-account" })
  expect(resolved.ref.accountID).toBe("auditor-account")
  expect(JSON.stringify(resolved)).not.toContain("opaque-transport-only")
})

test("Goal runtime refuses hosted Public even when transient routing returns it", async () => {
  const f = fixture()
  const providerID = ProviderV2.ID.make("opencode")
  const modelID = ModelV2.ID.make("gpt-5-nano")
  const hosted = ProviderTest.model({ providerID, id: modelID })
  const calls: Array<Parameters<Provider.Interface["resolveTransientRoutedModel"]>[0]> = []
  const provider = ProviderTest.fake({
    model: hosted,
    getModel: () => Effect.die("hosted Public must never fall through to direct lookup"),
    resolveTransientRoutedModel: (input) => Effect.sync(() => {
      calls.push(input)
      return {
        model: hosted,
        route: { route: { kind: "public", providerID, routeID: "opencode:public" } },
        transport: { baseURL: "https://example.test", apiKey: "public", headers: {} },
      } as never
    }),
  })
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const bound = yield* Provider.Service
      return yield* Effect.exit(makeRuntime(bound, f.llm).resolveModel({
        workerModel: { providerID, id: modelID },
      }))
    }).pipe(Effect.provide(provider.layer)),
  )
  expect(calls).toEqual([{ providerID, modelID, routeIntent: { kind: "auto" }, executionPurpose: "special-agent" }])
  expect(exit._tag).toBe("Failure")
  expect(f.streamInputs).toHaveLength(0)
})
