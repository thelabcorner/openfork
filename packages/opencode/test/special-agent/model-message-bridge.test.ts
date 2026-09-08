import { describe, expect, test } from "bun:test"
import { LLMEvent, LLMResponse } from "@opencode-ai/llm"
import { appendModelCompletionRepair } from "@/special-agent/model-message-bridge"

const toolResponse = (name: string, input: unknown) =>
  LLMResponse.fromEvents([
    LLMEvent.toolCall({ id: "bad-call", name, input }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ])!

describe("special-agent model-message bridge", () => {
  test("settles malformed canonical tool calls before the legacy AI-SDK repair turn", () => {
    const messages = appendModelCompletionRepair({
      messages: [{ role: "user", content: "Generate the artifact" }],
      response: toolResponse("generated_title", { nope: true }),
      toolName: "generated_title",
      agentLabel: "session title generator",
      detail: "title must be a string",
    })

    expect(messages).toHaveLength(4)
    expect(messages[0]?.role).toBe("user")
    const assistantCall = (messages[1] as any).content[0]
    expect(assistantCall.type).toBe("tool-call")
    expect(assistantCall.toolCallId).toBe("bad-call")
    expect(assistantCall.toolName).toBe("generated_title")
    const toolResult = (messages[2] as any).content[0]
    expect(messages[2]?.role).toBe("tool")
    expect(toolResult.type).toBe("tool-result")
    expect(toolResult.toolCallId).toBe("bad-call")
    expect(toolResult.toolName).toBe("generated_title")
    expect(String(toolResult?.output?.value)).toContain("Protocol error")
    const correction = (messages[3] as { content: string }).content
    expect(correction).toContain("Protocol correction")
    expect(correction).toContain("title must be a string")
  })
})
