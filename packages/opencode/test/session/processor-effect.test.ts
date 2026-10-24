import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { sql } from "drizzle-orm"
import { APICallError, tool } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderAccountRouteHealthTable } from "@opencode-ai/core/provider-route-health.sql"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { SessionSchema as CoreSessionSchema } from "@opencode-ai/core/session/schema"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import * as CurrentParts from "@opencode-ai/core/session/current-parts"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"
import { ProviderTest } from "../fake/provider"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const claudeRef = {
  providerID: ProviderV2.ID.make("claude"),
  modelID: ModelV2.ID.make("claude-fable-5-1[1m]"),
}
const CLAUDE_FALLBACK_MODEL = ModelV2.ID.make("claude-opus-5-5[1m]")

const accountRouteLease = (
  sessionID: SessionID,
  accountID = "acct-fixed-route",
  credentialRevision = 7,
): ProviderRouteResolution.ProviderRouteLease => ({
  sessionID: CoreSessionSchema.ID.make(sessionID),
  affinityDomain: "opencode-provider/test",
  routeRevision: 1,
  route: {
    kind: "account",
    providerID: ref.providerID,
    accountID,
    credentialHandle: "cred_test_route",
    credentialRevision,
  },
})

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (
  sessionID: SessionID,
  text: string,
  model: typeof ref = ref,
) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
  model: typeof ref = ref,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: model.modelID,
    providerID: model.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  CurrentParts.node,
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  SessionExecutionOwner.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

// Real V1 processor, Session, status owner and durable message storage, but a
// deterministic provider stream that sends only transport start and hangs.
let silentProviderCalls = 0
const silentProviderLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () => {
      silentProviderCalls++
      return Stream.make(LLMEvent.stepStart({ index: 0 })).pipe(Stream.concat(Stream.never))
    },
  }),
)
const itSilentProvider = testEffect(LayerNode.compile(root, [...replacements, [LLM.node, silentProviderLLM]]))

let staleReasoningAttempts = 0
let staleReasoningRequests: Array<LLM.StreamInput["messages"]> = []
const staleReasoningLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      staleReasoningAttempts++
      staleReasoningRequests.push(structuredClone(input.messages))
      if (staleReasoningAttempts === 1) {
        return Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "reasoning `encrypted_content` was not issued to this caller" }),
        )
      }
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-stale-recovered" }),
        LLMEvent.textDelta({ id: "text-stale-recovered", text: "recovered" }),
        LLMEvent.textEnd({ id: "text-stale-recovered" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      )
    },
  }),
)
const staleReasoningProvider = ProviderTest.fake({
  model: ProviderTest.model({
    providerID: ref.providerID,
    id: ref.modelID,
    limit: { context: 100_000, output: 10_000 },
  }),
})
const staleReasoningEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, staleReasoningLLM],
  [Provider.node, staleReasoningProvider.layer],
])
const itStaleReasoning = testEffect(staleReasoningEnv)

