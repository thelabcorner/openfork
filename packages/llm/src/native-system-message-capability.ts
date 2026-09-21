import type { Model } from "./schema/options"
import { anthropicSystemMessageCapability } from "./protocols/anthropic-capability"
import {
  HEAD_ONLY_SYSTEM_CAPABILITY,
  intersectSystemMessageCapability,
  type EffectiveSystemMessageCapability,
} from "./system-message-capability"

const NATIVE_ANTHROPIC_ENCODER = { chronological: true, turnScoped: false } as const

/**
 * Authority-preserving chronological-System capability of the exact native
 * `@opencode-ai/llm` model route.
 *
 * This intentionally keys from the selected protocol, not a Claude-looking model
 * id alone. A proxy/OpenAI-compatible route therefore cannot acquire Anthropic
 * semantics by naming its foundation model `claude-*`. Unknown native protocols
 * fail closed to a complete privileged-head projection.
 */
export const nativeSystemMessageCapability = (model: Model): EffectiveSystemMessageCapability => {
  if (String(model.route.protocol) !== "anthropic-messages") return HEAD_ONLY_SYSTEM_CAPABILITY
  return intersectSystemMessageCapability(anthropicSystemMessageCapability(String(model.id)), NATIVE_ANTHROPIC_ENCODER)
}

