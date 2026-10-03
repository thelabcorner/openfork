import { describe, expect, test } from "bun:test"
import { makeRuntime } from "@/prompt-revisor/runtime"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM as SessionLLM } from "@/session/llm"
import { ModelV2 } from "@opencode-ai/core/model"
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

  test("preserves first-class provider account identity during model resolution", async () => {
    const selectedRef = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("opencode"),
      id: ModelV2.ID.make("gpt-5-nano"),
      accountID: "zen-account-42",
      variant: ModelV2.VariantID.make("high"),
    })
    const selected = providerModel("opencode", "gpt-5-nano@zen-account-42")
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

    expect(calls).toEqual([{ providerID: "opencode", modelID: "gpt-5-nano", accountID: "zen-account-42" }])
    expect(result.ref).toEqual(selectedRef)
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
      resolveRoutedModel(input: {
        sessionID: SessionSchema.ID
        providerID: ProviderV2.ID
        modelID: ModelV2.ID
        accountID?: string
      }) {
        routedCalls.push({
          providerID: input.providerID,
          modelID: input.modelID,
          ...(input.accountID ? { accountID: input.accountID } : {}),
        })
        return Effect.succeed({ model: selected, route: { attribution } as never })
      },
      getModel() {
        directCalls++
        return Effect.die("direct model lookup must not run after routed resolution")
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
    const runtime = makeRuntime(provider, llm, agents)
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
      resolveRoutedModel(input: {
        sessionID: SessionSchema.ID
        providerID: ProviderV2.ID
        modelID: ModelV2.ID
        accountID?: string
      }) {
        routedCalls.push({
          modelID: input.modelID,
          ...(input.accountID ? { accountID: input.accountID } : {}),
        })
        return Effect.succeed({ model: fallbackModel, route: { attribution } as never })
      },
      getModel: () => Effect.die("routed fallback should not use direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const runtime = makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents)
    const session = { id: sessionID, model: sessionRef } as SessionSchema.Info

    const resolved = await Effect.runPromise(
      runtime.resolveModel({
        candidates: [fallbackRef, sessionRef],
        explicitCandidates: [],
        session,
      }),
    )

    expect(routedCalls).toEqual([{ modelID: "small" }])
    expect(resolved.ref.accountID).toBe(stableAccountID)
    expect(resolved.route).toEqual({ routeKind: "account", accountID: stableAccountID })
  })

  test("automatic cross-provider fallback cannot create a second Session route", async () => {
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
      resolveRoutedModel(input: {
        sessionID: SessionSchema.ID
        providerID: ProviderV2.ID
        modelID: ModelV2.ID
      }) {
        routedCalls.push({ providerID: input.providerID, modelID: input.modelID })
        if (input.providerID !== parentRef.providerID) {
          return Effect.die("automatic cross-provider fallback must be skipped before route resolution")
        }
        return Effect.succeed({ model: parentModel, route: { attribution } as never })
      },
      getModel: () => Effect.die("routed parent model should resolve without direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const runtime = makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents)
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

  test("explicit cross-provider Prompt Revisor override may own its own committed route", async () => {
    const parentRef = ref("parent", "chat")
    const overrideRef = ref("other", "revisor", "high")
    const overrideModel = providerModel("other", "revisor")
    const sessionID = SessionSchema.ID.make("ses_prompt_revisor_explicit_override")
    const routedCalls: Array<{ providerID: string; modelID: string }> = []
    const attribution = {
      sessionID,
      affinityDomain: "opencode-provider/other",
      providerID: overrideRef.providerID,
      routeRevision: 1,
      routeKind: "account" as const,
      accountID: "override-account",
    } satisfies ProviderRouteResolution.RouteAttribution
    const provider = {
      resolveRoutedModel(input: {
        sessionID: SessionSchema.ID
        providerID: ProviderV2.ID
        modelID: ModelV2.ID
      }) {
        routedCalls.push({ providerID: input.providerID, modelID: input.modelID })
        return Effect.succeed({ model: overrideModel, route: { attribution } as never })
      },
      getModel: () => Effect.die("explicit routed override should not use direct lookup"),
      defaultModel: () => Effect.die("unused"),
    } as unknown as Provider.Interface
    const runtime = makeRuntime(provider, { stream: () => Stream.empty } as SessionLLM.Interface, agents)
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
    expect(routedCalls).toEqual([{ providerID: "other", modelID: "revisor" }])
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