const promptRenderingRef = {
  providerID: ProviderV2.ID.make("opencode-go"),
  modelID: ModelV2.ID.make("cat-jam-free"),
}
let promptRenderingAttempts = 0
let promptRenderingRequests: Array<LLM.StreamInput["messages"]> = []
let promptRenderingAfterEvent = false
let promptRenderingAlwaysFail = false
let promptRenderingAsEvent = false
const promptRenderingLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      promptRenderingAttempts++
      promptRenderingRequests.push(structuredClone(input.messages))
      const failure = Stream.fail(
        new APICallError({
          message: "Upstream request failed: [prompt_rendering_failed] The request could not be rendered",
          url: "https://example.test/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 502,
          responseHeaders: {},
          responseBody: JSON.stringify({ error: { code: "prompt_rendering_failed" } }),
          isRetryable: true,
        }),
      )
      if (promptRenderingAttempts === 1 && promptRenderingAsEvent) {
        return Stream.make(LLMEvent.providerError({
          message: "Upstream request failed: [prompt_rendering_failed] The request could not be rendered",
        }))
      }
      if (promptRenderingAfterEvent) return Stream.make(LLMEvent.stepStart({ index: 0 })).pipe(Stream.concat(failure))
      if (promptRenderingAttempts === 1 || promptRenderingAlwaysFail) return failure
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "render-recovered" }),
        LLMEvent.textDelta({ id: "render-recovered", text: "portable history accepted" }),
        LLMEvent.textEnd({ id: "render-recovered" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      )
    },
  }),
)
const promptRenderingProvider = ProviderTest.fake({
  model: ProviderTest.model({
    providerID: promptRenderingRef.providerID,
    id: promptRenderingRef.modelID,
    api: { id: promptRenderingRef.modelID, url: "https://example.test/v1", npm: "@ai-sdk/openai-compatible" },
  }),
})
const itPromptRendering = testEffect(LayerNode.compile(root, [
  ...replacements,
  [LLM.node, promptRenderingLLM],
  [Provider.node, promptRenderingProvider.layer],
]))

const claudeFallbackLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({
          id: "claude-fallback",
          providerMetadata: {
            claude: {
              event: "model_refusal_fallback",
              scope: "session",
              originalModelID: claudeRef.modelID,
              fallbackModelID: CLAUDE_FALLBACK_MODEL,
              category: "bio",
            },
          },
        }),
        LLMEvent.reasoningDelta({ id: "claude-fallback", text: "Claude switched models after a refusal." }),
        LLMEvent.reasoningEnd({ id: "claude-fallback" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const claudeFallbackProvider = ProviderTest.fake({
  model: ProviderTest.model({
    providerID: claudeRef.providerID,
    id: claudeRef.modelID,
    limit: { context: 1_000_000, output: 128_000 },
  }),
})
const claudeFallbackEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, claudeFallbackLLM],
  [Provider.node, claudeFallbackProvider.layer],
])
const itClaudeFallback = testEffect(claudeFallbackEnv)

const retryRouteInputs: Array<LLM.StreamInput["route"]> = []
let retryRouteAttempts = 0
const routedRetryLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      retryRouteInputs.push(input.route)
      retryRouteAttempts++
      if (retryRouteAttempts === 1) {
        return Stream.fail(
          new APICallError({
            message: "retry committed route",
            url: "https://example.test/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 503,
            responseHeaders: { "retry-after-ms": "0" },
            responseBody: '{"error":{"message":"retry committed route"}}',
            isRetryable: true,
          }),
        )
      }
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-route-retry" }),
        LLMEvent.textDelta({ id: "text-route-retry", text: "after routed retry" }),
        LLMEvent.textEnd({ id: "text-route-retry" }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          providerMetadata: { openfork: { accountID: "acct-wrong-route" } },
        }),
        LLMEvent.finish({ reason: "stop" }),
      )
    },
  }),
)
const routedRetryProvider = ProviderTest.fake({
  model: ProviderTest.model({
    providerID: ref.providerID,
    id: ref.modelID,
    limit: { context: 100_000, output: 10_000 },
  }),
})
const routedRetryEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, routedRetryLLM],
  [Provider.node, routedRetryProvider.layer],
])
const itRoutedRetry = testEffect(routedRetryEnv)

let routedHealthFailureInputs: Array<LLM.StreamInput["route"]> = []
const routedHealthFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      routedHealthFailureInputs.push(input.route)
      return Stream.fail(
        new APICallError({
          message: "account throttled",
          url: "https://example.test/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after": "120" },
          responseBody: '{"error":{"message":"account throttled"}}',
          isRetryable: true,
        }),
      )
    },
  }),
)
const routedHealthFailureEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, routedHealthFailureLLM],
  [Provider.node, routedRetryProvider.layer],
])
const itRoutedHealthFailure = testEffect(routedHealthFailureEnv)

