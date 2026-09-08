import { appendCompletionRepair } from "@opencode-ai/core/special-agent-completion"
import { type LLMResponse, type Message as CanonicalMessage } from "@opencode-ai/llm"
import type { ModelMessage } from "ai"

const toolResultOutput = (part: Extract<CanonicalMessage["content"][number], { type: "tool-result" }>) => {
  switch (part.result.type) {
    case "text":
      return { type: "text" as const, value: String(part.result.value ?? "") }
    case "error":
      return { type: "error-text" as const, value: String(part.result.value ?? "") }
    case "content":
      return { type: "content" as const, value: part.result.value }
    case "json":
      return { type: "json" as const, value: part.result.value }
  }
}

/**
 * Bridge canonical @opencode-ai/llm messages into the AI SDK message format used
 * by the legacy Session LLM host. Special-agent repair turns depend on this
 * preserving assistant tool calls and matching tool-result settlements exactly.
 */
export const canonicalMessagesToModelMessages = (messages: readonly CanonicalMessage[]): ModelMessage[] => {
  const result: ModelMessage[] = []
  for (const message of messages) {
    if (message.role === "system") {
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      if (text) result.push({ role: "system", content: text })
      continue
    }
    if (message.role === "user") {
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      result.push({ role: "user", content: text })
      continue
    }
    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = []
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text })
        if (part.type === "reasoning") {
          content.push({
            type: "reasoning",
            text: part.text,
            ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
          })
        }
        if (part.type === "tool-call") {
          content.push({
            type: "tool-call",
            toolCallId: part.id,
            toolName: part.name,
            input: part.input,
            ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
          })
        }
      }
      if (content.length) result.push({ role: "assistant", content } as ModelMessage)
      continue
    }
    const content: Array<Record<string, unknown>> = []
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      content.push({
        type: "tool-result",
        toolCallId: part.id,
        toolName: part.name,
        output: toolResultOutput(part),
        ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
      })
    }
    if (content.length) result.push({ role: "tool", content } as ModelMessage)
  }
  return result
}

/**
 * Append the canonical special-agent repair continuation to an existing legacy
 * AI-SDK transcript. This settles every malformed tool call before the host's
 * protocol-correction user turn, keeping retries provider-valid.
 */
export function appendModelCompletionRepair(input: {
  readonly messages: readonly ModelMessage[]
  readonly response: LLMResponse
  readonly toolName: string
  readonly agentLabel?: string
  readonly detail?: string
}): ModelMessage[] {
  const repair = appendCompletionRepair([], input.response, input.toolName, input.agentLabel, input.detail)
  return [...input.messages, ...canonicalMessagesToModelMessages(repair)]
}
