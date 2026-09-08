import { describe, expect, test } from "bun:test"
import {
  InvalidRequestReason,
  LLMClient,
  LLMError,
  LLMEvent,
  LLMResponse,
  Model,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  PromptRevisor,
  normalizeClarifications,
  normalizeClarificationRound,
  sanitizeQuestion,
} from "@opencode-ai/core/prompt-revisor"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { resetToolChoiceCapabilityMemory } from "@opencode-ai/core/tool-choice-compatibility"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"

const modelRef: ModelV2.Ref = {
  providerID: ProviderV2.ID.make("prompt-revisor-test"),
  id: ModelV2.ID.make("test-model"),
}
const model = Model.make({ id: "test-model", provider: "prompt-revisor-test", route: OpenAIChat.route })
const generatedRequests: LLMRequest[] = []
let generatedResponses: Array<LLMResponse | LLMError> = []
let configEntries: Config.Entry[] = []

const llmClient = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (() => Effect.die("unused")) as unknown as LLMClientShape["stream"],
    generate: (request) => {
      generatedRequests.push(request)
      const next = generatedResponses.shift()
      if (!next) return Effect.die("prompt revisor test exhausted generated responses")
      return next instanceof LLMError ? Effect.fail(next) : Effect.succeed(next)
    },
  }),
)

const filesystem = Layer.mock(FileSystem.Service, {
  read: () => Effect.die("unexpected read"),
  grep: () => Effect.die("unexpected grep"),
  glob: () => Effect.die("unexpected glob"),
})

const catalog = Layer.succeed(
  Catalog.Service,
  Catalog.Service.of({
    transform: () => Effect.succeed({ dispose: Effect.void }),
    reload: () => Effect.void,
    provider: {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(undefined),
      small: () => Effect.succeed(undefined),
    },
  }),
)

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed(configEntries),
  }),
)

const sessions = Layer.mock(SessionStore.Service, {
  get: () => Effect.succeed(undefined),
})

const models = SessionRunnerModel.layerWith(
  () => Effect.die("unexpected session model resolution"),
  () => Effect.succeed(model),
)

const integrationLayer = AppNodeBuilder.build(PromptRevisor.node, [
  [LayerNodePlatform.llmClient, llmClient],
  [FileSystem.node, filesystem],
  [Catalog.node, catalog],
  [Config.node, config],
  [SessionRunnerModel.node, models],
  [SessionStore.node, sessions],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make(process.cwd()) })],
])
const it = testEffect(integrationLayer)

const callResponse = (name: string, input: unknown, id = `${name}-1`) =>
  LLMResponse.fromEvents([LLMEvent.toolCall({ id, name, input }), LLMEvent.finish({ reason: "tool-calls" })])!
const multiCallResponse = (...calls: Array<{ id: string; name: string; input: unknown }>) =>
  LLMResponse.fromEvents([
    ...calls.map((call) => LLMEvent.toolCall(call)),
    LLMEvent.finish({ reason: "tool-calls" }),
  ])!

const questionResponse = (input: unknown) => callResponse("question", input)
const revisionResponse = (content: string, references: unknown[] = []) =>
  callResponse("revised_prompt", { content, references }, "revision-1")

const textResponse = (text: string) =>
  LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.finish({ reason: "stop" }),
  ])!