let releaseCoalesce: Deferred.Deferred<void> | undefined
const coalesceLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () => Stream.unwrap(Effect.gen(function* () {
      releaseCoalesce = yield* Deferred.make<void>()
      return Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        ...Array.from({ length: 10_000 }, () => LLMEvent.reasoningDelta({ id: "reasoning-1", text: "x" })),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.textStart({ id: "text-1" }),
        ...Array.from({ length: 10_000 }, () => LLMEvent.textDelta({ id: "text-1", text: "x" })),
      ).pipe(
        Stream.concat(Stream.fromEffect(Deferred.await(releaseCoalesce)).pipe(Stream.drain)),
        Stream.concat(Stream.make(
          LLMEvent.textEnd({ id: "text-1" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        )),
      )
    })),
  }),
)
const coalesceEnv = LayerNode.compile(root, [...replacements, [LLM.node, coalesceLLM]])
const itCoalesce = testEffect(coalesceEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itClaudeFallback.live("session.processor persists a session-scoped Claude refusal fallback at the Session owner", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service

      const chat = yield* session.create({})
      yield* session.setAgentModel({
        sessionID: chat.id,
        agent: "build",
        model: {
          providerID: claudeRef.providerID,
          id: claudeRef.modelID,
          variant: "high",
        },
        time: Date.now(),
      })
      const parent = yield* user(chat.id, "fallback please", claudeRef)
      const msg = yield* assistant(chat.id, parent.id, directory, claudeRef)
      const mdl = yield* provider.getModel(claudeRef.providerID, claudeRef.modelID)
      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
      })

      const value = yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: claudeRef.providerID, modelID: claudeRef.modelID, variant: "high" },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "fallback please" }],
        tools: {},
      })

      const updated = yield* session.get(chat.id)
      expect(value).toBe("continue")
      expect(updated.model).toEqual({
        providerID: claudeRef.providerID,
        id: CLAUDE_FALLBACK_MODEL,
        variant: "high",
      })
    }),
  ),
)

itClaudeFallback.live("session.processor never lets a stale Claude fallback overwrite a newer Session model", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service

      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "fallback race", claudeRef)
      const msg = yield* assistant(chat.id, parent.id, directory, claudeRef)
      const mdl = yield* provider.getModel(claudeRef.providerID, claudeRef.modelID)
      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
      })

      // Simulate a user/host model change after this physical turn was admitted
      // but before Claude reports its refusal fallback.
      yield* session.setAgentModel({
        sessionID: chat.id,
        agent: "build",
        model: {
          providerID: claudeRef.providerID,
          id: ModelV2.ID.make("claude-sonnet-5"),
          variant: "medium",
        },
        time: Date.now(),
      })

      yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: claudeRef.providerID, modelID: claudeRef.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "fallback race" }],
        tools: {},
      })

      const updated = yield* session.get(chat.id)
      expect(updated.model).toEqual({
        providerID: claudeRef.providerID,
        id: ModelV2.ID.make("claude-sonnet-5"),
        variant: "medium",
      })
    }),
  ),
)

itClaudeFallback.live("session.processor never persists a Claude fallback over protected delegated-worker model ownership", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service

      const chat = yield* session.create({
        agent: "build",
        model: {
          providerID: claudeRef.providerID,
          id: claudeRef.modelID,
          variant: "high",
        },
        metadata: SessionMetadataOwnership.delegatedWorker({
          producer: "oxp",
          principalRef: "oxp:claude-fallback-test",
          invocationRef: "oxp-inv:claude-fallback-test",
          rootRef: "root-claude-fallback-test",
          agent: "build",
          model: {
            providerID: String(claudeRef.providerID),
            modelID: String(claudeRef.modelID),
            variant: "high",
            routeIntent: { kind: "strategy" },
          },
          nestedDelegation: false,
        }),
      })
      const parent = yield* user(chat.id, "delegated fallback", claudeRef)
      const msg = yield* assistant(chat.id, parent.id, directory, claudeRef)
      const mdl = yield* provider.getModel(claudeRef.providerID, claudeRef.modelID)
      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
      })

      const value = yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: claudeRef.providerID, modelID: claudeRef.modelID, variant: "high" },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "delegated fallback" }],
        tools: {},
      })

      const updated = yield* session.get(chat.id)
      expect(value).toBe("continue")
      expect(updated.model).toEqual({
        providerID: claudeRef.providerID,
        id: claudeRef.modelID,
        variant: "high",
      })
      expect(SessionMetadataOwnership.workerDelegation(updated.metadata)?.model).toMatchObject({
        providerID: String(claudeRef.providerID),
        modelID: String(claudeRef.modelID),
        variant: "high",
        routeIntent: { kind: "strategy" },
      })
    }),
  ),
)

