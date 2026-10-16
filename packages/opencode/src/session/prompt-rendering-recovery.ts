import type { ModelMessage } from "ai"

/**
 * A hosted model's prompt compiler may reject provider-private reasoning replay
 * after a model switch or a change of upstream backend. This is only a
 * request-local, opt-in-on-rejection projection: durable history is immutable.
 *
 * Do not flatten tool calls/results into prose. Doing so changes instruction
 * authority, erases tool causality, and can make a recovered request unsafe.
 */
type ModelRoute = { providerID: string; api: { npm: string } }

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function codedResponse(value: unknown): boolean {
  let body = value
  if (typeof body === "string") {
    try {
      body = JSON.parse(body)
    } catch {
      return false
    }
  }
  const record = object(body)
  return record?.code === "prompt_rendering_failed" ||
    object(record?.error)?.code === "prompt_rendering_failed"
}

/** Only read provider error fields; echoed user/request content is never evidence. */
export function isPromptRenderingRejection(error: unknown): boolean {
  const entry = object(error)
  if (!entry) return false
  const data = object(entry.data)
  const message = data?.message ?? entry.message
  if (typeof message === "string" && /\[prompt_rendering_failed\]/i.test(message)) return true
  return codedResponse(data?.responseBody ?? entry.responseBody)
}

export type Recovery = {
  readonly messages: ModelMessage[]
  readonly removedReasoningParts: number
  readonly removedReasoningOnlyMessages: number
}

/**
 * Once the provider has explicitly rejected the original request, project a
 * portable chat history WITHOUT stored reasoning. Keep all tool-call identities,
 * arguments, and tool results exactly as sent in the initial attempt.
 *
 * A retry is not permitted unless this actually changes the outgoing history,
 * and the caller has proved zero prior provider events or tool side effects.
 */
export function stripRejectedReasoning(messages: readonly ModelMessage[], model: ModelRoute): Recovery | undefined {
  if (!["opencode", "opencode-go"].includes(model.providerID)) return
  if (model.api.npm !== "@ai-sdk/openai-compatible") return

  let removedReasoningParts = 0
  let removedReasoningOnlyMessages = 0
  const clean: ModelMessage[] = []
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      clean.push(message)
      continue
    }
    const content = message.content.filter((part) => {
      if (part.type !== "reasoning") return true
      removedReasoningParts++
      return false
    })
    if (content.length === message.content.length) {
      clean.push(message)
      continue
    }
    if (content.length === 0) {
      removedReasoningOnlyMessages++
      continue
    }
    clean.push({ ...message, content })
  }
  if (removedReasoningParts === 0) return
  return { messages: clean, removedReasoningParts, removedReasoningOnlyMessages }
}

export * as SessionPromptRenderingRecovery from "./prompt-rendering-recovery"