describe("PromptRevisor", () => {
  test("sanitizes and bounds model-generated questions", () => {
    const question = sanitizeQuestion({
      question: `  ${"q".repeat(600)}  `,
      header: ` ${"h".repeat(50)} `,
      options: [
        { label: " A ", description: " first " },
        { label: "A", description: "duplicate" },
        { label: "", description: "empty" },
        ...Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index}`, description: "x" })),
      ],
      multiple: true,
      custom: false,
    })

    expect(question.question).toHaveLength(500)
    expect(question.header).toHaveLength(30)
    expect(question.options).toHaveLength(6)
    expect(question.options[0]).toEqual({ label: "A", description: "first" })
    expect(new Set(question.options.map((option) => option.label)).size).toBe(question.options.length)
    expect(question.multiple).toBe(true)
    expect(question.custom).toBe(false)
  })

  test("forces custom input when a question has no usable choices", () => {
    const question = sanitizeQuestion({
      question: "What should happen?",
      header: "Behavior",
      options: [{ label: "   ", description: "empty" }],
      custom: false,
    })
    expect(question.options).toEqual([])
    expect(question.custom).toBe(true)
  })

  test("normalizes clarification round input", () => {
    expect(normalizeClarificationRound(undefined)).toBe(0)
    expect(normalizeClarificationRound(Number.NaN)).toBe(0)
    expect(normalizeClarificationRound(-4)).toBe(0)
    expect(normalizeClarificationRound(1.9)).toBe(1)
  })

  test("bounds and preserves selected labels separately from free-form clarification details", () => {
    const detail = " d ".repeat(20_000)
    const result = normalizeClarifications([
      {
        question: ` ${"q".repeat(600)} `,
        answers: [" Preserve API ", "Preserve API", "", "x".repeat(900)],
        detail,
      },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.question).toHaveLength(500)
    expect(result[0]?.answers[0]).toBe("Preserve API")
    expect(result[0]?.answers).toHaveLength(2)
    expect(result[0]?.answers[1]).toHaveLength(500)
    expect(result[0]?.detail?.length).toBeLessThanOrEqual(16_384)
  })

  it.effect("interrupts for a question without a session, then resumes statelessly with the user's answer", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      generatedResponses = [
        questionResponse({
          questions: [
            {
              question: "Should the existing API remain backward compatible?",
              header: "Compatibility",
              options: [
                { label: "Preserve API", description: "Keep existing callers working" },
                { label: "Breaking change", description: "A migration is acceptable" },
              ],
              custom: true,
            },
          ],
        }),
      ]

      const revisor = yield* PromptRevisor.Service
      const first = yield* revisor.revise({ prompt: "Improve the parser implementation.", model: modelRef })
      expect(first.type).toBe("question")
      if (first.type !== "question") return
      expect(first.clarificationRound).toBe(1)
      expect(first.questions[0]).toMatchObject({
        header: "Compatibility",
        custom: true,
      })
      expect(generatedRequests[0]?.tools.map((tool) => tool.name).sort()).toEqual([
        "composer_context",
        "glob",
        "grep",
        "question",
        "read",
        "revised_prompt",
      ])

      generatedResponses = [
        revisionResponse("Improve the parser while preserving the existing public API and add regression tests."),
      ]
      const second = yield* revisor.revise({
        prompt: "Improve the parser implementation.",
        model: modelRef,
        clarifications: [
          {
            question: first.questions[0]!.question,
            answers: ["Preserve API"],
            detail: "Keep deprecated aliases for one release",
          },
        ],
        clarificationRound: first.clarificationRound,
      })

      expect(second).toMatchObject({
        type: "revision",
        prompt: "Improve the parser while preserving the existing public API and add regression tests.",
      })
      expect(JSON.stringify(generatedRequests[1]?.messages)).toContain("Preserve API")
      expect(JSON.stringify(generatedRequests[1]?.messages)).toContain("Keep deprecated aliases for one release")
    }),
  )

  it.effect("honors a configured Prompt Revisor system prompt", () =>
    Effect.gen(function* () {
      generatedRequests.length = 0
      generatedResponses = [revisionResponse("Final revised prompt")]
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({ prompt_revisor_prompt: "CUSTOM PROMPT REVISOR SYSTEM" }),
        }),
      ]
      const revisor = yield* PromptRevisor.Service
      const result = yield* revisor.revise({ prompt: "Improve this.", model: modelRef })
      expect(result.type).toBe("revision")
      expect(JSON.stringify(generatedRequests[0]?.system)).toContain("CUSTOM PROMPT REVISOR SYSTEM")
      expect(JSON.stringify(generatedRequests[0]?.system)).toContain("revised_prompt")
    }),
  )

  it.effect("default runtime shares required-to-auto capability learning across revisions", () =>
    Effect.gen(function* () {
      resetToolChoiceCapabilityMemory()
      configEntries = []
      generatedRequests.length = 0
      generatedResponses = [
        new LLMError({
          module: "PromptRevisorTest",
          method: "generate",
          reason: new InvalidRequestReason({
            message: '[invalid_request_error] only "auto" is supported for `tool_choice`; "required" is not supported',
            parameter: "tool_choice",
          }),
        }),
        revisionResponse("Adaptive revision"),
        revisionResponse("Remembered adaptive revision"),
      ]

      const revisor = yield* PromptRevisor.Service
      const first = yield* revisor.revise({ prompt: "Improve this.", model: modelRef })
      expect(first).toMatchObject({ type: "revision", prompt: "Adaptive revision" })
      expect(generatedRequests.slice(0, 2).map((request) => request.toolChoice?.type)).toEqual(["required", "auto"])

      const second = yield* revisor.revise({ prompt: "Improve this again.", model: modelRef })
      expect(second).toMatchObject({ type: "revision", prompt: "Remembered adaptive revision" })
      expect(generatedRequests.map((request) => request.toolChoice?.type)).toEqual(["required", "auto", "auto"])
      resetToolChoiceCapabilityMemory()
    }),
  )

  it.effect("uses revised_prompt as the authoritative terminal contract and resolves host composer resources", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        composerContext: ({ kinds }) =>
          Effect.succeed(
            kinds.includes("resource")
              ? [
                  {
                    kind: "resource" as const,
                    name: "API Docs",
                    clientName: "docs",
                    uri: "mcp://docs/api",
                    mimeType: "text/markdown",
                  },
                ]
              : [],
          ),
        generate: (request) => {
          requests.push(request)
          return Effect.succeed(
            revisionResponse("Use {{ref:docs}} before coding.", [
              { id: "docs", type: "resource", name: "API Docs", clientName: "docs", uri: "mcp://docs/api" },
            ]),
          )
        },
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        {
          prompt: "Make this implementation prompt better.",
          model: modelRef,
          draft: {
            mentions: [{ id: "m1", type: "file", token: "@src/a.ts", path: "src/a.ts" }],
            attachments: [{ id: "image-1", type: "image", filename: "bug.png", mime: "image/png" }],
          },
        },
        runtime,
      )

      expect(result).toEqual({
        type: "revision",
        prompt: "Use @API Docs before coding.",
        references: [
          {
            type: "resource",
            content: "@API Docs",
            start: 4,
            end: 13,
            name: "API Docs",
            clientName: "docs",
            uri: "mcp://docs/api",
            mimeType: "text/markdown",
          },
        ],
        tools: ["revised_prompt"],
        rounds: 1,
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]!.toolChoice).toBe("required")
      expect(requests[0]!.tools.map((tool) => tool.name).sort()).toEqual([
        "composer_context",
        "glob",
        "grep",
        "question",
        "read",
        "revised_prompt",
      ])
      expect(JSON.stringify(requests[0]!.messages)).toContain("existing-prompt-context")
      expect(JSON.stringify(requests[0]!.messages)).toContain("bug.png")
      expect(JSON.stringify(requests[0]!.messages)).not.toContain("blob:")
    }),
  )

  it.effect("feeds composer_context discovery back into the Revisor before structured completion", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [
        callResponse("composer_context", { query: "docs", kinds: ["resource"], limit: 5 }, "context-1"),
        revisionResponse("Consult {{ref:docs}} and implement the fix.", [
          { id: "docs", type: "resource", name: "API Docs", clientName: "docs", uri: "mcp://docs/api" },
        ]),
      ]
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        composerContext: () =>
          Effect.succeed([{ kind: "resource", name: "API Docs", clientName: "docs", uri: "mcp://docs/api" } as const]),
        generate: (request) => {
          requests.push(request)
          return Effect.succeed(responses.shift()!)
        },
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        { prompt: "Fix it using the docs.", model: modelRef },
        runtime,
      )
      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.tools).toEqual(["composer_context", "revised_prompt"])
      expect(result.prompt).toBe("Consult @API Docs and implement the fix.")
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]!.messages)).toContain("mcp://docs/api")
    }),
  )

  it.effect("forces the terminal tool on the final bounded round instead of trusting prose output", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [
        callResponse("composer_context", { query: "first", kinds: ["reference"], limit: 1 }, "recon-1"),
        callResponse("composer_context", { query: "second", kinds: ["reference"], limit: 1 }, "recon-2"),
        revisionResponse("Final structured revision"),
      ]
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        composerContext: () => Effect.succeed([]),
        generate: (request) => {
          requests.push(request)
          return Effect.succeed(responses.shift()!)
        },
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        { prompt: "Improve this.", model: modelRef },
        runtime,
      )
      expect(result.type).toBe("revision")
      expect(requests).toHaveLength(3)
      expect(requests.at(-1)!.tools.map((tool) => tool.name)).toEqual(["revised_prompt"])
      expect(requests.at(-1)!.toolChoice).toBe("required")
    }),
  )

  it.effect("retries one final single-tool round when an auto-only runtime returns prose", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [
        textResponse("Prose instead of the required completion tool"),
        revisionResponse("Structured retry succeeded"),
      ]
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: (request) => {
          requests.push(request)
          return Effect.succeed(responses.shift()!)
        },
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        { prompt: "Improve this.", model: modelRef },
        runtime,
      )
      expect(result.type).toBe("revision")
      expect(requests).toHaveLength(2)
      expect(requests[0]!.sessionID).toBeDefined()
      expect(requests[1]!.sessionID).toBe(requests[0]!.sessionID)
      expect(requests[1]!.tools.map((tool) => tool.name)).toEqual(["revised_prompt"])
      expect(JSON.stringify(requests[1]!.messages)).toContain("Protocol correction")
    }),
  )

  it.effect("repairs an invalid revised_prompt payload in the same terminal conversation", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [
        callResponse("revised_prompt", { content: "   ", references: [] }, "invalid-revision"),
        revisionResponse("Recovered structured revision"),
      ]
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: (request) => {
          requests.push(request)
          return Effect.succeed(responses.shift()!)
        },
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        { prompt: "Improve this.", model: modelRef },
        runtime,
      )
      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Recovered structured revision")
      expect(requests).toHaveLength(2)
      const retry = JSON.stringify(requests[1]!.messages)
      expect(retry).toContain("Protocol error")
      expect(retry).toContain("host rejected the previous completion")
      expect(retry).toContain("Protocol correction")
    }),
  )

  it.effect("repairs mixed terminal tool usage before accepting revised_prompt", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [
        multiCallResponse(
          { id: "unexpected-read", name: "read", input: { path: "src/index.ts" } },
          {
            id: "mixed-revision",
            name: "revised_prompt",
            input: { content: "Mixed but invalid terminal shape", references: [] },
          },
        ),
        revisionResponse("Recovered after mixed tools"),
      ]
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: (request) => {
          requests.push(request)
          return Effect.succeed(responses.shift()!)
        },
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        { prompt: "Improve this.", model: modelRef },
        runtime,
      )
      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Recovered after mixed tools")
      expect(requests).toHaveLength(2)
      const retry = JSON.stringify(requests[1]!.messages)
      expect(retry).toContain("Protocol error")
      expect(retry).toContain("Protocol correction")
      expect(requests[1]!.tools.map((tool) => tool.name)).toEqual(["revised_prompt"])
    }),
  )

  it.effect("fails after the bounded revised_prompt protocol repair is exhausted", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [textResponse("Terminal prose failure one"), textResponse("Terminal prose failure two")]
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: (request) => {
          requests.push(request)
          return Effect.succeed(responses.shift()!)
        },
      }

      const exit = yield* (yield* PromptRevisor.Service)
        .reviseWithRuntime({ prompt: "Improve this.", model: modelRef }, runtime)
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]!.messages)).toContain("Protocol correction")
    }),
  )
  it.effect("gives the dedicated Prompt Revisor model priority over the composer fallback", () =>
    Effect.gen(function* () {
      configEntries = []
      const dedicated: ModelV2.Ref = {
        providerID: ProviderV2.ID.make("dedicated-provider"),
        id: ModelV2.ID.make("dedicated-model"),
      }
      const composer: ModelV2.Ref = {
        providerID: ProviderV2.ID.make("composer-provider"),
        id: ModelV2.ID.make("composer-model"),
        variant: ModelV2.VariantID.make("high"),
      }
      let candidates: readonly ModelV2.Ref[] = []
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates: next }) => {
          candidates = next
          return Effect.succeed({ ref: next[0]!, value: {} })
        },
        generate: () => Effect.succeed(revisionResponse("Final revised prompt")),
      }

      const revisor = yield* PromptRevisor.Service
      const result = yield* revisor.reviseWithRuntime(
        { prompt: "Improve this.", model: dedicated, fallbackModel: composer },
        runtime,
      )

      expect(result.type).toBe("revision")
      expect(candidates[0]).toEqual(dedicated)
      expect(candidates[1]).toEqual(composer)
      expect(String(candidates[1]?.variant)).toBe("high")
    }),
  )

  it.effect("removes the question tool after the clarification budget is exhausted", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      generatedResponses = [revisionResponse("Use the supplied decisions and produce the final revised prompt.")]
      const revisor = yield* PromptRevisor.Service
      const result = yield* revisor.revise({
        prompt: "Improve this.",
        model: modelRef,
        clarificationRound: 2,
        clarifications: [{ question: "Scope?", answers: ["UI only"] }],
      })
      expect(result.type).toBe("revision")
      expect(generatedRequests[0]?.tools.map((tool) => tool.name).sort()).toEqual([
        "composer_context",
        "glob",
        "grep",
        "read",
        "revised_prompt",
      ])
    }),
  )
})