itRoutedRetry.live("session.processor retries preserve the exact committed route attribution", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      retryRouteInputs.length = 0
      retryRouteAttempts = 0

      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service
      const { db, readDb } = yield* Database.Service
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "retry with committed route")
      const msg = yield* assistant(chat.id, parent.id, directory)
      const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
      const committedRoute = { routeKind: "account" as const, accountID: "acct-fixed-route" }
      const routeLease = accountRouteLease(chat.id, committedRoute.accountID)
      yield* db
        .insert(ProviderAccountRouteHealthTable)
        .values({
          provider_id: ref.providerID,
          account_id: committedRoute.accountID,
          model_id: mdl.id,
          state: "auth-invalid",
          credential_revision: 7,
          expires_at: null,
          observed_at: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* readDb.get<{ state: string }>(sql`
          SELECT state
          FROM provider_account_route_health
          WHERE provider_id = ${ref.providerID}
            AND account_id = ${committedRoute.accountID}
            AND model_id = ${mdl.id}
        `),
      ).toEqual({ state: "auth-invalid" })
      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
        routeAttribution: committedRoute,
        routeLease,
      })

      const value = yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: ref.providerID, modelID: ref.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "retry with committed route" }],
        tools: {},
      })

      expect(value).toBe("continue")
      expect(retryRouteAttempts).toBe(2)
      expect(retryRouteInputs).toEqual([committedRoute, committedRoute])
      const parts = yield* MessageV2.parts(msg.id)
      expect(parts.some((part) => part.type === "text" && part.text === "after routed retry")).toBe(true)

      // Response metadata is validation-only. Even a contradictory account from
      // the successful physical retry cannot rewrite committed settlement.
      const settled = yield* readDb.get<{ route_kind: string | null; account_id: string | null }>(sql`
        SELECT route_kind, account_id
        FROM usage_record
        WHERE message_id = ${msg.id}
      `)
      expect(settled).toEqual({
        route_kind: "account",
        account_id: committedRoute.accountID,
      })
      expect(
        yield* readDb.get<{ state: string }>(sql`
          SELECT state
          FROM provider_account_route_health
          WHERE provider_id = ${ref.providerID}
            AND account_id = ${committedRoute.accountID}
            AND model_id = ${mdl.id}
        `),
      ).toBeUndefined()
    }),
  ),
)

itRoutedHealthFailure.live("session.processor records terminal account cooldown from the exact committed lease", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      routedHealthFailureInputs = []

      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service
      const { readDb } = yield* Database.Service
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "terminal account cooldown")
      const msg = yield* assistant(chat.id, parent.id, directory)
      const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
      const committedRoute = { routeKind: "account" as const, accountID: "acct-health-failure" }
      const routeLease = accountRouteLease(chat.id, committedRoute.accountID, 9)
      const before = Date.now()

      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
        routeAttribution: committedRoute,
        routeLease,
      })

      const value = yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: ref.providerID, modelID: ref.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "terminal account cooldown" }],
        tools: {},
      })

      expect(value).toBe("stop")
      expect(routedHealthFailureInputs).toEqual([committedRoute])
      const persisted = yield* readDb.get<{
        state: string
        credential_revision: number | null
        expires_at: number | null
      }>(sql`
        SELECT state, credential_revision, expires_at
        FROM provider_account_route_health
        WHERE provider_id = ${ref.providerID}
          AND account_id = ${committedRoute.accountID}
          AND model_id = ${mdl.id}
      `)
      expect(persisted).toMatchObject({
        state: "cooling-down",
        credential_revision: null,
      })
      expect(persisted?.expires_at).toBeGreaterThanOrEqual(before + 119_000)
    }),
  ),
)

