import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Auth } from "@/auth"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { InstanceRef } from "@/effect/instance-ref"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const AMBIENT = "ambient-auth-secret-must-never-reach-the-wire"
const BOUND_ACCOUNT_SECRET = "bound-account-A-secret"
const PUBLIC_SENTINEL = "public"
const BASE_URL = "https://route-auth-suppression.invalid/v1"

interface Wire {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

const sse = (content: string) =>
  [
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n")

const authQueries: string[] = []

const authLayer = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: (providerID: string) =>
      Effect.sync(() => {
        authQueries.push(providerID)
        return { type: "oauth", refresh: AMBIENT, access: AMBIENT, expires: 0 } as unknown as Auth.Info
      }),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

const model = (providerID: string, modelID: string) =>
  ProviderTest.model({
    providerID: ProviderV2.ID.make(providerID),
    id: ModelV2.ID.make(modelID),
    api: { id: modelID, url: BASE_URL, npm: "@ai-sdk/openai-compatible" },
  })

const scenario = (input: {
  readonly providerID: string
  readonly modelID: string
  readonly boundSecret: string
  readonly route?: LLM.StreamInput["route"]
}) => {
  const wire: Wire[] = []
  const mdl = model(input.providerID, input.modelID)
  const info = ProviderTest.info({ id: ProviderV2.ID.make(input.providerID) }, mdl)
  const sdk = createOpenAICompatible({
    name: input.providerID,
    apiKey: input.boundSecret,
    baseURL: BASE_URL,
    fetch: (async (request: any, init: any) => {
      const headers: Record<string, string> = {}
      new Headers(init?.headers ?? (request as Request | undefined)?.headers).forEach((value, key) => {
        headers[key] = value
      })
      const raw = init?.body
      let body: Record<string, unknown> = {}
      try {
        body = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : ((raw ?? {}) as Record<string, unknown>)
      } catch {
        body = {}
      }
      wire.push({ url: String((request as any)?.url ?? request), headers, body })
      return new Response(sse("ok"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    }) as unknown as typeof globalThis.fetch,
  })
  const provider = ProviderTest.fake({
    model: mdl,
    info,
    getProvider: () => Effect.succeed(info),
    getLanguage: () => Effect.succeed(sdk.chatModel(input.modelID) as never),
  })
  return { wire, provider, mdl }
}

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([LLM.node]), [
    [Auth.node, authLayer],
    [Provider.node, ProviderTest.fake().layer],
  ]),
)

const run = (input: LLM.StreamInput, providerLayer: Layer.Layer<Provider.Service>) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    const layer = AppNodeBuilder.build(LayerNode.group([LLM.node]), [
      [Auth.node, authLayer],
      [Provider.node, providerLayer],
    ])
    return yield* Effect.promise(() =>
      Effect.runPromise(
        LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain)).pipe(
          Effect.provide(layer),
          Effect.provideService(InstanceRef, ctx),
        ),
      ),
    )
  })

const streamInput = (input: {
  readonly providerID: string
  readonly modelID: string
  readonly mdl: Provider.Model
  readonly route?: LLM.StreamInput["route"]
}): LLM.StreamInput => {
  const sessionID = SessionID.make("ses_route_auth_suppression_0000000000")
  return {
    user: {
      id: MessageID.make("msg_user_route_auth_suppression_000000"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make(input.providerID), modelID: ModelV2.ID.make(input.modelID) },
    },
    sessionID,
    model: input.mdl,
    agent: { name: "build", mode: "primary", options: {}, permission: [] },
    system: ["route auth suppression system policy"],
    messages: [{ role: "user", content: "hello" }],
    tools: {},
    retries: 0,
    ...(input.route ? { route: input.route } : {}),
  }
}

describe("LLM committed-route Auth suppression", () => {
  it.instance("a committed Public route never queries Auth and never puts the ambient secret on the wire", () =>
    Effect.gen(function* () {
      authQueries.length = 0
      const built = scenario({
        providerID: "opencode",
        modelID: "big-pickle",
        boundSecret: PUBLIC_SENTINEL,
        route: { routeKind: "public" },
      })
      yield* run(streamInput({ providerID: "opencode", modelID: "big-pickle", mdl: built.mdl, route: { routeKind: "public" } }), built.provider.layer)

      expect(authQueries).toEqual([])
      expect(built.wire.length).toBe(1)
      expect(built.wire[0]!.headers["authorization"]).toBe(`Bearer ${PUBLIC_SENTINEL}`)
      expect(JSON.stringify(built.wire)).not.toContain(AMBIENT)
    }),
  )

  it.instance("a committed account route never queries Auth and keeps the bound account transport", () =>
    Effect.gen(function* () {
      authQueries.length = 0
      const route = { routeKind: "account", accountID: "acct-console-a" } as const
      const built = scenario({
        providerID: "opencode",
        modelID: "big-pickle",
        boundSecret: BOUND_ACCOUNT_SECRET,
        route,
      })
      yield* run(streamInput({ providerID: "opencode", modelID: "big-pickle", mdl: built.mdl, route }), built.provider.layer)

      expect(authQueries).toEqual([])
      expect(built.wire.length).toBe(1)
      expect(built.wire[0]!.headers["authorization"]).toBe(`Bearer ${BOUND_ACCOUNT_SECRET}`)
      expect(JSON.stringify(built.wire)).not.toContain(AMBIENT)
    }),
  )

  it.instance("without a route the direct third-party path still queries ambient Auth exactly once", () =>
    Effect.gen(function* () {
      authQueries.length = 0
      const boundSecret = "direct-third-party-key"
      const built = scenario({
        providerID: "openai",
        modelID: "gpt-5.2",
        boundSecret,
      })
      yield* run(streamInput({ providerID: "openai", modelID: "gpt-5.2", mdl: built.mdl }), built.provider.layer)

      expect(authQueries).toEqual(["openai"])
      expect(built.wire.length).toBe(1)
      expect(built.wire[0]!.headers["authorization"]).toBe(`Bearer ${boundSecret}`)
    }),
  )
})
