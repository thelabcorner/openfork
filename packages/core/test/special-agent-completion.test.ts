import { describe, expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent, LLMResponse, Message } from "@opencode-ai/llm"
import {
  appendCompletionRepair,
  collectUntilTerminalTool,
  inspectTerminalCompletion,
  retryMaxTokens,
  runAdaptiveToolChoice,
  runTerminalCompletion,
  runTerminalCompletionWithTranscript,
  terminalCompletionAccepted,
  withSpecialAgentTimeout,
  type TerminalAttempt,
} from "@opencode-ai/core/special-agent-completion"
import { resetToolChoiceCapabilityMemory } from "@opencode-ai/core/tool-choice-compatibility"

const identity = {
  providerID: "console-go",
  modelID: "special-agent-model",
  apiURL: "https://example.invalid/v1",
  routeID: "test-route",
}

const textResponse = (text: string) =>
  LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.finish({ reason: "stop" }),
  ])!

const toolResponse = (name: string, input: unknown, id = "call") =>
  LLMResponse.fromEvents([LLMEvent.toolCall({ id, name, input }), LLMEvent.finish({ reason: "tool-calls" })])!

/** A turn the provider cut off at the output limit before the tool call landed. */
const truncatedResponse = () =>
  LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text: "still reasoning" }),
    LLMEvent.finish({ reason: "length" }),
  ])!