itRoutedHealthFailure.live("session.processor rejects a different Session lease as health authority", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      routedHealthFailureInputs = []

      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service
      const { readDb } = yield* Database.Service
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "mismatched health lease")
      const msg = yield* assistant(chat.id, parent.id, directory)
      const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
      const committedRoute = { routeKind: "account" as const, accountID: "acct-health-mismatch" }
      const foreignLease = accountRouteLease(
        SessionID.make("ses_foreign_health_authority"),
        committedRoute.accountID,
        11,
      )

      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
        routeAttribution: committedRoute,
        routeLease: foreignLease,
      })

      const value = yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: ref.providerID, modelID: ref.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "mismatched health lease" }],
        tools: {},
      })

      expect(value).toBe("stop")
      expect(routedHealthFailureInputs).toEqual([committedRoute])
      expect(
        yield* readDb.get<{ state: string }>(sql`
          SELECT state
          FROM provider_account_route_health
          WHERE provider_id = ${ref.providerID}
            AND account_id = ${committedRoute.accountID}
            AND model_id = ${mdl.id}
        `),
      ).toBeUndefined()
    }),
  ),
)

it.live("session.processor effect tests retry OpenAI-compatible midstream server errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(raw({ chunks: [{ error: { type: "server_error", code: "server_error", message: "xxx" } }] }))
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry midstream server error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry midstream server error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry network_error finish reasons", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-network-error",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
              },
            ],
          }),
        )
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry network error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry network error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after retry")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests log interruptions without an error severity", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service
        const logs: Array<{ logLevel: string; message: unknown }> = []
        const capture = Logger.make((options) => {
          logs.push({ logLevel: options.logLevel, message: options.message })
        })

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt log")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt log" }],
            tools: {},
          })
          .pipe(Effect.provide(Logger.layer([capture])), Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)
        yield* Fiber.await(run)

        const interrupted = logs.filter(
          (entry) => Array.isArray(entry.message) && entry.message[0] === "process interrupted",
        )
        expect(interrupted.length).toBeGreaterThan(0)
        expect(interrupted.every((entry) => entry.logLevel === "Info")).toBe(true)
        expect(
          logs.some(
            (entry) =>
              entry.logLevel === "Error" && Array.isArray(entry.message) && entry.message[0] === "process",
          ),
        ).toBe(false)
        const detail = interrupted[0]?.message
        expect(Array.isArray(detail)).toBe(true)
        if (Array.isArray(detail)) {
          const fields = detail[1] as Record<string, unknown>
          expect(fields["session.id"]).toBe(chat.id)
          expect(fields.messageID).toBe(msg.id)
          expect("stack" in fields).toBe(false)
        }
        expect((yield* sts.get(chat.id)).type).toBe("idle")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests attribute interruption provenance at the request owner", () =>
  provideTmpdirServer(
    ({ dir, llm }) => {
      const logs: Array<{ logLevel: string; message: unknown }> = []
      const capture = Logger.make((options) => {
        logs.push({ logLevel: options.logLevel, message: options.message })
      })
      return Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const ownership = yield* SessionExecutionOwner.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt provenance")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const acquired = yield* ownership.tryAcquire(chat.id)
        expect(acquired.state).toBe("acquired")
        if (acquired.state !== "acquired") return
        yield* ownership.requestInterrupt(chat.id, "operator", acquired.token.generation)

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt provenance" }],
            tools: {},
          })
          .pipe(Effect.provide(Logger.layer([capture])), Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)
        yield* Fiber.await(run)

        const requested = logs.find(
          (entry) => Array.isArray(entry.message) && entry.message[0] === "session interrupt requested",
        )
        expect(requested).toBeDefined()
        if (requested && Array.isArray(requested.message)) {
          const fields = requested.message[1] as Record<string, unknown>
          expect(fields["session.id"]).toBe(chat.id)
          expect(fields.reason).toBe("operator")
          expect(fields.state).toBe("requested")
          expect(fields.interruptGeneration).toBe(1)
        }
        expect(
          logs.some((entry) => Array.isArray(entry.message) && entry.message[0] === "process interrupted"),
        ).toBe(true)
        yield* ownership.release(acquired.token)
      }).pipe(Effect.provide(Logger.layer([capture])))
    },
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests keep genuine failure logs at error severity", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const logs: Array<{ logLevel: string; message: unknown }> = []
        const capture = Logger.make((options) => {
          logs.push({ logLevel: options.logLevel, message: options.message })
        })

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "failure log")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "failure log" }],
            tools: {},
          })
          .pipe(Effect.provide(Logger.layer([capture])))

        expect(value).toBe("stop")
        const failed = logs.filter(
          (entry) =>
            entry.logLevel === "Error" && Array.isArray(entry.message) && entry.message[0] === "process",
        )
        expect(failed.length).toBeGreaterThan(0)
        const detail = failed[0]?.message
        if (Array.isArray(detail)) {
          const fields = detail[1] as Record<string, unknown>
          expect(typeof fields.error).toBe("string")
        }
        expect(
          logs.some((entry) => Array.isArray(entry.message) && entry.message[0] === "process interrupted"),
        ).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itSilentProvider.live("session.processor settles a silent provider and clears busy status", () =>
  provideTmpdirInstance(
    (dir) => Effect.gen(function* () {
      const previous = process.env.OPENFORK_PROVIDER_IDLE_TIMEOUT_MS
      process.env.OPENFORK_PROVIDER_IDLE_TIMEOUT_MS = "90"
      silentProviderCalls = 0
      try {
        const { processors, session, provider } = yield* boot()
        const statuses = yield* SessionStatus.Service
        const events = yield* EventV2Bridge.Service
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "silent provider")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "silent provider" }],
          tools: {},
        })
        yield* off
        expect(result).toBe("stop")
        expect(silentProviderCalls).toBe(1)
        expect(handle.message.error).toBeDefined()
        expect((yield* statuses.get(chat.id)).type).toBe("idle")
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen).toContain(SessionStatus.Event.Idle.type)
      } finally {
        if (previous === undefined) delete process.env.OPENFORK_PROVIDER_IDLE_TIMEOUT_MS
        else process.env.OPENFORK_PROVIDER_IDLE_TIMEOUT_MS = previous
      }
    }),
    { config: cfg },
  ),
  20_000,
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itStaleReasoning.live("session.processor repairs stale encrypted reasoning from owned history once", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      staleReasoningAttempts = 0
      staleReasoningRequests = []

      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "stale reasoning")
      const previous = yield* assistant(chat.id, parent.id, directory)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: previous.id,
        sessionID: chat.id,
        type: "reasoning",
        text: "thinking",
        time: { start: 1 },
        metadata: {
          openai: { itemId: "rs_1", reasoningEncryptedContent: "blob", trace: "keep" },
          providerNote: "keep",
        },
      } as unknown as SessionV1.ReasoningPart)

      const msg = yield* assistant(chat.id, parent.id, directory)
      const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
      const durableHistory = yield* session.messages({ sessionID: chat.id })
      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
        durableHistory,
      })

      const value = yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: ref.providerID, modelID: ref.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "thinking",
                providerOptions: {
                  openai: { itemId: "rs_1", reasoningEncryptedContent: "blob" },
                },
              },
            ],
          },
        ],
        tools: {},
      })

      expect(value).toBe("continue")
      expect(staleReasoningAttempts).toBe(2)
      expect(staleReasoningRequests[0]?.[0]?.content).toEqual([
        {
          type: "reasoning",
          text: "thinking",
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "blob" } },
        },
      ])
      expect(staleReasoningRequests[1]?.[0]?.content).toEqual([{ type: "reasoning", text: "thinking" }])

      const stored = yield* MessageV2.parts(previous.id)
      const storedReasoning = stored.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
      expect(storedReasoning?.text).toBe("thinking")
      expect(storedReasoning?.metadata).toEqual({ openai: { trace: "keep" }, providerNote: "keep" })
    }),
  ),
)

