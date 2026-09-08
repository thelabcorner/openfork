import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent, LLMResponse, Message } from "@opencode-ai/llm"
import {
  appendCompletionRepair,
  runAdaptiveToolChoice,
  runTerminalCompletion,
  runTerminalCompletionWithTranscript,
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
  LLMResponse.fromEvents([
    LLMEvent.toolCall({ id, name, input }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ])!

describe("special-agent completion runtime", () => {
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
