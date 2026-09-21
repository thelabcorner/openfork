import {
  anthropicSystemMessageCapability,
  intersectSystemMessageCapability,
  type EffectiveSystemMessageCapability,
  type ProviderSystemMessageCapability,
  type SystemMessageEncoderCapability,
} from "@opencode-ai/llm"
import type { Provider } from "@/provider/provider"

export type Runtime = "ai-sdk" | "native" | "claude-agent-sdk"

const NONE: ProviderSystemMessageCapability = { history: "none", turnScoped: false }
const NO_ENCODER: SystemMessageEncoderCapability = { chronological: false, turnScoped: false }

const documentedAnthropicPlatform = (model: Provider.Model) =>
  model.api.npm === "@ai-sdk/anthropic" ||
  model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
  model.api.npm === "@ai-sdk/amazon-bedrock"

/**
 * Provider/model semantics of explicitly documented API platforms only. Current
 * Anthropic documentation covers the Claude API, Amazon Bedrock and Google
 * Cloud. Other proxies/compatibility routes do not inherit those semantics merely
 * because the underlying model id looks like Claude.
 */
export const providerSystemMessageCapability = (model: Provider.Model): ProviderSystemMessageCapability =>
  documentedAnthropicPlatform(model) ? anthropicSystemMessageCapability(model.api.id) : NONE

/**
 * Encoder capability of the concrete execution path. Keep this deliberately
 * narrower than provider support: an API feature is unusable until the selected
 * adapter is proven to encode it faithfully.
 */
export const systemMessageEncoderCapability = (
  model: Provider.Model,
  runtime: Runtime,
): SystemMessageEncoderCapability => {
  if (runtime === "native" && model.api.npm === "@ai-sdk/anthropic")
    return { chronological: true, turnScoped: false }

  // The installed AI SDK stack is deliberately fail-closed for current
  // mid-conversation System semantics:
  // - @ai-sdk/anthropic@3.0.111 still injects the retired
  //   mid-conversation-system-2026-04-07 beta and does not model current
  //   per-model support;
  // - @ai-sdk/google-vertex/anthropic reuses that converter;
  // - @ai-sdk/amazon-bedrock currently rejects separated System messages.
  // A serializer being able to construct a role does not make the execution path
  // production-safe for the current provider contract.
  if (runtime === "ai-sdk") return NO_ENCODER

  return NO_ENCODER
}

/** Exact provider/model semantics intersected with the selected runtime encoder. */
export const effectiveSystemMessageCapability = (
  model: Provider.Model,
  runtime: Runtime,
): EffectiveSystemMessageCapability =>
  intersectSystemMessageCapability(
    providerSystemMessageCapability(model),
    systemMessageEncoderCapability(model, runtime),
  )

export * as SessionLLMSystemCapability from "./system-capability"