itPromptRendering.live("session.processor retries a rejected Go prompt once with reasoning-free tool-preserving history", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      promptRenderingAttempts = 0
      promptRenderingRequests = []
      promptRenderingAfterEvent = false
      promptRenderingAlwaysFail = false
      promptRenderingAsEvent = false
      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "continue")
      const msg = yield* assistant(chat.id, parent.id, directory)
      const mdl = yield* provider.getModel(promptRenderingRef.providerID, promptRenderingRef.modelID)
      const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
      const previous = [
        { role: "assistant", content: [{ type: "reasoning", text: "prior reasoning" }, { type: "text", text: "Done" },
          { type: "tool-call", toolCallId: "prior-call", toolName: "read", input: { path: "AGENTS.md" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "prior-call", toolName: "read", output: { type: "text", value: "doc" } }] },
        { role: "user", content: "continue" },
      ] satisfies LLM.StreamInput["messages"]
      const value = yield* handle.process({
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: promptRenderingRef.providerID, modelID: promptRenderingRef.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: previous,
        tools: {},
      })
      expect(value).toBe("continue")
      expect(promptRenderingAttempts).toBe(2)
      expect(promptRenderingRequests[0]).toEqual(previous)
      expect(promptRenderingRequests[1]).toEqual([
        { role: "assistant", content: previous[0]!.content.slice(1) },
        previous[1], previous[2],
      ])
      expect(previous[0]!.content[0]).toEqual({ type: "reasoning", text: "prior reasoning" })
    }),
  ),
)

