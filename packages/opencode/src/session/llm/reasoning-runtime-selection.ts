/**
 * The installed @ai-sdk/openai-compatible 2.0.41 recognizes reasoning_content
 * and reasoning, but silently discards reasoning_text. Our native OpenAI Chat
 * protocol handles all three. Route only models declaring the unsupported
 * spelling through native preflight; never guess from names, token counts or
 * content. The caller retains the ordinary AI SDK fallback if preflight cannot
 * execute this provider/account.
 */
export function needsNativeReasoningTransport(model: {
  readonly providerID: string
  readonly api: { readonly npm: string }
  readonly capabilities: { readonly interleaved: boolean | { readonly field: string } }
}): boolean {
  return (
    model.providerID.startsWith("opencode") &&
    model.api.npm === "@ai-sdk/openai-compatible" &&
    typeof model.capabilities.interleaved === "object" &&
    model.capabilities.interleaved !== null &&
    model.capabilities.interleaved.field === "reasoning_text"
  )
}
