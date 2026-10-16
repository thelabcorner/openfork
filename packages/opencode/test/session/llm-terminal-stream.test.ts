import { describe, expect, test } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Exit, Stream } from "effect"
import { requireTerminalFinish } from "@/session/llm/terminal-stream"
import { abortableProviderIterable } from "@/session/llm/abortable-provider-iterable"
import { LLMAISDK } from "@/session/llm/ai-sdk"

const start = LLMEvent.stepStart({ index: 0 })
const text = LLMEvent.textDelta({ id: "txt-0", text: "partial" })
const finish = LLMEvent.finish({ reason: "stop" })
const abort = () => new AbortController()

describe("V1 provider stream terminal fence", () => {
  test("preserves successful terminal streams in order", async () => {
    const source = Stream.make(start, text, finish)
    const events = await Effect.runPromise(Stream.runCollect(requireTerminalFinish(source, abort().signal)))
    expect(Array.from(events)).toEqual([start, text, finish])
  })

  test("rejects natural EOF even after text or reasoning progress", async () => {
    const source = Stream.make(start, text)
    const result = await Effect.runPromise(
      Stream.runCollect(requireTerminalFinish(source, abort().signal)).pipe(Effect.flip),
    )
    expect(result.message).toContain("without a terminal finish event")
  })

  test("step-finish is not an overall terminal finish", async () => {
    const stepFinish = LLMEvent.stepFinish({ index: 0, reason: "tool-calls" })
    const truncated = Stream.make(start, stepFinish)
    const error = await Effect.runPromise(
      Stream.runCollect(requireTerminalFinish(truncated, abort().signal)).pipe(Effect.flip),
    )
    expect(error.message).toContain("without a terminal finish event")

    const complete = Stream.make(start, stepFinish, LLMEvent.stepStart({ index: 1 }), finish)
    const result = await Effect.runPromise(Stream.runCollect(requireTerminalFinish(complete, abort().signal)))
    expect(Array.from(result)).toEqual([start, stepFinish, LLMEvent.stepStart({ index: 1 }), finish])
  })

  test("rejects a zero-event premature EOF", async () => {
    const error = await Effect.runPromise(
      Stream.runCollect(requireTerminalFinish(Stream.empty, abort().signal)).pipe(Effect.flip),
    )
    expect(error.message).toContain("without a terminal finish event")
  })

  test("preserves explicit provider-error terminal events without masking their cause", async () => {
    const providerError = LLMEvent.providerError({ message: "provider rejected the request" })
    const result = await Effect.runPromise(
      Stream.runCollect(requireTerminalFinish(Stream.make(start, providerError), abort().signal)),
    )
    expect(Array.from(result)).toEqual([start, providerError])
  })

  test("intentional consumer cancellation is not a truncated provider response", async () => {
    const source = Stream.make(start, text)
    const result = await Effect.runPromise(
      requireTerminalFinish(source, abort().signal).pipe(Stream.take(1), Stream.runCollect),
    )
    expect(Array.from(result)).toEqual([start])
  })

  test("an explicitly aborted attempt may close without a finish event", async () => {
    const ctrl = abort()
    ctrl.abort()
    const result = await Effect.runPromise(
      Stream.runCollect(requireTerminalFinish(Stream.make(start), ctrl.signal)),
    )
    expect(Array.from(result)).toEqual([start])
  })

  test("does not disguise an actual upstream error as missing finish", async () => {
    const upstream = new Error("upstream stream broke")
    const source = Stream.make(start).pipe(Stream.concat(Stream.fail(upstream)))
    const error = await Effect.runPromise(
      Stream.runCollect(requireTerminalFinish(source, abort().signal)).pipe(Effect.flip),
    )
    expect(error).toBe(upstream)
  })

  test("1/3/6 concurrent attempts have no shared terminal or cancellation state", async () => {
    for (const concurrency of [1, 3, 6]) {
      const results = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
        const ctrl = abort()
        const interrupted = index % 3 === 1
        const source = interrupted ? Stream.make(start, text) : Stream.make(start, text, finish)
        return Effect.runPromise(Effect.exit(Stream.runCollect(requireTerminalFinish(source, ctrl.signal))))
      }))
      for (const [index, result] of results.entries()) {
        expect(Exit.isFailure(result)).toBe(index % 3 === 1)
      }
    }
  })

  test("a naturally exhausted AI SDK iterator cannot turn premature EOF into cancellation", async () => {
    const ctrl = abort()
    let returns = 0
    const source: AsyncIterable<LLMEvent> = {
      [Symbol.asyncIterator]() {
        let count = 0
        return {
          next: async () => ++count === 1
            ? { done: false as const, value: start }
            : { done: true as const, value: undefined },
          return: async () => {
            returns++
            return { done: true as const, value: undefined }
          },
        }
      },
    }
    const stream = Stream.fromAsyncIterable(
      abortableProviderIterable(source, ctrl),
      (e) => e instanceof Error ? e : new Error(String(e)),
    )
    const failure = await Effect.runPromise(Effect.exit(Stream.runCollect(requireTerminalFinish(stream, ctrl.signal))))
    expect(Exit.isFailure(failure)).toBe(true)
    expect(ctrl.signal.aborted).toBe(false)
    expect(returns).toBe(0)
  })

  test("terminal completion through AI SDK iterator does not abort early", async () => {
    const ctrl = abort()
    async function* source() {
      yield start
      yield finish
    }
    const stream = Stream.fromAsyncIterable(
      abortableProviderIterable(source(), ctrl),
      (e) => e instanceof Error ? e : new Error(String(e)),
    )
    const events = await Effect.runPromise(Stream.runCollect(requireTerminalFinish(stream, ctrl.signal)))
    expect(Array.from(events)).toEqual([start, finish])
    expect(ctrl.signal.aborted).toBe(false)
  })

  test("1/3/6 concurrent AI SDK iterators isolate EOF, success, and user cancellation", async () => {
    for (const concurrency of [1, 3, 6]) {
      const results = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
        const ctrl = abort()
        const mode = index % 3
        async function* provider() {
          yield start
          if (mode === 0) yield finish
        }
        const source = Stream.fromAsyncIterable(
          abortableProviderIterable(provider(), ctrl),
          (e) => e instanceof Error ? e : new Error(String(e)),
        )
        const stream = requireTerminalFinish(source, ctrl.signal)
        const outcome = await Effect.runPromise(Effect.exit(Stream.runCollect(
          mode === 2 ? stream.pipe(Stream.take(1)) : stream,
        )))
        return { outcome, aborted: ctrl.signal.aborted }
      }))
      for (const [index, result] of results.entries()) {
        expect(Exit.isFailure(result.outcome)).toBe(index % 3 === 1)
        expect(result.aborted).toBe(index % 3 === 2)
      }
    }
  })

  test("Chat-only finish reason fence rejects synthetic SDK completion before emitting a finish", async () => {
    const chunk = {
      type: "finish-step",
      finishReason: "unknown",
      rawFinishReason: "unknown",
      response: { id: "response-test", timestamp: new Date(0), modelId: "compatible-model" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never
    const strictState = LLMAISDK.adapterState({ requireChatFinishReason: true })
    const failure = await Effect.runPromise(Effect.exit(LLMAISDK.toLLMEvents(strictState, chunk)))
    expect(Exit.isFailure(failure)).toBe(true)
    expect(strictState.step).toBe(0)

    const otherProviderState = LLMAISDK.adapterState()
    const ordinary = await Effect.runPromise(LLMAISDK.toLLMEvents(otherProviderState, chunk))
    expect(ordinary).toMatchObject([{ type: "step-finish", reason: "unknown" }])
    expect(otherProviderState.step).toBe(1)
  })

  test("Chat finish event without any completed model step is not accepted", async () => {
    const finishOnly = {
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never
    const state = LLMAISDK.adapterState({ requireChatFinishReason: true })
    const failure = await Effect.runPromise(Effect.exit(LLMAISDK.toLLMEvents(state, finishOnly)))
    expect(Exit.isFailure(failure)).toBe(true)
    expect(state.step).toBe(0)

    const otherState = LLMAISDK.adapterState()
    const accepted = await Effect.runPromise(LLMAISDK.toLLMEvents(otherState, finishOnly))
    expect(accepted).toMatchObject([{ type: "finish", reason: "stop" }])
  })

  test("Chat completion with recognized stop reason remains valid", async () => {
    const chunk = {
      type: "finish-step",
      finishReason: "stop",
      rawFinishReason: "stop",
      response: { id: "response-test", timestamp: new Date(0), modelId: "compatible-model" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never
    const state = LLMAISDK.adapterState({ requireChatFinishReason: true })
    const events = await Effect.runPromise(LLMAISDK.toLLMEvents(state, chunk))
    expect(events).toMatchObject([{ type: "step-finish", reason: "stop" }])
    expect(state.step).toBe(1)
  })

  test("terminal tracking is subscription-local", async () => {
    const source = requireTerminalFinish(Stream.make(start, finish), abort().signal)
    for (let i = 0; i < 2; i++) {
      const events = await Effect.runPromise(Stream.runCollect(source))
      expect(Array.from(events)).toEqual([start, finish])
    }
  })
})