itPromptRendering.live("session.processor does not retry a prompt rejection after a provider event", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      promptRenderingAttempts = 0
      promptRenderingRequests = []
      promptRenderingAfterEvent = true
      promptRenderingAlwaysFail = false
      promptRenderingAsEvent = false
      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "continue")
      const msg = yield* assistant(chat.id, parent.id, directory)
      const mdl = yield* provider.getModel(promptRenderingRef.providerID, promptRenderingRef.modelID)
      const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
      yield* handle.process({
        user: {
          id: parent.id, sessionID: chat.id, role: "user", time: parent.time, agent: parent.agent,
          model: { providerID: promptRenderingRef.providerID, modelID: promptRenderingRef.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id, model: mdl, agent: agent(), system: [],
        messages: [{ role: "assistant", content: [{ type: "reasoning", text: "private" }] }],
        tools: {},
      })
      expect(promptRenderingAttempts).toBe(1)
    }),
  ),
)

itPromptRendering.live("session.processor stops after one compatibility retry when the hosted model rejects again", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      promptRenderingAttempts = 0
      promptRenderingRequests = []
      promptRenderingAfterEvent = false
      promptRenderingAlwaysFail = true
      promptRenderingAsEvent = false
      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "continue")
      const msg = yield* assistant(chat.id, parent.id, directory)
      const mdl = yield* provider.getModel(promptRenderingRef.providerID, promptRenderingRef.modelID)
      const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
      const result = yield* handle.process({
        user: {
          id: parent.id, sessionID: chat.id, role: "user", time: parent.time, agent: parent.agent,
          model: { providerID: promptRenderingRef.providerID, modelID: promptRenderingRef.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id, model: mdl, agent: agent(), system: [],
        messages: [
          { role: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "visible" }] },
          { role: "user", content: "continue" },
        ],
        tools: {},
      })
      expect(result).toBe("stop")
      expect(promptRenderingAttempts).toBe(2)
      expect(promptRenderingRequests[1]).toEqual([
        { role: "assistant", content: [{ type: "text", text: "visible" }] },
        { role: "user", content: "continue" },
      ])
    }),
  ),
)