const mixedResponse = (input: unknown) =>
  LLMResponse.fromEvents([
    LLMEvent.toolCall({ id: "stray", name: "read", input: { path: "a.ts" } }),
    LLMEvent.toolCall({ id: "terminal", name: "finish", input }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ])!

describe("special-agent completion runtime", () => {
  test("terminal result tells any continuing runtime to end generation", () => {
    const result = terminalCompletionAccepted("finish")
    expect(result).toContain("Completion accepted via finish")
    expect(result).toContain("END GENERATION NOW")
    expect(result).toContain("additional tools")
  })

  test("terminal stream collection actively finalizes upstream at the tool call", async () => {
    let finalized = false
    let trailingPulled = false
    const upstream = Stream.concat(
      Stream.make(
        LLMEvent.textStart({ id: "before" }),
        LLMEvent.textDelta({ id: "before", text: "working" }),
        LLMEvent.textEnd({ id: "before" }),
        LLMEvent.toolCall({ id: "done", name: "finish", input: { value: "done" } }),
      ),
      Stream.fromEffect(
        Effect.sync(() => {
          trailingPulled = true
          return LLMEvent.textDelta({ id: "after", text: "should never be consumed" })
        }),
      ),
    ).pipe(Stream.ensuring(Effect.sync(() => (finalized = true))))

    const response = await Effect.runPromise(collectUntilTerminalTool(upstream, "finish"))
    expect(response?.toolCalls.map((call) => call.name)).toEqual(["finish"])
    expect(response?.finishReason).toBe("tool-calls")
    expect(trailingPulled).toBe(false)
    expect(finalized).toBe(true)
  })

  test("wall-clock timeout interrupts rather than leaving special-agent work running", async () => {
    let interrupted = false
    const never = Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))))
    const result = await Effect.runPromise(
      withSpecialAgentTimeout(never, () => Effect.succeed("timed-out"), "10 millis"),
    )
    expect(result).toBe("timed-out")
    expect(interrupted).toBe(true)
  })

  test("shares required-to-auto capability learning across callers", async () => {
    resetToolChoiceCapabilityMemory()
    const firstChoices: string[] = []
    const first = await Effect.runPromise(
      runAdaptiveToolChoice({
        identity,
        run: (toolChoice) => {
          firstChoices.push(toolChoice)
          return toolChoice === "required"
            ? Effect.fail(
                new Error(
                  '[invalid_request_error] only "auto" is supported for `tool_choice`. "required" is not currently supported',
                ),
              )
            : Effect.succeed("first-success")
        },
      }),
    )
    expect(first.value).toBe("first-success")
    expect(first.toolChoice).toBe("auto")
    expect(firstChoices).toEqual(["required", "auto"])

    const secondChoices: string[] = []
    const second = await Effect.runPromise(
      runAdaptiveToolChoice({
        identity,
        run: (toolChoice) => {
          secondChoices.push(toolChoice)
          return Effect.succeed("second-success")
        },
      }),
    )
    expect(second.toolChoice).toBe("auto")
    expect(secondChoices).toEqual(["auto"])
  })

  test("repairs prose in the same canonical transcript before accepting the completion tool", async () => {
    const responses = [textResponse("Here is the answer in prose."), toolResponse("finish", { value: "done" })]
    const requests: ReadonlyArray<Message>[] = []
    const result = await Effect.runPromise(
      runTerminalCompletion({
        messages: [Message.user("Do the special task")],
        toolName: "finish",
        agentLabel: "test special agent",
        generate: (messages) => {
          requests.push(messages)
          return Effect.succeed(responses.shift()!)
        },
        invalid: (failure) => new Error(JSON.stringify(failure)),
      }),
    )

    expect(result.repairs).toBe(1)
    expect(requests).toHaveLength(2)
    const retry = JSON.stringify(requests[1])
    expect(retry).toContain("Here is the answer in prose.")
    expect(retry).toContain("Protocol correction")
    expect(retry).toContain("finish")
  })

  test("accepts one valid completion tool when the model also emits incidental prose", async () => {
    const response = LLMResponse.fromEvents([
      LLMEvent.textStart({ id: "preamble" }),
      LLMEvent.textDelta({ id: "preamble", text: "Here is the completed artifact." }),
      LLMEvent.textEnd({ id: "preamble" }),
      LLMEvent.toolCall({ id: "call", name: "finish", input: { value: "done" } }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ])!
    let calls = 0
    const result = await Effect.runPromise(
      runTerminalCompletion({
        messages: [Message.user("Do the special task")],
        toolName: "finish",
        generate: () => {
          calls++
          return Effect.succeed(response)
        },
        validate: (call) => {
          const value = (call.input as { value?: unknown }).value
          return typeof value === "string" ? Effect.succeed(value) : Effect.fail("value must be a string")
        },
        invalid: (failure) => new Error(JSON.stringify(failure)),
      }),
    )

    expect(result.artifact).toBe("done")
    expect(result.repairs).toBe(0)
    expect(calls).toBe(1)
  })

  test("repairs an invalid completion payload with a tool error before retrying", async () => {
    const responses = [toolResponse("finish", { nope: true }, "bad"), toolResponse("finish", { value: "done" }, "good")]
    const requests: ReadonlyArray<Message>[] = []
    const result = await Effect.runPromise(
      runTerminalCompletion({
        messages: [Message.user("Do the special task")],
        toolName: "finish",
        generate: (messages) => {
          requests.push(messages)
          return Effect.succeed(responses.shift()!)
        },
        validate: (call) => {
          const value = (call.input as { value?: unknown }).value
          return typeof value === "string" ? Effect.succeed(value) : Effect.fail("value must be a string")
        },
        invalid: (failure) => new Error(JSON.stringify(failure)),
      }),
    )

    expect(result.artifact).toBe("done")
    expect(requests).toHaveLength(2)
    const retry = JSON.stringify(requests[1])
    expect(retry).toContain("Protocol error")
    expect(retry).toContain("host rejected the previous completion")
    expect(retry).toContain("value must be a string")
  })

  test("bounds protocol correction retries and never treats prose as the artifact", async () => {
    const responses = [textResponse("first failure"), textResponse("second failure")]
    let calls = 0
    const exit = await Effect.runPromiseExit(
      runTerminalCompletion({
        messages: [Message.user("Do the special task")],
        toolName: "finish",
        maxRepairs: 1,
        generate: () => {
          calls++
          return Effect.succeed(responses.shift()!)
        },
        invalid: (failure) => new Error(`${failure.reason}:${failure.repairs}`),
      }),
    )
    expect(exit._tag).toBe("Failure")
    expect(calls).toBe(2)
  })

  test("separates an output-limit truncation from a model protocol violation", () => {
    const truncated = inspectTerminalCompletion(truncatedResponse(), "finish")
    expect(truncated.ok).toBe(false)
    if (truncated.ok) return
    expect(truncated.reason).toBe("truncated")
    expect(truncated.terminal).toHaveLength(0)

    const prose = inspectTerminalCompletion(textResponse("no tool call at all"), "finish")
    expect(prose.ok).toBe(false)
    if (prose.ok) return
    expect(prose.reason).toBe("missing")
  })

  test("escalates the retry budget only for truncated attempts", () => {
    expect(retryMaxTokens(1_000, undefined)).toBe(1_000)
    expect(retryMaxTokens(1_000, { repairs: 1, previous: "missing" })).toBe(1_000)
    expect(retryMaxTokens(1_000, { repairs: 0, previous: "truncated" })).toBe(2_000)
    expect(retryMaxTokens(1_000, { repairs: 2, previous: "truncated" })).toBe(4_000)
    expect(retryMaxTokens(1_000, { repairs: 9, previous: "truncated" }, 3_000)).toBe(3_000)
  })

  test("tells the next attempt why the previous one failed so budgets can grow", async () => {
    const responses = [truncatedResponse(), toolResponse("finish", { value: "done" })]
    const attempts: TerminalAttempt[] = []
    const result = await Effect.runPromise(
      runTerminalCompletion({
        messages: [Message.user("Do the special task")],
        toolName: "finish",
        generate: (_messages, attempt) => {
          attempts.push(attempt)
          return Effect.succeed(responses.shift()!)
        },
        invalid: (failure) => new Error(JSON.stringify(failure)),
      }),
    )
    expect(result.repairs).toBe(1)
    expect(attempts).toEqual([{ repairs: 0 }, { repairs: 1, previous: "truncated" }])
  })

  test("reports a persistently truncated completion as truncated rather than missing", async () => {
    const exit = await Effect.runPromiseExit(
      runTerminalCompletion({
        messages: [Message.user("Do the special task")],
        toolName: "finish",
        generate: () => Effect.succeed(truncatedResponse()),
        invalid: (failure) => new Error(`${failure.reason}:${failure.detail ?? ""}`),
      }),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") return
    expect(String(Cause.squash(exit.cause))).toContain("truncated:")
    expect(String(Cause.squash(exit.cause))).toContain("output token limit")
  })

  test("commits a valid artifact from a malformed turn once repairs are exhausted", async () => {
    let calls = 0
    const result = await Effect.runPromise(
      runTerminalCompletion({
        messages: [Message.user("Do the special task")],
        toolName: "finish",
        maxRepairs: 1,
        generate: () => {
          calls++
          return Effect.succeed(mixedResponse({ value: "done" }))
        },
        validate: (call) => {
          const value = (call.input as { value?: unknown }).value
          return typeof value === "string" ? Effect.succeed(value) : Effect.fail("value must be a string")
        },
        invalid: (failure) => new Error(JSON.stringify(failure)),
      }),
    )
    // The clean-turn correction is still attempted first; the artifact is only
    // salvaged after that retry also came back malformed.
    expect(calls).toBe(2)
    expect(result.artifact).toBe("done")
  })

  test("never salvages an invalid artifact out of a malformed turn", async () => {
    const exit = await Effect.runPromiseExit(
      runTerminalCompletion({
        messages: [Message.user("Do the special task")],
        toolName: "finish",
        maxRepairs: 1,
        generate: () => Effect.succeed(mixedResponse({ value: 42 })),
        validate: (call) => {
          const value = (call.input as { value?: unknown }).value
          return typeof value === "string" ? Effect.succeed(value) : Effect.fail("value must be a string")
        },
        invalid: (failure) => new Error(failure.reason),
      }),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") return
    expect(String(Cause.squash(exit.cause))).toContain("extra-tools")
  })

  test("settles unresolved wrong-tool calls before appending the correction", () => {
    const messages = appendCompletionRepair(
      [Message.user("Do the special task")],
      toolResponse("wrong_tool", { value: 1 }),
      "finish",
      "test special agent",
    )
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain("wrong_tool")
    expect(serialized).toContain("Protocol error")
    expect(serialized).toContain("Protocol correction")
  })

  test("uses the same terminal state machine with a host-specific transcript adapter", async () => {
    const responses = [textResponse("legacy prose"), toolResponse("finish", { value: "done" })]
    const requests: ReadonlyArray<string>[] = []
    const result = await Effect.runPromise(
      runTerminalCompletionWithTranscript<string, string, Error>({
        messages: ["user: do the task"],
        toolName: "finish",
        generate: (messages) => {
          requests.push(messages)
          return Effect.succeed(responses.shift()!)
        },
        appendRepair: (messages, response, detail) => [
          ...messages,
          `assistant:${response.text}`,
          `user:Protocol correction${detail ? `:${detail}` : ""}`,
        ],
        validate: (call) => {
          const value = (call.input as { value?: unknown }).value
          return typeof value === "string" ? Effect.succeed(value) : Effect.fail("value must be a string")
        },
        invalid: (failure) => new Error(`${failure.reason}:${failure.repairs}`),
      }),
    )

    expect(result.artifact).toBe("done")
    expect(result.repairs).toBe(1)
    expect(requests).toEqual([
      ["user: do the task"],
      ["user: do the task", "assistant:legacy prose", "user:Protocol correction"],
    ])
  })
})
