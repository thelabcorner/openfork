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
import { Reference } from "@opencode-ai/core/reference"
import {
  PromptRevisor,
  normalizeClarifications,
  normalizeClarificationRound,
  sanitizeQuestion,
} from "@opencode-ai/core/prompt-revisor"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { MessageDecodeError } from "@opencode-ai/core/session/error"
import { resetToolChoiceCapabilityMemory } from "@opencode-ai/core/tool-choice-compatibility"
import { Cause, DateTime, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { testEffect } from "./lib/effect"

const modelRef: ModelV2.Ref = {
  providerID: ProviderV2.ID.make("prompt-revisor-test"),
  id: ModelV2.ID.make("test-model"),
}
const model = Model.make({ id: "test-model", provider: "prompt-revisor-test", route: OpenAIChat.route })
const generatedRequests: LLMRequest[] = []
let generatedResponses: Array<LLMResponse | LLMError> = []
let configEntries: Config.Entry[] = []
let referenceItems: Reference.Info[] = []
let sessionInfo: SessionSchema.Info | undefined
let sessionMessages: SessionMessage.Message[] = []

const llmClient = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      generatedRequests.push(request)
      const next = generatedResponses.shift()
      if (!next) return Stream.die("prompt revisor test exhausted generated responses")
      return next instanceof LLMError ? Stream.fail(next) : Stream.fromIterable(next.events)
    }) as LLMClientShape["stream"],
    generate: (request) => {
      generatedRequests.push(request)
      const next = generatedResponses.shift()
      if (!next) return Effect.die("prompt revisor test exhausted generated responses")
      return next instanceof LLMError ? Effect.fail(next) : Effect.succeed(next)
    },
  }),
)

let fileRead: (path: string) => Effect.Effect<{ content: Uint8Array; mime: string }> = () =>
  Effect.die("unexpected read")

const filesystem = Layer.mock(FileSystem.Service, {
  // The real FileSystem service has a `never` error channel and reports missing
  // paths, directories, and location escapes as defects, so the mock does too.
  read: (input: { path: string }) => fileRead(input.path),
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

const references = Layer.mock(Reference.Service, {
  list: () => Effect.succeed(referenceItems),
})

let sessionContextError: MessageDecodeError | undefined

const sessions = Layer.mock(SessionStore.Service, {
  get: () => Effect.succeed(sessionInfo),
  context: () => (sessionContextError ? Effect.fail(sessionContextError) : Effect.succeed(sessionMessages)),
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
  [Reference.node, references],
  [SessionRunnerModel.node, models],
  [SessionStore.node, sessions],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make(process.cwd()) })],
])
const it = testEffect(integrationLayer)

const callResponse = (name: string, input: unknown, id = `${name}-1`) =>
  LLMResponse.fromEvents([LLMEvent.toolCall({ id, name, input }), LLMEvent.finish({ reason: "tool-calls" })])!
const multiCallResponse = (...calls: Array<{ id: string; name: string; input: unknown }>) =>
  LLMResponse.fromEvents([...calls.map((call) => LLMEvent.toolCall(call)), LLMEvent.finish({ reason: "tool-calls" })])!

const questionResponse = (input: unknown) => callResponse("question", input)
const revisionResponse = (content: string, references: unknown[] = []) =>
  callResponse("revised_prompt", { content, references }, "revision-1")

const epoch = DateTime.makeUnsafe(0)
const sessionUser = (text: string): SessionMessage.Message =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    files: [],
    agents: [],
    time: { created: epoch },
  })
const sessionAssistant = (text: string): SessionMessage.Message =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build",
    model: {
      id: SessionMessage.Assistant.fields.model.fields.id.make("m"),
      providerID: SessionMessage.Assistant.fields.model.fields.providerID.make("p"),
    },
    content: [{ type: "text", id: "t", text }],
    time: { created: epoch },
  })

const textResponse = (text: string) =>
  LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.finish({ reason: "stop" }),
  ])!