itPromptRendering.live("session.processor recovers from a lone native provider-error event without replaying tools", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      promptRenderingAttempts = 0
      promptRenderingRequests = []
      promptRenderingAfterEvent = false
      promptRenderingAlwaysFail = false
      promptRenderingAsEvent = true
      const processors = yield* SessionProcessor.Service
      const session = yield* Session.Service
      const provider = yield* Provider.Service
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "continue")
      const msg = yield* assistant(chat.id, parent.id, directory)
      const mdl = yield* provider.getModel(promptRenderingRef.providerID, promptRenderingRef.modelID)
      const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
      const value = yield* handle.process({
        user: {
          id: parent.id, sessionID: chat.id, role: "user", time: parent.time, agent: parent.agent,
          model: { providerID: promptRenderingRef.providerID, modelID: promptRenderingRef.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id, model: mdl, agent: agent(), system: [],
        messages: [
          { role: "assistant", content: [{ type: "reasoning", text: "prior" }, { type: "text", text: "previous" }] },
          { role: "user", content: "continue" },
        ],
        tools: {},
      })
      expect(value).toBe("continue")
      expect(promptRenderingAttempts).toBe(2)
      expect(promptRenderingRequests[1]).toEqual([
        { role: "assistant", content: [{ type: "text", text: "previous" }] },
        { role: "user", content: "continue" },
      ])
    }),
  ),
)

itCoalesce.live("session.processor effect tests coalesce rapid text deltas into fewer part delta events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const currentParts = yield* CurrentParts.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "coalesce")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const deltas: string[] = []
        const livePrefixes: string[] = []
        const liveReasoning: string[] = []
        const offsets: number[] = []
        const off = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartDelta.type) {
            deltas.push((event.data as { delta: string }).delta)
            const payload = event.data as { offset?: number }
            if (payload.offset !== undefined) offsets.push(payload.offset)
            for (const value of currentParts.snapshot(chat.id, [msg.id])) {
              if (value.type === "text") livePrefixes.push(value.text)
              if (value.type === "reasoning") liveReasoning.push(value.text)
            }
            if (releaseCoalesce) return Deferred.succeed(releaseCoalesce, undefined).pipe(Effect.asVoid)
          }
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "coalesce" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(text?.text).toBe("x".repeat(10_000))
        expect(reasoning?.text).toBe("x".repeat(10_000))
        // No content may be lost or reordered by coalescing.
        expect(deltas.join("")).toBe("x".repeat(20_000))
        // 20,000 text/reasoning chunks must remain a bounded set of publishes.
        expect(deltas.length).toBeLessThan(20_000)
        expect(offsets.at(-1)! + deltas.at(-1)!.length).toBe(10_000)
        // An active detail repair can recover already-produced text before the
        // final durable PartUpdated; the borrowed producer state is released
        // after that boundary and cannot leak into a later execution.
        expect(livePrefixes.length).toBeGreaterThan(0)
        expect(livePrefixes.every((text) => text.length > 0)).toBe(true)
        expect(livePrefixes.at(-1)).toBe("x".repeat(10_000))
        expect(liveReasoning.at(-1)).toBe("x".repeat(10_000))
        expect(offsets[0]).toBe(0)
        expect(currentParts.snapshot(chat.id, [msg.id])).toEqual([])
      }),
    { config: cfg },
  ),
)
