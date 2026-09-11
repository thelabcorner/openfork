import { describe, expect, test } from "bun:test"
import { makeRuntime } from "@/prompt-revisor/runtime"
import { Provider } from "@/provider/provider"
import { LLM as SessionLLM } from "@/session/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
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
      makeRuntime(provider, llm).resolveModel({ candidates: [dedicated, composer] }),
    )

    expect(calls).toEqual(["dedicated/revisor"])
    expect(result.value).toBe(selected)
    expect(result.ref).toEqual(dedicated)
    expect(String(result.ref.variant)).toBe("high")
  })

  test("falls back to the production provider default when requested candidates are unavailable", async () => {
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

    const result = await Effect.runPromise(
      makeRuntime(provider, llm).resolveModel({ candidates: [ref("missing", "model")] }),
    )

    expect(calls).toEqual(["missing/model", "default-provider/default-model"])
    expect(result.value).toBe(fallback)
    expect(result.ref).toEqual(ref("default-provider", "default-model"))
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
    const runtime = makeRuntime(provider, llm)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const response = await Effect.runPromise(
      runtime.generate({
        model,
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
    expect(request?.user.model.variant).toBe("high")
    expect(request?.maxOutputTokens).toBe(4096)
    expect(request?.sessionID.startsWith("ses")).toBe(true)
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
    const runtime = makeRuntime(provider, llm)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const response = await Effect.runPromise(
      runtime.generate({
        model,
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

  test("retries required tool choice as auto when the upstream only supports auto", async () => {
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
    const runtime = makeRuntime(provider, llm)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const response = await Effect.runPromise(
      runtime.generate({
        model,
        system: "PROMPT REVISOR SYSTEM",
        messages: [Message.user("Improve this")],
        tools: [],
        toolChoice: "required",
        generation: { maxTokens: 4096, temperature: 0.2 },
      }),
    )

    expect(toolChoices).toEqual(["required", "auto"])
    expect(response.toolCalls[0]?.name).toBe("revised_prompt")

    await Effect.runPromise(
      runtime.generate({
        model,
        system: "PROMPT REVISOR SYSTEM",
        messages: [Message.user("Improve this again")],
        tools: [],
        toolChoice: "required",
        generation: { maxTokens: 4096, temperature: 0.2 },
      }),
    )

    expect(toolChoices).toEqual(["required", "auto", "auto"])
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
    const runtime = makeRuntime(provider, llm)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const exit = await Effect.runPromiseExit(
      runtime.generate({
        model,
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
    const runtime = makeRuntime(provider, llm)
    const model = await Effect.runPromise(runtime.resolveModel({ candidates: [selectedRef] }))

    const exit = await Effect.runPromiseExit(
      runtime.generate({
        model,
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
