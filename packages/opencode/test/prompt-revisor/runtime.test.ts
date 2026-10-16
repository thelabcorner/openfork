import { describe, expect, test } from "bun:test"
import { makeRuntime } from "@/prompt-revisor/runtime"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM as SessionLLM } from "@/session/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { LLMEvent, Message } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"

const ref = (providerID: string, id: string, variant?: string): ModelV2.Ref =>
  ModelV2.Ref.make({
    providerID: ProviderV2.ID.make(providerID),
    id: ModelV2.ID.make(id),
    variant: variant ? ModelV2.VariantID.make(variant) : undefined,
  })

const providerModel = (providerID: string, id: string) =>
  ({ providerID: ProviderV2.ID.make(providerID), id: ModelV2.ID.make(id) }) as Provider.Model

const missing = (providerID: ProviderV2.ID, modelID: ModelV2.ID) =>
  Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))

const canonicalAgent: Agent.Info = {
  name: "prompt-revisor",
  description: "canonical prompt revisor",
  mode: "primary",
  native: true,
  hidden: true,
  permission: [],
  options: { canonical: true },
  prompt: "BUILT-IN PROMPT",
  temperature: 0.7,
}

const agents = {
  get: () => Effect.succeed(canonicalAgent),
} as unknown as Agent.Interface

const routeBinding = (input: {
  sessionID: SessionSchema.ID
  affinityDomain: string
  providerID: ProviderV2.ID
  routeRevision: number
  routeKind: "account" | "public"
  accountID?: string
  credentialHandle?: string
}): ProviderRoute.Binding =>
  input.routeKind === "account"
    ? {
        sessionID: input.sessionID,
        affinityDomain: input.affinityDomain,
        providerID: input.providerID,
        routeRevision: input.routeRevision,
        routeKind: "account",
        accountID: input.accountID!,
        credentialHandle: input.credentialHandle ?? `cred-${input.accountID}`,
        assignedAt: 1,
        assignmentEpoch: 1,
        reason: "initial",
      }
    : {
        sessionID: input.sessionID,
        affinityDomain: input.affinityDomain,
        providerID: input.providerID,
        routeRevision: input.routeRevision,
        routeKind: "public",
        assignedAt: 1,
        assignmentEpoch: 1,
        reason: "initial",
      }

const routesFor = (...bindings: ProviderRoute.Binding[]) =>
  ({
    get: (sessionID: SessionSchema.ID, affinityDomain: string) =>
      Effect.succeed(bindings.find((item) => item.sessionID === sessionID && item.affinityDomain === affinityDomain)),
  }) as unknown as ProviderRoute.Interface

