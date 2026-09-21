import type { ProviderSystemMessageCapability } from "../system-message-capability"

const NONE: ProviderSystemMessageCapability = { history: "none", turnScoped: false }
const CUMULATIVE: ProviderSystemMessageCapability = { history: "cumulative-privileged", turnScoped: true }

const canonicalClaudeID = (input: string) => {
  const value = input.toLowerCase().replaceAll(".", "-")
  const start = value.indexOf("claude-")
  if (start < 0) return value
  return value
    .slice(start)
    .replace(/@[^/]+$/, "")
    .replace(/-v\d+:\d+$/, "")
}

const supported = [
  /^claude-opus-4-8(?:-\d{8})?$/,
  /^claude-opus-5(?:-\d{8})?$/,
  /^claude-fable-5(?:-\d{8})?$/,
  /^claude-fable-5-1(?:-\d{8})?$/,
  /^claude-mythos-5(?:-\d{8})?$/,
  /^claude-mythos-5-1(?:-\d{8})?$/,
]

/**
 * Current Claude provider semantics for mid-conversation System messages.
 *
 * Keep this list fail-closed and update it from Anthropic primary documentation.
 * It describes provider semantics only; callers must still intersect it with the
 * selected runtime adapter's encoder capability before choosing a projection.
 */
export const anthropicSystemMessageCapability = (modelID: string): ProviderSystemMessageCapability =>
  supported.some((pattern) => pattern.test(canonicalClaudeID(modelID))) ? CUMULATIVE : NONE
