import { afterAll, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { AppRuntime } from "@/effect/app-runtime"
import { BackgroundJob } from "@/background/job"
import { InstanceStore } from "@/project/instance-store"
import { DelegatedWorker } from "@/session/delegated-worker"
import { Session } from "@/session/session"
import { tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

/**
 * Real AppRuntime/InstanceStore integration for the delegated-worker start
 * path. Unlike the prompt-level admission tests, this exercises the production
 * DelegatedWorker service graph (validateSelection -> Session.create ->
 * hostPrompt admission -> BackgroundJob drain) against the test LLM server.
 */
const llmRuntime = ManagedRuntime.make(TestLLMServer.layer)

afterAll(async () => {
  await llmRuntime.dispose()
})

const MODEL = { providerID: "test", modelID: "test-model" } as const
const ALT_MODEL = { providerID: "test", modelID: "test-model-alt" } as const

const ORIGIN = {
  producer: "oxp",
  principalRef: "oxp:connector-delegated-worker-test",
  invocationRef: "oxp-inv:delegated-worker-test",
  rootRef: "root-delegated-worker-test",
  agent: "build",
  model: MODEL,
  nestedDelegation: false,
} as const

const IDENTITY = { producer: ORIGIN.producer, principalRef: ORIGIN.principalRef } as const

const isTitleRequest = (hit: { body: Record<string, unknown> }) => {
  const tools = hit.body.tools
  return Array.isArray(tools) && JSON.stringify(tools).includes("generated_title")
}

const workerReply = (text: string) => reply().text(text).stop().item()

function providerConfig(llmUrl: string) {
  const config = testProviderConfig(llmUrl)
  return {
    ...config,
    provider: {
      ...config.provider,
      test: {
        ...config.provider.test,
        models: {
          ...config.provider.test.models,
          "test-model-alt": {
            ...config.provider.test.models["test-model"],
            id: "test-model-alt",
            name: "Test Model Alt",
            variants: { high: {} },
          },
        },
      },
    },
  }
}

function runInInstance<A, E, R>(llm: TestLLMServer["Service"], fn: () => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const tmp = yield* Effect.promise(() => tmpdir({ config: providerConfig(llm.url) }))
    return yield* Effect.ensuring(
      InstanceStore.Service.use((instances) => instances.provide({ directory: tmp.path }, fn())),
      Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
  })
}

describe("DelegatedWorker start path", () => {
  test("admits the host delegation turn, reaches generation 1, and returns the completion result", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    await llmRuntime.runPromise(llm.pushMatch((hit) => !isTitleRequest(hit), workerReply("delegated worker result")))

    const outcome = await AppRuntime.runPromise(
      runInInstance(llm, () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const execution = yield* SessionExecutionOwner.Service
          const worker = yield* DelegatedWorker.make

          const session = yield* worker.start({
            title: "Delegated worker integration",
            prompt: "do the delegated work",
            agent: ORIGIN.agent,
            model: MODEL,
            origin: ORIGIN,
          })

          const messages = yield* sessions.messages({ sessionID: session.id })
          const admitted = messages.find((message) => message.info.role === "user")
          expect(admitted?.info.role).toBe("user")
          if (!admitted || admitted.info.role !== "user") throw new Error("expected an admitted delegated host turn")
          expect(admitted.info.provenance).toEqual({
            owner: "host",
            source: SessionTurnProvenance.Source.OxpDelegation,
            ref: ORIGIN.invocationRef,
          })

          const completed = yield* worker.wait({
            sessionID: session.id,
            identity: IDENTITY,
            timeout: 20_000,
          })
          expect(completed.state).toBe("completed")
          expect(completed.result).toContain("delegated worker result")

          const ownership = yield* execution.snapshot(session.id)
          expect(ownership.generation).toBe(1)

          return completed
        }),
      ),
    )

    expect(outcome.state).toBe("completed")
    expect(outcome.generation).toBe(1)
    expect(outcome.result).toContain("delegated worker result")
  }, 60_000)

  test("continues a completed worker into generation 2 and returns the second result", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    await llmRuntime.runPromise(llm.pushMatch((hit) => !isTitleRequest(hit), workerReply("generation one result")))
    await llmRuntime.runPromise(llm.pushMatch((hit) => !isTitleRequest(hit), workerReply("generation two result")))

    const outcome = await AppRuntime.runPromise(
      runInInstance(llm, () =>
        Effect.gen(function* () {
          const execution = yield* SessionExecutionOwner.Service
          const worker = yield* DelegatedWorker.make

          const session = yield* worker.start({
            title: "Delegated worker continuation",
            prompt: "run generation one",
            agent: ORIGIN.agent,
            model: MODEL,
            origin: { ...ORIGIN, invocationRef: "oxp-inv:delegated-worker-continue-start" },
          })

          const first = yield* worker.wait({
            sessionID: session.id,
            identity: IDENTITY,
            timeout: 20_000,
          })
          expect(first.state).toBe("completed")
          expect(first.result).toContain("generation one result")
          expect((yield* execution.snapshot(session.id)).generation).toBe(1)

          yield* worker.continue({
            sessionID: session.id,
            prompt: "run generation two",
            identity: IDENTITY,
            invocationRef: "oxp-inv:delegated-worker-continue-second",
            nestedDelegation: false,
            expectedAgent: ORIGIN.agent,
            expectedModel: MODEL,
          })

          const second = yield* worker.wait({
            sessionID: session.id,
            identity: IDENTITY,
            timeout: 20_000,
          })
          expect(second.state).toBe("completed")
          expect(second.result).toContain("generation two result")
          expect((yield* execution.snapshot(session.id)).generation).toBe(2)
          return second
        }),
      ),
    )

    expect(outcome.generation).toBe(2)
    expect(outcome.result).toContain("generation two result")
  }, 60_000)

  test("rebinds provider/model/account/variant for the next generation and persists the canonical selection", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    await llmRuntime.runPromise(llm.pushMatch((hit) => !isTitleRequest(hit), workerReply("before rebind")))
    await llmRuntime.runPromise(llm.pushMatch((hit) => !isTitleRequest(hit), workerReply("after rebind")))

    const rebound = { ...ALT_MODEL, variant: "high" } as const
    const outcome = await AppRuntime.runPromise(
      runInInstance(llm, () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const worker = yield* DelegatedWorker.make
          const session = yield* worker.start({
            title: "Delegated worker selection rebind",
            prompt: "run before rebind",
            agent: ORIGIN.agent,
            model: MODEL,
            origin: { ...ORIGIN, invocationRef: "oxp-inv:delegated-worker-rebind-start" },
          })
          yield* worker.wait({ sessionID: session.id, identity: IDENTITY, timeout: 20_000 })

          const changed = yield* worker.setSelection({
            sessionID: session.id,
            identity: IDENTITY,
            model: rebound,
            expectedModel: MODEL,
          })
          expect(changed.changed).toBe(true)
          expect(changed.previousModel).toEqual(MODEL)
          expect(changed.model).toEqual(rebound)

          const persisted = yield* sessions.get(session.id)
          expect(persisted.model).toEqual({
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("test-model-alt"),
            variant: "high",
          })
          expect(
            SessionMetadataOwnership.workerDelegation(persisted.metadata)?.model,
          ).toEqual(rebound)

          const stale = yield* Effect.exit(
            worker.setSelection({
              sessionID: session.id,
              identity: IDENTITY,
              model: MODEL,
              expectedModel: MODEL,
            }),
          )
          expect(stale._tag).toBe("Failure")
          expect(
            SessionMetadataOwnership.workerDelegation(
              (yield* sessions.get(session.id)).metadata,
            )?.model,
          ).toEqual(rebound)

          yield* worker.continue({
            sessionID: session.id,
            prompt: "run after rebind",
            identity: IDENTITY,
            invocationRef: "oxp-inv:delegated-worker-rebind-second",
            nestedDelegation: false,
            expectedAgent: ORIGIN.agent,
            expectedModel: rebound,
          })
          const completed = yield* worker.wait({
            sessionID: session.id,
            identity: IDENTITY,
            timeout: 20_000,
          })
          const messages = yield* sessions.messages({ sessionID: session.id })
          const nextTurn = messages.findLast(
            (message) => message.info.role === "user",
          )
          expect(nextTurn?.info.role).toBe("user")
          if (!nextTurn || nextTurn.info.role !== "user") {
            throw new Error("expected rebound delegated worker turn")
          }
          expect(nextTurn.info.model).toMatchObject({
            providerID: ProviderV2.ID.make("test"),
            modelID: ModelV2.ID.make("test-model-alt"),
            variant: "high",
          })
          return completed
        }),
      ),
    )

    expect(outcome.generation).toBe(2)
    expect(outcome.result).toContain("after rebind")
  }, 60_000)

  test("changes selection while running without rewriting the in-flight turn", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    await llmRuntime.runPromise(
      llm.pushMatch((hit) => !isTitleRequest(hit), reply().text("still running").hang().item()),
    )

    await AppRuntime.runPromise(
      runInInstance(llm, () =>
        Effect.gen(function* () {
          const execution = yield* SessionExecutionOwner.Service
          const background = yield* BackgroundJob.Service
          const sessions = yield* Session.Service
          const worker = yield* DelegatedWorker.make
          const session = yield* worker.start({
            title: "Delegated worker running selection rebind",
            prompt: "keep running",
            agent: ORIGIN.agent,
            model: MODEL,
            origin: { ...ORIGIN, invocationRef: "oxp-inv:delegated-worker-rebind-running" },
          })

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const ownership = yield* execution.snapshot(session.id)
              const live = yield* background.get(session.id)
              return ownership.ownerID !== undefined && live?.status === "running" ? (true as const) : undefined
            }),
            "delegated worker never reached a live running generation",
            "15 seconds",
          )

          const changed = yield* worker.setSelection({
            sessionID: session.id,
            identity: IDENTITY,
            model: ALT_MODEL,
            expectedModel: MODEL,
          })
          expect(changed.changed).toBe(true)
          expect(changed.snapshot.state).toBe("running")
          expect(changed.model).toEqual(ALT_MODEL)

          const persisted = yield* sessions.get(session.id)
          expect(persisted.model).toEqual({
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("test-model-alt"),
            variant: "default",
          })
          expect(
            SessionMetadataOwnership.workerDelegation(persisted.metadata)?.model,
          ).toEqual(ALT_MODEL)

          const messages = yield* sessions.messages({ sessionID: session.id })
          const inFlight = messages.find(
            (message) => message.info.role === "user",
          )
          expect(inFlight?.info.role).toBe("user")
          if (!inFlight || inFlight.info.role !== "user") {
            throw new Error("expected in-flight delegated worker turn")
          }
          expect(inFlight.info.model).toMatchObject({
            providerID: MODEL.providerID,
            modelID: MODEL.modelID,
          })

          yield* worker.cancel({ sessionID: session.id, identity: IDENTITY })
        }),
      ),
    )
  }, 60_000)

  test("cancel keeps wait/result from resurrecting a completed worker state", async () => {
    const llm = await llmRuntime.runPromise(TestLLMServer)
    await llmRuntime.runPromise(
      llm.pushMatch((hit) => !isTitleRequest(hit), reply().text("partial worker output").hang().item()),
    )

    const states = await AppRuntime.runPromise(
      runInInstance(llm, () =>
        Effect.gen(function* () {
          const execution = yield* SessionExecutionOwner.Service
          const background = yield* BackgroundJob.Service
          const worker = yield* DelegatedWorker.make

          const session = yield* worker.start({
            title: "Delegated worker cancel",
            prompt: "start and keep going",
            agent: ORIGIN.agent,
            model: MODEL,
            origin: { ...ORIGIN, invocationRef: "oxp-inv:delegated-worker-cancel" },
          })

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const ownership = yield* execution.snapshot(session.id)
              const live = yield* background.get(session.id)
              return ownership.ownerID !== undefined && live?.status === "running" ? (true as const) : undefined
            }),
            "delegated worker never reached a live running generation",
            "15 seconds",
          )

          const cancelled = yield* worker.cancel({ sessionID: session.id, identity: IDENTITY })
          const waited = yield* worker.wait({ sessionID: session.id, identity: IDENTITY, timeout: 5_000 })
          const resulted = yield* worker.result({ sessionID: session.id, identity: IDENTITY })

          return { cancelled, waited, resulted }
        }),
      ),
    )

    // Live behavior: cancel() reports "cancelled", but wait()/result() re-derive
    // "recoverable" from the durable transcript once the execution owner has
    // been released and the admitted host turn is still undrained. This test
    // pins the safety invariant that neither read path may resurrect a completed
    // result or claim the cancelled generation is still running, and that the
    // wait/result read paths agree with each other.
    expect(states.cancelled.state).toBe("cancelled")
    expect(states.waited.state).toBe(states.resulted.state)
    for (const state of [states.waited, states.resulted]) {
      expect(state.state).not.toBe("running")
      expect(state.state).not.toBe("completed")
      expect(state.result).toBeUndefined()
    }
  }, 60_000)
})