describe("Prompt Revisor production runtime", () => {
  test("resolves candidates through Provider.getModel in priority order and preserves the selected variant", async () => {
    const dedicated = ref("dedicated", "revisor", "high")
    const composer = ref("composer", "chat")
    const calls: string[] = []
    const selected = providerModel("dedicated", "revisor")
    const provider = {
      getModel(providerID: ProviderV2.ID, modelID: ModelV2.ID) {
        calls.push(`${providerID}/${modelID}`)
        return providerID === dedicated.providerID && modelID === dedicated.id
          ? Effect.succeed(selected)
          : missing(providerID, modelID)
      },
      defaultModel: () => Effect.die("default model should not be consulted"),
    } as unknown as Provider.Interface
    const llm = { stream: () => Stream.empty } as SessionLLM.Interface

    const result = await Effect.runPromise(
      makeRuntime(provider, llm, agents).resolveModel({ candidates: [dedicated, composer] }),
    )

    expect(calls).toEqual(["dedicated/revisor"])
    expect(result.value).toBe(selected)
    expect(result.ref).toEqual(dedicated)
    expect(String(result.ref.variant)).toBe("high")
  })

  test("does not escape an explicit model chain into an unrelated provider default", async () => {
    const calls: string[] = []
    const fallback = providerModel("default-provider", "default-model")
    const provider = {
      getModel(providerID: ProviderV2.ID, modelID: ModelV2.ID) {
        calls.push(`${providerID}/${modelID}`)
        return providerID === fallback.providerID && modelID === fallback.id
          ? Effect.succeed(fallback)
          : missing(providerID, modelID)
      },
      defaultModel: () => Effect.succeed({ providerID: fallback.providerID, modelID: fallback.id }),
    } as unknown as Provider.Interface
    const llm = { stream: () => Stream.empty } as SessionLLM.Interface

    const exit = await Effect.runPromiseExit(
      makeRuntime(provider, llm, agents).resolveModel({ candidates: [ref("missing", "model")] }),
    )

    expect(calls).toEqual(["missing/model"])
    expect(exit._tag).toBe("Failure")
  })

  test("uses the provider default only when no model candidate exists", async () => {
    const calls: string[] = []
    const fallback = providerModel("default-provider", "default-model")
    const provider = {
      getModel(providerID: ProviderV2.ID, modelID: ModelV2.ID) {
        calls.push(`${providerID}/${modelID}`)
        return Effect.succeed(fallback)
      },
      defaultModel: () => Effect.succeed({ providerID: fallback.providerID, modelID: fallback.id }),
    } as unknown as Provider.Interface
    const llm = { stream: () => Stream.empty } as SessionLLM.Interface

    const result = await Effect.runPromise(makeRuntime(provider, llm, agents).resolveModel({ candidates: [] }))

    expect(calls).toEqual(["default-provider/default-model"])
    expect(result.value).toBe(fallback)
    expect(result.ref).toEqual(ref("default-provider", "default-model"))
  })

  test("a hosted provider default fails closed instead of streaming with no route", async () => {
    // No candidate chain at all: the provider default is still a real streaming
    // selection, so a hosted provider must reach llm.stream through an actual
    // route decision rather than a bare catalog lookup with ambient auth.
    const hostedDefault = { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("gpt-5-nano") }
    const transientCalls: Array<{ providerID: string; modelID: string }> = []
    const provider = {
      resolveTransientRoutedModel: (input: { providerID: string; modelID: string }) => {
        transientCalls.push({ providerID: input.providerID, modelID: input.modelID })
        return Effect.succeed(undefined)
      },
      getModel: () => Effect.die("a hosted provider default must not fall back to ambient provider auth"),
      defaultModel: () => Effect.succeed(hostedDefault),
    } as unknown as Provider.Interface

    const exit = await Effect.runPromiseExit(
      makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents).resolveModel({
        candidates: [],
      }),
    )

    expect(transientCalls).toEqual([{ providerID: "opencode", modelID: "gpt-5-nano" }])
    expect(exit._tag).toBe("Failure")
  })

  test("a hosted provider default that cannot resolve a route fails closed", async () => {
    const hostedDefault = { providerID: ProviderV2.ID.make("opencode-go"), modelID: ModelV2.ID.make("kimi-k2") }
    const provider = {
      resolveTransientRoutedModel: () =>
        Effect.fail(
          new Provider.RouteResolutionError({
            providerID: hostedDefault.providerID,
            modelID: hostedDefault.modelID,
            cause: new Error("no authoritative route"),
          }),
        ),
      getModel: () => Effect.die("a hosted provider default must not fall back to ambient provider auth"),
      defaultModel: () => Effect.succeed(hostedDefault),
    } as unknown as Provider.Interface

    const exit = await Effect.runPromiseExit(
      makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents).resolveModel({
        candidates: [],
      }),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("a non-hosted provider default keeps the legacy direct path without inventing a route", async () => {
    const fallback = providerModel("default-provider", "default-model")
    const provider = {
      resolveTransientRoutedModel: () => Effect.die("a legacy provider default must not force a route"),
      getModel: () => Effect.succeed(fallback),
      defaultModel: () =>
        Effect.succeed({ providerID: fallback.providerID, modelID: fallback.id }),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents).resolveModel({
        candidates: [],
      }),
    )

    expect(result.value).toBe(fallback)
    expect(result.route).toBeUndefined()
    expect(result.ref).toEqual(ref("default-provider", "default-model"))
  })

  test("the provider default propagates secret-free usage attribution from its transient route", async () => {
    const hostedDefault = { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("gpt-5-nano") }
    const defaultModel = providerModel("opencode", "gpt-5-nano")
    const provider = {
      resolveTransientRoutedModel: (input: { providerID: ProviderV2.ID; modelID: ModelV2.ID }) =>
        Effect.succeed({
          model: defaultModel,
          route: {
            route: {
              kind: "account",
              providerID: input.providerID,
              accountID: "default-account",
              credentialHandle: "cred-default",
              credentialRevision: 3,
            },
          },
          transport: { baseURL: "https://example.test", apiKey: "secret", headers: {} },
        } as unknown as Provider.TransientRoutedModel),
      getModel: () => Effect.die("a hosted provider default must not fall back to ambient provider auth"),
      defaultModel: () => Effect.succeed(hostedDefault),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents).resolveModel({
        candidates: [],
      }),
    )

    expect(result.value).toBe(defaultModel)
    expect(result.route).toEqual({ routeKind: "account", accountID: "default-account" })
    expect(result.ref.accountID).toBe("default-account")
    // The credential is transport-only: it must never reach route/usage
    // attribution or the durable model ref.
    expect(JSON.stringify(result.route)).not.toContain("cred-")
    expect(JSON.stringify(result.route)).not.toContain("secret")
  })

  test("preserves first-class provider account identity during model resolution", async () => {
    // A non-hosted provider: the OpenCode routing domain does not own it, so the
    // mature direct-provider path (with its account identity) stays valid.
    const selectedRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("third-party"),
      id: ModelV2.ID.make("gpt-5-nano"),
      accountID: "zen-account-42",
      variant: ModelV2.VariantID.make("high"),
    })
    const selected = providerModel("third-party", "gpt-5-nano@zen-account-42")
    const calls: Array<{ providerID: string; modelID: string; accountID?: string }> = []
    const provider = {
      getModel(providerID: ProviderV2.ID, modelID: ModelV2.ID, accountID?: string) {
        calls.push({ providerID, modelID, accountID })
        return Effect.succeed(selected)
      },
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const llm = { stream: () => Stream.empty } as SessionLLM.Interface

    const result = await Effect.runPromise(makeRuntime(provider, llm, agents).resolveModel({ candidates: [selectedRef] }))

    expect(calls).toEqual([{ providerID: "third-party", modelID: "gpt-5-nano", accountID: "zen-account-42" }])
    expect(result.ref).toEqual(selectedRef)
  })

  test("hosted draft execution fails closed instead of spending ambient auth", async () => {
    const hostedRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("opencode"),
      id: ModelV2.ID.make("gpt-5-nano"),
    })
    const provider = {
      resolveTransientRoutedModel: () => Effect.fail(new Provider.RouteResolutionError({
        providerID: hostedRef.providerID,
        modelID: hostedRef.id,
        cause: new Error("no authoritative route"),
      })),
      getModel: () => Effect.die("hosted draft execution must not fall back to ambient provider auth"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface

    const exit = await Effect.runPromiseExit(
      makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents).resolveModel({
        candidates: [hostedRef],
      }),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("Session-owned revision keeps one committed account route through model resolution and transport", async () => {
    const stableAccountID = "stable-account"
    const selectedRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("opencode-go"),
      id: ModelV2.ID.make("deepseek-v4.1-flash"),
      accountID: stableAccountID,
      variant: ModelV2.VariantID.make("max"),
    })
    const selected = providerModel("opencode-go", "deepseek-v4.1-flash")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_route")
    const routedCalls: Array<{ providerID: string; modelID: string; accountID?: string }> = []
    let directCalls = 0
    let request: SessionLLM.StreamInput | undefined
    const attribution = {
      sessionID,
      affinityDomain: "opencode-provider/opencode-go",
      providerID: selectedRef.providerID,
      routeRevision: 4,
      routeKind: "account" as const,
      accountID: stableAccountID,
    } satisfies ProviderRouteResolution.RouteAttribution
    const provider = {
      resolveInheritedRoutedModel(input: {
        sessionID: SessionSchema.ID
        providerID: ProviderV2.ID
        modelID: ModelV2.ID
        route: ProviderRouteResolution.RouteAttribution
      }) {
        routedCalls.push({ providerID: input.providerID, modelID: input.modelID, accountID: input.route.accountID })
        return Effect.succeed({ model: selected, route: { attribution } as never })
      },
      resolveTransientRoutedModel: () => Effect.die("committed Session route must be inherited, not resolved transiently"),
      getModel() {
        directCalls++
        return Effect.die("direct model lookup must not run after inherited routed resolution")
      },
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const llm = {
      stream(input: SessionLLM.StreamInput) {
        request = input
        return Stream.fromIterable([
          LLMEvent.toolCall({
            id: "revision-route",
            name: "revised_prompt",
            input: { content: "Routed revision", references: [] },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ])
      },
    } as SessionLLM.Interface
    const runtime = makeRuntime(
      provider,
      llm,
      agents,
      undefined,
      routesFor(
        routeBinding({
          sessionID,
          affinityDomain: attribution.affinityDomain,
          providerID: attribution.providerID,
          routeRevision: attribution.routeRevision,
          routeKind: "account",
          accountID: stableAccountID,
        }),
      ),
    )
    const session = { id: sessionID, model: selectedRef } as SessionSchema.Info

    const resolved = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef], session }))
    expect(resolved.route).toEqual({ routeKind: "account", accountID: stableAccountID })
    expect(resolved.ref.accountID).toBe(stableAccountID)
    expect(routedCalls).toEqual([
      { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", accountID: stableAccountID },
    ])
    expect(directCalls).toBe(0)

    const response = await Effect.runPromise(
      runtime.generate({
        model: resolved,
        sessionID,
        specialAgent: "prompt_revisor",
        system: "PROMPT REVISOR SYSTEM",
        messages: [Message.user("Improve this")],
        tools: [],
        toolChoice: "required",
        generation: {},
      }),
    )

    expect(response.toolCalls[0]?.name).toBe("revised_prompt")
    expect(request?.route).toEqual({ routeKind: "account", accountID: stableAccountID })
    expect(request?.user.model.accountID).toBe(stableAccountID)
  })

  test("same-provider automatic fallback inherits the Session route without hard-pinning stale account metadata", async () => {
    const stableAccountID = "stable-parent-account"
    const sessionRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("parent"),
      id: ModelV2.ID.make("chat"),
      accountID: stableAccountID,
    })
    const fallbackRef = ModelV2.Ref.make({
      providerID: sessionRef.providerID,
      id: ModelV2.ID.make("small"),
      accountID: "stale-fallback-account",
    })
    const fallbackModel = providerModel("parent", "small")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_same_provider_fallback")
    const routedCalls: Array<{ modelID: string; accountID?: string }> = []
    const attribution = {
      sessionID,
      affinityDomain: "opencode-provider/parent",
      providerID: sessionRef.providerID,
      routeRevision: 7,
      routeKind: "account" as const,
      accountID: stableAccountID,
    } satisfies ProviderRouteResolution.RouteAttribution
    const provider = {
      resolveInheritedRoutedModel(input: {
        modelID: ModelV2.ID
        route: ProviderRouteResolution.RouteAttribution
      }) {
        routedCalls.push({ modelID: input.modelID, accountID: input.route.accountID })
        return Effect.succeed({ model: fallbackModel, route: { attribution } as never })
      },
      resolveTransientRoutedModel: () => Effect.die("same-provider committed route must be inherited"),
      getModel: () => Effect.die("inherited fallback should not use direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const runtime = makeRuntime(
      provider,
      { stream: () => Stream.empty } as SessionLLM.Interface,
      agents,
      undefined,
      routesFor(
        routeBinding({
          sessionID,
          affinityDomain: attribution.affinityDomain,
          providerID: attribution.providerID,
          routeRevision: attribution.routeRevision,
          routeKind: "account",
          accountID: stableAccountID,
        }),
      ),
    )
    const session = { id: sessionID, model: sessionRef } as SessionSchema.Info

    const resolved = await Effect.runPromise(
      runtime.resolveModel({
        candidates: [fallbackRef, sessionRef],
        explicitCandidates: [],
        session,
      }),
    )

    expect(routedCalls).toEqual([{ modelID: "small", accountID: stableAccountID }])
    expect(resolved.ref.id).toBe(ModelV2.ID.make("small"))
    expect(resolved.ref.accountID).toBe(stableAccountID)
    expect(resolved.route).toEqual({ routeKind: "account", accountID: stableAccountID })
  })

  test("committed hosted Public route is never used for Prompt Revisor", async () => {
    const sessionRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("opencode"),
      id: ModelV2.ID.make("gpt-5-nano"),
    })
    const publicModel = providerModel("opencode", "gpt-5-nano")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_public_inherit")
    const attribution = {
      sessionID,
      affinityDomain: "opencode-provider/opencode",
      providerID: sessionRef.providerID,
      routeRevision: 2,
      routeKind: "public" as const,
    } satisfies ProviderRouteResolution.RouteAttribution
    const transientCalls: unknown[] = []
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("hosted Public must never be inherited for special agents"),
      resolveTransientRoutedModel: (input: unknown) => {
        transientCalls.push(input)
        return Effect.succeed(undefined)
      },
      getModel: () => Effect.die("hosted Public route must not use ambient direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const runtime = makeRuntime(
      provider,
      { stream: () => Stream.empty } as SessionLLM.Interface,
      agents,
      undefined,
      routesFor(
        routeBinding({
          sessionID,
          affinityDomain: attribution.affinityDomain,
          providerID: attribution.providerID,
          routeRevision: attribution.routeRevision,
          routeKind: "public",
        }),
      ),
    )
    const session = { id: sessionID, model: sessionRef } as SessionSchema.Info

    const exit = await Effect.runPromiseExit(runtime.resolveModel({ candidates: [sessionRef], session }))
    expect(exit._tag).toBe("Failure")
    expect(transientCalls).toEqual([
      { providerID: "opencode", modelID: "gpt-5-nano", routeIntent: { kind: "auto" }, executionPurpose: "special-agent" },
    ])
  })

  test("committed hosted Public parent remains unchanged while Prompt Revisor uses an account-backed transient route", async () => {
    const selected = ref("opencode", "gpt-5-nano")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_public_account")
    const model = providerModel("opencode", "gpt-5-nano")
    const calls: unknown[] = []
    let writes = 0
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("Public parent cannot be inherited by the revisor"),
      resolveTransientRoutedModel: (input: unknown) => {
        calls.push(input)
        return Effect.succeed({
          model,
          route: { route: { kind: "account", accountID: "revisor-account", providerID: selected.providerID } },
        } as unknown as Provider.TransientRoutedModel)
      },
      getModel: () => Effect.die("hosted model must not use ambient auth"),
      defaultModel: () => Effect.die("no fallback"),
    } as unknown as Provider.Interface
    const routes = {
      get: () => Effect.succeed(routeBinding({
        sessionID,
        affinityDomain: "opencode-provider/opencode",
        providerID: selected.providerID,
        routeRevision: 7,
        routeKind: "public",
      })),
      bindIfAbsent: () => { writes++; return Effect.die("cannot change parent binding") },
      compareAndSwap: () => { writes++; return Effect.die("cannot rebind parent") },
    } as unknown as ProviderRoute.Interface
    const runtime = makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents, undefined, routes)
    const result = await Effect.runPromise(runtime.resolveModel({
      candidates: [selected],
      session: { id: sessionID, model: selected } as SessionSchema.Info,
    }))
    expect(result.value).toBe(model)
    expect(result.route).toEqual({ routeKind: "account", accountID: "revisor-account" })
    expect(result.ref.accountID).toBe("revisor-account")
    expect(calls).toEqual([
      { providerID: "opencode", modelID: "gpt-5-nano", routeIntent: { kind: "auto" }, executionPurpose: "special-agent" },
    ])
    expect(writes).toBe(0)
  })

  test("a Session without a committed route resolves transiently and never durably binds", async () => {
    const sessionRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("opencode"),
      id: ModelV2.ID.make("gpt-5-nano"),
    })
    const transientModel = providerModel("opencode", "gpt-5-nano")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_no_route")
    const transientCalls: Array<{ providerID: string; modelID: string; routeIntent?: unknown; executionPurpose?: "special-agent" }> = []
    let routeWrites = 0
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("no committed route exists to inherit"),
      resolveTransientRoutedModel: (input: { providerID: string; modelID: string; routeIntent?: unknown }) => {
        transientCalls.push(input)
        return Effect.succeed({
          model: transientModel,
          route: {
            route: { kind: "account" as const, providerID: input.providerID, accountID: "revisor-account" },
          } as never,
        })
      },
      getModel: () => Effect.die("transient route resolution must not fall back to direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const routes = {
      get: () => Effect.succeed(undefined),
      bindIfAbsent: () => {
        routeWrites++
        return Effect.die("maintenance must never create a durable ProviderRoute")
      },
      compareAndSwap: () => {
        routeWrites++
        return Effect.die("maintenance must never rebind a durable ProviderRoute")
      },
      commitAccountSelection: () => {
        routeWrites++
        return Effect.die("maintenance must never commit a durable ProviderRoute")
      },
    } as unknown as ProviderRoute.Interface
    const runtime = makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents, undefined, routes)
    const session = { id: sessionID, model: sessionRef } as SessionSchema.Info

    const resolved = await Effect.runPromise(runtime.resolveModel({ candidates: [sessionRef], session }))

    expect(transientCalls).toEqual([
      { providerID: "opencode", modelID: "gpt-5-nano", routeIntent: { kind: "auto" }, executionPurpose: "special-agent" },
    ])
    expect(resolved.route).toEqual({ routeKind: "account", accountID: "revisor-account" })
    expect(resolved.value).toBe(transientModel)
    expect(routeWrites).toBe(0)
  })

  test("a Session whose model is not yet set resolves transiently and never durably binds", async () => {
    // A brand-new Session has an id but no committed model. An automatic
    // fallback must still not become the route owner: it resolves a
    // non-persistent route and never writes a durable ProviderRoute row.
    const candidateRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("opencode"),
      id: ModelV2.ID.make("gpt-5-nano"),
    })
    const transientModel = providerModel("opencode", "gpt-5-nano")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_new_session")
    const transientCalls: Array<{ providerID: string; modelID: string; routeIntent?: unknown; executionPurpose?: "special-agent" }> = []
    let routeWrites = 0
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("a new Session has no committed route to inherit"),
      resolveTransientRoutedModel: (input: { providerID: string; modelID: string; routeIntent?: unknown }) => {
        transientCalls.push(input)
        return Effect.succeed({
          model: transientModel,
          route: {
            route: { kind: "account" as const, providerID: input.providerID, accountID: "new-session-account" },
          } as never,
        })
      },
      getModel: () => Effect.die("an automatic fallback for a hosted provider must not use direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const routes = {
      get: () => Effect.succeed(undefined),
      bindIfAbsent: () => {
        routeWrites++
        return Effect.die("an automatic fallback must never create a durable ProviderRoute")
      },
      compareAndSwap: () => {
        routeWrites++
        return Effect.die("an automatic fallback must never rebind a durable ProviderRoute")
      },
      commitAccountSelection: () => {
        routeWrites++
        return Effect.die("an automatic fallback must never commit a durable ProviderRoute")
      },
    } as unknown as ProviderRoute.Interface
    const runtime = makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents, undefined, routes)
    const session = { id: sessionID } as SessionSchema.Info

    const resolved = await Effect.runPromise(
      runtime.resolveModel({ candidates: [candidateRef], explicitCandidates: [], session }),
    )

    expect(transientCalls).toEqual([
      { providerID: "opencode", modelID: "gpt-5-nano", routeIntent: { kind: "auto" }, executionPurpose: "special-agent" },
    ])
    expect(resolved.route).toEqual({ routeKind: "account", accountID: "new-session-account" })
    expect(resolved.value).toBe(transientModel)
    expect(routeWrites).toBe(0)
  })

  test("a Session whose model is not yet set still inherits an existing committed binding", async () => {
    // Same-provider maintenance with an already-committed binding must inherit
    // it exactly even before session.model is materialized; transient resolution
    // is only for the no-route case.
    const candidateRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("opencode-go"),
      id: ModelV2.ID.make("kimi-k2"),
    })
    const committedModel = providerModel("opencode-go", "kimi-k2")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_new_session_binding")
    const attribution = {
      sessionID,
      affinityDomain: "opencode-provider/opencode-go",
      providerID: candidateRef.providerID,
      routeRevision: 3,
      routeKind: "account" as const,
      accountID: "new-session-account",
    } satisfies ProviderRouteResolution.RouteAttribution
    const inheritedRoutes: ProviderRouteResolution.RouteAttribution[] = []
    const provider = {
      resolveInheritedRoutedModel: (input: { route: ProviderRouteResolution.RouteAttribution }) => {
        inheritedRoutes.push(input.route)
        return Effect.succeed({ model: committedModel, route: { attribution } as never })
      },
      resolveTransientRoutedModel: () =>
        Effect.die("an existing committed binding must be inherited, not resolved transiently"),
      getModel: () => Effect.die("an inherited binding must not use direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const runtime = makeRuntime(
      provider,
      { stream: () => Stream.empty } as SessionLLM.Interface,
      agents,
      undefined,
      routesFor(
        routeBinding({
          sessionID,
          affinityDomain: attribution.affinityDomain,
          providerID: attribution.providerID,
          routeRevision: attribution.routeRevision,
          routeKind: "account",
          accountID: "new-session-account",
        }),
      ),
    )
    const session = { id: sessionID } as SessionSchema.Info

    const resolved = await Effect.runPromise(
      runtime.resolveModel({ candidates: [candidateRef], explicitCandidates: [], session }),
    )

    expect(inheritedRoutes).toEqual([attribution])
    expect(resolved.value).toBe(committedModel)
    expect(resolved.route).toEqual({ routeKind: "account", accountID: "new-session-account" })
    expect(resolved.ref.accountID).toBe("new-session-account")
  })

  test("draft-mode hosted execution resolves a transient route instead of ambient auth", async () => {
    const draftRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("opencode"),
      id: ModelV2.ID.make("gpt-5-nano"),
    })
    const draftModel = providerModel("opencode", "gpt-5-nano")
    const transientCalls: Array<{ providerID: string; modelID: string }> = []
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("draft mode has no committed Session route"),
      resolveTransientRoutedModel: (input: { providerID: string; modelID: string }) => {
        transientCalls.push({ providerID: input.providerID, modelID: input.modelID })
        return Effect.succeed({
          model: draftModel,
          route: {
            route: { kind: "account" as const, providerID: input.providerID, accountID: "draft-account" },
          } as never,
        })
      },
      getModel: () => Effect.die("hosted draft execution must not fall back to ambient provider auth"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const runtime = makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents)

    const resolved = await Effect.runPromise(runtime.resolveModel({ candidates: [draftRef] }))

    expect(transientCalls).toEqual([{ providerID: "opencode", modelID: "gpt-5-nano" }])
    expect(resolved.value).toBe(draftModel)
    expect(resolved.route).toEqual({ routeKind: "account", accountID: "draft-account" })
  })

  test("automatic cross-provider fallback is skipped before any route resolution", async () => {
    const parentRef = ref("parent", "chat")
    const fallbackRef = ref("other", "small")
    const parentModel = providerModel("parent", "chat")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_parent_route")
    const routedCalls: Array<{ providerID: string; modelID: string }> = []
    const attribution = {
      sessionID,
      affinityDomain: "opencode-provider/parent",
      providerID: parentRef.providerID,
      routeRevision: 2,
      routeKind: "public" as const,
    } satisfies ProviderRouteResolution.RouteAttribution
    const provider = {
      resolveInheritedRoutedModel(input: { providerID: ProviderV2.ID; modelID: ModelV2.ID }) {
        routedCalls.push({ providerID: input.providerID, modelID: input.modelID })
        if (input.providerID !== parentRef.providerID) {
          return Effect.die("automatic cross-provider fallback must be skipped before route resolution")
        }
        return Effect.succeed({ model: parentModel, route: { attribution } as never })
      },
      resolveTransientRoutedModel: () =>
        Effect.die("automatic fallback must inherit the committed route, not resolve transiently"),
      getModel: () => Effect.die("inherited parent model should resolve without direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const runtime = makeRuntime(
      provider,
      { stream: () => Stream.empty } as SessionLLM.Interface,
      agents,
      undefined,
      routesFor(
        routeBinding({
          sessionID,
          affinityDomain: attribution.affinityDomain,
          providerID: attribution.providerID,
          routeRevision: attribution.routeRevision,
          routeKind: "public",
        }),
      ),
    )
    const session = { id: sessionID, model: parentRef } as SessionSchema.Info

    const resolved = await Effect.runPromise(
      runtime.resolveModel({
        candidates: [fallbackRef, parentRef],
        explicitCandidates: [],
        session,
      }),
    )

    expect(resolved.ref.providerID).toBe(parentRef.providerID)
    expect(resolved.route).toEqual({ routeKind: "public" })
    expect(routedCalls).toEqual([{ providerID: "parent", modelID: "chat" }])
  })

  test("explicit cross-provider Prompt Revisor override uses a transient route and never durably binds", async () => {
    const parentRef = ref("parent", "chat")
    const overrideRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("other"),
      id: ModelV2.ID.make("revisor"),
      accountID: "override-account",
      variant: ModelV2.VariantID.make("high"),
    })
    const overrideModel = providerModel("other", "revisor")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_explicit_override")
    const transientCalls: Array<{ providerID: string; modelID: string; accountID?: string; executionPurpose?: "special-agent" }> = []
    let routeWrites = 0
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("a cross-provider override cannot inherit the parent route"),
      resolveTransientRoutedModel: (input: { providerID: string; modelID: string; accountID?: string }) => {
        transientCalls.push(input)
        return Effect.succeed({
          model: overrideModel,
          route: {
            route: {
              kind: "account" as const,
              providerID: input.providerID,
              accountID: "override-account",
              credentialHandle: "cred-override",
            },
          } as never,
        })
      },
      getModel: () => Effect.die("explicit routed override should not use direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const routes = {
      get: () => Effect.succeed(undefined),
      bindIfAbsent: () => {
        routeWrites++
        return Effect.die("maintenance must never create a durable ProviderRoute")
      },
      compareAndSwap: () => {
        routeWrites++
        return Effect.die("maintenance must never rebind a durable ProviderRoute")
      },
      commitAccountSelection: () => {
        routeWrites++
        return Effect.die("maintenance must never commit a durable ProviderRoute")
      },
    } as unknown as ProviderRoute.Interface
    const runtime = makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents, undefined, routes)
    const session = { id: sessionID, model: parentRef } as SessionSchema.Info

    const resolved = await Effect.runPromise(
      runtime.resolveModel({
        candidates: [overrideRef, parentRef],
        explicitCandidates: [overrideRef],
        session,
      }),
    )

    expect(resolved.ref).toEqual(
      ModelV2.Ref.make({
        providerID: overrideRef.providerID,
        id: overrideRef.id,
        accountID: "override-account",
        variant: overrideRef.variant,
      }),
    )
    expect(resolved.route).toEqual({ routeKind: "account", accountID: "override-account" })
    expect(transientCalls).toEqual([{ providerID: "other", modelID: "revisor", accountID: "override-account", executionPurpose: "special-agent" }])
    expect(routeWrites).toBe(0)
  })

  test("executes revisions through Session LLM without persisting a session and forwards the output cap", async () => {
    const selectedRef = ref("dedicated", "revisor", "high")
    const selected = providerModel("dedicated", "revisor")
    let request: SessionLLM.StreamInput | undefined
    const provider = {
      getModel: () => Effect.succeed(selected),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const llm = {
      stream(input: SessionLLM.StreamInput) {
        request = input
        return Stream.fromIterable([
          LLMEvent.textStart({ id: "text-1" }),
          LLMEvent.textDelta({ id: "text-1", text: "Revised prompt" }),
          LLMEvent.textEnd({ id: "text-1" }),
          LLMEvent.finish({ reason: "stop" }),
        ])
      },
    } as SessionLLM.Interface
    const runtime = makeRuntime(provider, llm, agents)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const response = await Effect.runPromise(
      runtime.generate({
        model,
        specialAgent: "prompt_revisor",
        system: "PROMPT REVISOR SYSTEM",
        messages: [Message.user("Improve this")],
        tools: [],
        toolChoice: "none",
        generation: { maxTokens: 4096, temperature: 0.2 },
      }),
    )

    expect(response.text).toBe("Revised prompt")
    expect(request?.model).toBe(selected)
    expect(request?.agent.name).toBe("prompt-revisor")
    expect(request?.agent.prompt).toBe("PROMPT REVISOR SYSTEM")
    expect(request?.agent.options).toEqual({ canonical: true })
    expect(request?.user.model.variant).toBe("high")
    expect(request?.maxOutputTokens).toBe(4096)
    expect(request?.sessionID.startsWith("ses")).toBe(true)
  })

  test("forwards mid-conversation system reminders into the production Session LLM transcript", async () => {
    const selectedRef = ref("dedicated", "revisor", "high")
    const selected = providerModel("dedicated", "revisor")
    let request: SessionLLM.StreamInput | undefined
    const provider = {
      getModel: () => Effect.succeed(selected),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const llm = {
      stream(input: SessionLLM.StreamInput) {
        request = input
        return Stream.fromIterable([
          LLMEvent.textStart({ id: "text-1" }),
          LLMEvent.textDelta({ id: "text-1", text: "ok" }),
          LLMEvent.textEnd({ id: "text-1" }),
          LLMEvent.finish({ reason: "stop" }),
        ])
      },
    } as SessionLLM.Interface
    const runtime = makeRuntime(provider, llm, agents)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    await Effect.runPromise(
      runtime.generate({
        model,
        specialAgent: "prompt_revisor",
        system: "PROMPT REVISOR SYSTEM",
        messages: [Message.user("Improve this"), Message.system("[PROMPT REVISOR REMINDER] not a coding agent")],
        tools: [],
        toolChoice: "none",
        generation: {},
      }),
    )

    expect(request?.messages).toEqual([
      { role: "user", content: "Improve this" },
      { role: "system", content: "[PROMPT REVISOR REMINDER] not a coding agent" },
    ])
    expect(request?.agent.prompt).toBe("PROMPT REVISOR SYSTEM")
    expect(request?.agent.temperature).toBe(0.7)
  })

  test("stops consuming and finalizes the production Session LLM stream at revised_prompt", async () => {
    const selectedRef = ref("dedicated", "revisor")
    const selected = providerModel("dedicated", "revisor")
    let finalized = false
    let trailingPulled = false
    const provider = {
      getModel: () => Effect.succeed(selected),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const llm = {
      stream() {
        return Stream.concat(
          Stream.make(
            LLMEvent.toolCall({
              id: "terminal",
              name: "revised_prompt",
              input: { content: "Done", references: [] },
            }),
          ),
          Stream.fromEffect(
            Effect.sync(() => {
              trailingPulled = true
              return LLMEvent.textDelta({ id: "late", text: "should not be consumed" })
            }),
          ),
        ).pipe(Stream.ensuring(Effect.sync(() => (finalized = true))))
      },
    } as SessionLLM.Interface
    const runtime = makeRuntime(provider, llm, agents)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const response = await Effect.runPromise(
      runtime.generate({
        model,
        specialAgent: "prompt_revisor",
        system: "PROMPT REVISOR SYSTEM",
        messages: [Message.user("Improve this")],
        tools: [],
        toolChoice: "required",
        generation: { maxTokens: 4096 },
      }),
    )

    expect(response.toolCalls[0]?.name).toBe("revised_prompt")
    expect(response.finishReason).toBe("tool-calls")
    expect(trailingPulled).toBe(false)
    expect(finalized).toBe(true)
  })

  test("leaves required-to-auto negotiation to the owning Prompt Revisor operation", async () => {
    const selectedRef = ref("console-go", "revisor")
    const selected = providerModel("console-go", "revisor")
    const toolChoices: SessionLLM.StreamInput["toolChoice"][] = []
    const provider = {
      getModel: () => Effect.succeed(selected),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const llm = {
      stream(input: SessionLLM.StreamInput) {
        toolChoices.push(input.toolChoice)
        if (input.toolChoice === "required") {
          return Stream.fail(
            new Error(
              '[invalid_request_error] only "auto" is supported for `tool_choice`. "none", "required", and named function choices are not currently supported',
            ),
          )
        }
        return Stream.fromIterable([
          LLMEvent.toolCall({
            id: "call-1",
            name: "revised_prompt",
            input: { content: "Revised", references: [] },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ])
      },
    } as SessionLLM.Interface
    const runtime = makeRuntime(provider, llm, agents)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const exit = await Effect.runPromiseExit(
      runtime.generate({
        model,
        specialAgent: "prompt_revisor",
        system: "PROMPT REVISOR SYSTEM",
        messages: [Message.user("Improve this")],
        tools: [],
        toolChoice: "required",
        generation: { maxTokens: 4096, temperature: 0.2 },
      }),
    )

    expect(toolChoices).toEqual(["required"])
    expect(exit._tag).toBe("Failure")
  })

  test("does not downgrade unrelated required-tool failures", async () => {
    const selectedRef = ref("broken", "revisor")
    const selected = providerModel("broken", "revisor")
    const toolChoices: SessionLLM.StreamInput["toolChoice"][] = []
    const provider = {
      getModel: () => Effect.succeed(selected),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const llm = {
      stream(input: SessionLLM.StreamInput) {
        toolChoices.push(input.toolChoice)
        return Stream.fail(new Error("provider authentication failed"))
      },
    } as SessionLLM.Interface
    const runtime = makeRuntime(provider, llm, agents)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const exit = await Effect.runPromiseExit(
      runtime.generate({
        model,
        specialAgent: "prompt_revisor",
        system: "PROMPT REVISOR SYSTEM",
        messages: [Message.user("Improve this")],
        tools: [],
        toolChoice: "required",
        generation: { maxTokens: 4096, temperature: 0.2 },
      }),
    )

    expect(toolChoices).toEqual(["required"])
    expect(exit._tag).toBe("Failure")
  })

  test("does not downgrade generic invalid tool-choice requests without unsupported-mode evidence", async () => {
    const selectedRef = ref("strict-provider", "revisor")
    const selected = providerModel("strict-provider", "revisor")
    const toolChoices: SessionLLM.StreamInput["toolChoice"][] = []
    const provider = {
      getModel: () => Effect.succeed(selected),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const llm = {
      stream(input: SessionLLM.StreamInput) {
        toolChoices.push(input.toolChoice)
        return Stream.fail(new Error("[invalid_request_error] invalid tool_choice payload"))
      },
    } as SessionLLM.Interface
    const runtime = makeRuntime(provider, llm, agents)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const exit = await Effect.runPromiseExit(
      runtime.generate({
        model,
        specialAgent: "prompt_revisor",
        system: "PROMPT REVISOR SYSTEM",
        messages: [Message.user("Improve this")],
        tools: [],
        toolChoice: "required",
        generation: { maxTokens: 4096, temperature: 0.2 },
      }),
    )

    expect(toolChoices).toEqual(["required"])
    expect(exit._tag).toBe("Failure")
  })
})
