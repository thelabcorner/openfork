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
  const routed: Array<{ providerID: string; modelID: string }> = []
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
    resolveRoutedModel: (input) =>
      Effect.sync(() => {
        routed.push({ providerID: input.providerID, modelID: input.modelID })
        if (input.providerID !== otherProviderID || input.modelID !== otherModelID) return undefined
        const attribution = {
          sessionID: input.sessionID,
          affinityDomain: "opencode-provider/other",
          providerID: otherProviderID,
          routeRevision: 1,
          routeKind: "public" as const,
        } satisfies ProviderRouteResolution.RouteAttribution
        return { model: otherModel, route: { attribution } as never }
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

  return { model, otherModel, provider, llm, sessionID, route, direct, inherited, routed, streamInputs }
}

test("Goal runtime lets an explicit cross-provider override own and report its own committed route", async () => {
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
  expect(f.routed).toEqual([{ providerID: "other", modelID: "other-model" }])
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