/** A round the provider cut off at the output-token limit before any tool call. */
const truncatedResponse = (text = "Thinking about the rewrite") =>
  LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text }),
    LLMEvent.finish({ reason: "length" }),
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
      expect(JSON.stringify(generatedRequests[0]?.system)).toContain("IMMEDIATELY END GENERATION")
    }),
  )

  it.effect(
    "injects concrete conversation context for existing sessions but keeps new-session revisions context-free",
    () =>
      Effect.gen(function* () {
        configEntries = []
        generatedRequests.length = 0
        generatedResponses = [
          revisionResponse(
            "Implement the first-party Agent Swarms feature with a 3-member swarm and preserve coordinator-as-parent grouping.",
          ),
          revisionResponse("Improve the standalone draft without assuming prior conversation context."),
        ]
        const sessionID = SessionSchema.ID.make("ses_prompt_revisor_context")
        sessionInfo = {
          id: sessionID,
          location: { directory: AbsolutePath.make(process.cwd()) },
        } as SessionSchema.Info
        sessionMessages = [
          sessionUser("We are implementing Agent Swarms as a first-party feature using a 3-member swarm."),
          sessionAssistant(
            "The coordinator should be represented as the parent and swarm members should use the same grouping semantics as subagents.",
          ),
          sessionUser("Keep the project-explorer grouping API as the source of truth."),
        ]
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sessionInfo = undefined
            sessionMessages = []
          }),
        )

        const revisor = yield* PromptRevisor.Service
        const existing = yield* revisor.revise({ prompt: "Proceed with it.", model: modelRef, sessionID })
        expect(existing.type).toBe("revision")
        const existingRequest = JSON.stringify(generatedRequests[0]!.messages)
        expect(existingRequest).toContain("conversation-context")
        expect(existingRequest).toContain("Agent Swarms")
        expect(existingRequest).toContain("3-member swarm")
        expect(existingRequest).toContain("coordinator should be represented as the parent")
        expect(existingRequest).toContain("context-resolution-rule")
        expect(existingRequest).toContain("Do not emit vague meta-instructions")

        const fresh = yield* revisor.revise({ prompt: "Improve this standalone prompt.", model: modelRef })
        expect(fresh.type).toBe("revision")
        const freshRequest = JSON.stringify(generatedRequests[1]!.messages)
        expect(freshRequest).not.toContain("conversation-context")
        expect(freshRequest).not.toContain("context-resolution-rule")
        expect(freshRequest).not.toContain("Agent Swarms")
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

  it.effect("skips malformed project references whose runtime path is null instead of exposing a null sentinel", () =>
    Effect.gen(function* () {
      configEntries = []
      referenceItems = [
        {
          name: "Broken Reference",
          path: null,
          source: { type: "local", path: null },
        } as unknown as Reference.Info,
      ]
      yield* Effect.addFinalizer(() => Effect.sync(() => (referenceItems = [])))

      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [
        callResponse("composer_context", { query: "broken", kinds: ["reference"], limit: 5 }, "bad-ref-context"),
        revisionResponse("Final revised prompt without the malformed reference."),
      ]
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: (request) => {
          requests.push(request)
          return Effect.succeed(responses.shift()!)
        },
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        { prompt: "Improve this prompt.", model: modelRef },
        runtime,
      )

      expect(result).toMatchObject({
        type: "revision",
        prompt: "Final revised prompt without the malformed reference.",
      })
      expect(requests).toHaveLength(2)
      const continuation = JSON.stringify(requests[1]!.messages)
      expect(continuation).not.toContain('"path":"null"')
      expect(continuation).not.toContain("Broken Reference")
    }),
  )

  it.effect("repairs a revised_prompt file path equal to the null sentinel without touching the filesystem", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      generatedResponses = [
        revisionResponse("Inspect {{ref:bad_file}}.", [{ id: "bad_file", type: "file", path: "null" }]),
        revisionResponse("Inspect the relevant implementation files and fix the issue."),
      ]

      const result = yield* (yield* PromptRevisor.Service).revise({ prompt: "Fix the issue.", model: modelRef })

      expect(result).toMatchObject({
        type: "revision",
        prompt: "Inspect the relevant implementation files and fix the issue.",
      })
      expect(generatedRequests).toHaveLength(2)
      const repair = JSON.stringify(generatedRequests[1]!.messages)
      expect(repair).toContain("Protocol correction")
      expect(repair).toContain("invalid file reference path")
      expect(repair).toContain("null")
    }),
  )

  it.effect("rejects a null-sentinel reconnaissance path before filesystem access and lets the Revisor continue", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      generatedResponses = [
        callResponse("read", { path: "null" }, "bad-read"),
        revisionResponse("Inspect the relevant implementation files and fix the issue."),
      ]

      const result = yield* (yield* PromptRevisor.Service).revise({ prompt: "Fix the issue.", model: modelRef })

      expect(result).toMatchObject({
        type: "revision",
        prompt: "Inspect the relevant implementation files and fix the issue.",
      })
      expect(generatedRequests).toHaveLength(2)
      expect(JSON.stringify(generatedRequests[1]!.messages)).toContain("Prompt revision received an invalid file path")
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

  it.effect("ignores unused rich-reference declarations instead of failing the revision", () =>
    Effect.gen(function* () {
      configEntries = []
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: () =>
          Effect.succeed(
            revisionResponse("Implement the agreed feature directly.", [
              { id: "attachment_context", type: "file", path: "does-not-need-to-exist.ts" },
            ]),
          ),
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        { prompt: "Proceed with it.", model: modelRef },
        runtime,
      )

      expect(result).toMatchObject({
        type: "revision",
        prompt: "Implement the agreed feature directly.",
        references: [],
      })
    }),
  )

  it.effect("materializes every occurrence of a declared rich reference", () =>
    Effect.gen(function* () {
      configEntries = []
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        composerContext: () =>
          Effect.succeed([{ kind: "resource", name: "API Docs", clientName: "docs", uri: "mcp://docs/api" } as const]),
        generate: () =>
          Effect.succeed(
            revisionResponse("Read {{ref:docs}}, implement the change, then verify against {{ref:docs}}.", [
              { id: "docs", type: "resource", name: "API Docs", clientName: "docs", uri: "mcp://docs/api" },
            ]),
          ),
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        { prompt: "Improve this.", model: modelRef },
        runtime,
      )

      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Read @API Docs, implement the change, then verify against @API Docs.")
      expect(result.references).toHaveLength(2)
      expect(result.references?.map((item) => item.content)).toEqual(["@API Docs", "@API Docs"])
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
      const responses = [
        textResponse("Terminal prose failure one"),
        textResponse("Terminal prose failure two"),
        textResponse("Terminal prose failure three"),
        textResponse("Terminal prose failure four"),
      ]
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
      expect(requests).toHaveLength(4)
      expect(responses).toHaveLength(0)
      expect(JSON.stringify(requests[1]!.messages)).toContain("Protocol correction")
    }),
  )

  it.effect("escalates the output budget and reports truncation honestly instead of blaming the model", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [truncatedResponse(), truncatedResponse(), revisionResponse("Recovered after truncation")]
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
      expect(result.prompt).toBe("Recovered after truncation")
      expect(requests).toHaveLength(3)
      const budgets = requests.map((request) => request.generation.maxTokens!)
      expect(budgets[1]).toBeGreaterThan(budgets[0]!)
      expect(budgets[2]).toBeGreaterThan(budgets[0]!)
      expect(JSON.stringify(requests[1]!.messages)).toContain("output token limit")
    }),
  )

  it.effect("surfaces a truncation-specific failure once the escalated budget is still not enough", () =>
    Effect.gen(function* () {
      configEntries = []
      const responses = [truncatedResponse(), truncatedResponse(), truncatedResponse(), truncatedResponse()]
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: () => Effect.succeed(responses.shift()!),
      }

      const exit = yield* (yield* PromptRevisor.Service)
        .reviseWithRuntime({ prompt: "Improve this.", model: modelRef }, runtime)
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.squash(exit.cause)
      expect(String((error as PromptRevisor.UnavailableError).message)).toContain("output limit")
    }),
  )

  it.effect("commits a valid revision that arrives in a malformed turn rather than failing the request", () =>
    Effect.gen(function* () {
      configEntries = []
      const mixed = () =>
        multiCallResponse(
          { id: "stray-read", name: "read", input: { path: "src/index.ts" } },
          { id: "mixed-revision", name: "revised_prompt", input: { content: "Salvaged revision", references: [] } },
        )
      const responses = [mixed(), mixed(), mixed(), mixed()]
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: () => Effect.succeed(responses.shift()!),
      }

      const result = yield* (yield* PromptRevisor.Service).reviseWithRuntime(
        { prompt: "Improve this.", model: modelRef },
        runtime,
      )
      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Salvaged revision")
    }),
  )

  it.effect("falls back to a revision when the clarification interrupt itself is malformed", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [
        questionResponse({ questions: [{ header: "Scope", options: [] }] }),
        revisionResponse("Revised without a usable question"),
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
      expect(result.prompt).toBe("Revised without a usable question")
      expect(requests).toHaveLength(2)
      expect(requests[1]!.tools.map((tool) => tool.name)).toEqual(["revised_prompt"])
      expect(JSON.stringify(requests[1]!.messages)).toContain("question payload was invalid")
    }),
  )

  it.effect("falls back to a revision when a question is emitted alongside other tool calls", () =>
    Effect.gen(function* () {
      configEntries = []
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const responses = [
        multiCallResponse(
          { id: "stray-glob", name: "glob", input: { pattern: "**/*.ts" } },
          {
            id: "stray-question",
            name: "question",
            input: { questions: [{ question: "Scope?", header: "Scope", options: [] }] },
          },
        ),
        revisionResponse("Revised after a mixed question round"),
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
      expect(result.prompt).toBe("Revised after a mixed question round")
      expect(requests[1]!.tools.map((tool) => tool.name)).toEqual(["revised_prompt"])
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

  it.effect("revises without conversation context when the session history cannot be loaded", () =>
    Effect.gen(function* () {
      configEntries = []
      sessionInfo = {
        id: SessionSchema.ID.create(),
        location: { directory: AbsolutePath.make(process.cwd()) },
      } as SessionSchema.Info
      sessionContextError = new MessageDecodeError({
        sessionID: sessionInfo.id,
        messageID: SessionMessage.ID.create(),
      })
      const requests: PromptRevisor.RuntimeGenerateInput[] = []
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: (request) => {
          requests.push(request)
          return Effect.succeed(revisionResponse("Revised without conversation context"))
        },
      }

      const result = yield* (yield* PromptRevisor.Service)
        .reviseWithRuntime({ prompt: "Improve this.", model: modelRef, sessionID: sessionInfo.id }, runtime)
        .pipe(Effect.ensuring(Effect.sync(() => ((sessionContextError = undefined), (sessionInfo = undefined)))))

      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Revised without conversation context")
      expect(JSON.stringify(requests[0]!.messages)).not.toContain("conversation-context")
    }),
  )

  it.effect("heals a reference declaration the model never got right instead of failing the revision", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      // The model insists on a file declaration with no path. The content is
      // finished work, so the last attempt keeps it and drops the mention.
      const broken = () =>
        callResponse(
          "revised_prompt",
          { content: "Fix the parser in {{ref:target}} and add tests.", references: [{ id: "target", type: "file" }] },
          "broken-revision",
        )
      generatedResponses = [broken(), broken(), broken(), broken()]

      const result = yield* (yield* PromptRevisor.Service).revise({ prompt: "Fix the parser.", model: modelRef })

      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Fix the parser in and add tests.")
      expect(result.references).toEqual([])
      // Every attempt was spent asking for a correct declaration first.
      expect(generatedRequests).toHaveLength(4)
      expect(JSON.stringify(generatedRequests[1]!.messages)).toContain("malformed target reference declaration")
    }),
  )

  it.effect("keeps an unresolvable reference as plain text when a token can be recovered", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      referenceItems = []
      const broken = () =>
        callResponse(
          "revised_prompt",
          {
            content: "Delegate this to {{ref:agent}}.",
            references: [{ id: "agent", type: "agent", name: "nonexistent-agent" }],
          },
          "broken-agent",
        )
      generatedResponses = [broken(), broken(), broken(), broken()]

      const result = yield* (yield* PromptRevisor.Service).revise({ prompt: "Delegate this.", model: modelRef })

      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      // The user still sees the intent; it is plain text, not a rich mention.
      expect(result.prompt).toBe("Delegate this to @nonexistent-agent.")
      expect(result.references).toEqual([])
    }),
  )

  it.effect("strips an undeclared placeholder rather than rejecting the finished content", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      const broken = () =>
        callResponse("revised_prompt", { content: "Review {{ref:ghost}} carefully.", references: [] }, "ghost")
      generatedResponses = [broken(), broken(), broken(), broken()]

      const result = yield* (yield* PromptRevisor.Service).revise({ prompt: "Review it.", model: modelRef })

      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Review carefully.")
      expect(JSON.stringify(generatedRequests[1]!.messages)).toContain("undeclared reference placeholder")
    }),
  )

  it.effect("prefers a corrected declaration over healing when a retry is still available", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      referenceItems = []
      generatedResponses = [
        callResponse(
          "revised_prompt",
          { content: "Delegate to {{ref:a}}.", references: [{ id: "a", type: "agent" }] },
          "bad",
        ),
        callResponse(
          "revised_prompt",
          { content: "Delegate to the build agent.", references: [] },
          "good",
        ),
      ]

      const result = yield* (yield* PromptRevisor.Service).revise({ prompt: "Delegate this.", model: modelRef })

      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Delegate to the build agent.")
      expect(generatedRequests).toHaveLength(2)
    }),
  )

  it.effect("still rejects a payload whose content is unusable", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      const bad = () => callResponse("revised_prompt", { references: [] }, "no-content")
      generatedResponses = [bad(), bad(), bad(), bad()]

      const exit = yield* (yield* PromptRevisor.Service)
        .revise({ prompt: "Improve this.", model: modelRef })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(String((Cause.squash(exit.cause) as PromptRevisor.UnavailableError).message)).toContain(
        "content must be a string",
      )
    }),
  )

  it.effect("degrades a reference whose path is a directory instead of dying with a server error", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      // Exactly what FileSystem.read does for a directory target.
      fileRead = () => Effect.die(new Error("Path is not a file"))
      const broken = () =>
        revisionResponse("Refactor {{ref:dir}} carefully.", [
          { id: "dir", type: "file", path: "packages/core/src" },
        ])
      generatedResponses = [broken(), broken(), broken(), broken()]

      const result = yield* (yield* PromptRevisor.Service)
        .revise({ prompt: "Refactor the core package.", model: modelRef })
        .pipe(Effect.ensuring(Effect.sync(() => (fileRead = () => Effect.die("unexpected read")))))

      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Refactor @packages/core/src carefully.")
      expect(result.references).toEqual([])
    }),
  )

  it.effect("reports an unreadable reconnaissance path to the Revisor rather than failing the request", () =>
    Effect.gen(function* () {
      configEntries = []
      generatedRequests.length = 0
      fileRead = () => Effect.die(new Error("Path is not a file"))
      generatedResponses = [
        callResponse("read", { path: "packages/core/src" }, "dir-read"),
        revisionResponse("Revised after the failed reconnaissance read."),
      ]

      const result = yield* (yield* PromptRevisor.Service)
        .revise({ prompt: "Improve this.", model: modelRef })
        .pipe(Effect.ensuring(Effect.sync(() => (fileRead = () => Effect.die("unexpected read")))))

      expect(result.type).toBe("revision")
      if (result.type !== "revision") return
      expect(result.prompt).toBe("Revised after the failed reconnaissance read.")
      // The tool error is fed back into the same conversation.
      expect(JSON.stringify(generatedRequests[1]!.messages)).toContain("Unable to read packages/core/src")
    }),
  )

  it.effect("turns an unexpected defect into the typed composer failure instead of a 500", () =>
    Effect.gen(function* () {
      configEntries = []
      const runtime: PromptRevisor.Runtime = {
        resolveModel: ({ candidates }) => Effect.succeed({ ref: candidates[0]!, value: {} }),
        generate: () => Effect.die(new Error("boom")),
      }

      const exit = yield* (yield* PromptRevisor.Service)
        .reviseWithRuntime({ prompt: "Improve this.", model: modelRef }, runtime)
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.squash(exit.cause) as PromptRevisor.UnavailableError
      expect(error._tag).toBe("PromptRevisor.UnavailableError")
      expect(String(error.message)).toContain("Prompt revision failed unexpectedly")
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
