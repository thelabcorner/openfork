/** Provider-side meaning of privileged messages that appear after conversation history. */
export type ProviderSystemHistoryMode = "none" | "cumulative-privileged" | "replace-complete"

/** What the exact provider/model contract says is semantically available. */
export interface ProviderSystemMessageCapability {
  readonly history: ProviderSystemHistoryMode
  readonly turnScoped: boolean
}

/** What one concrete OpenCode execution adapter can encode faithfully. */
export interface SystemMessageEncoderCapability {
  readonly chronological: boolean
  readonly turnScoped: boolean
}

/** Authority-preserving strategy available after provider/runtime intersection. */
export interface EffectiveSystemMessageCapability {
  readonly history: "head-only" | Exclude<ProviderSystemHistoryMode, "none">
  readonly turnScoped: boolean
}

export const HEAD_ONLY_SYSTEM_CAPABILITY: EffectiveSystemMessageCapability = {
  history: "head-only",
  turnScoped: false,
}

/**
 * Runtime support cannot create provider semantics, and provider support cannot
 * compensate for an adapter that cannot encode them. Unknown/unsupported paths
 * therefore fail closed to a privileged head projection.
 */
export const intersectSystemMessageCapability = (
  provider: ProviderSystemMessageCapability,
  encoder: SystemMessageEncoderCapability,
): EffectiveSystemMessageCapability => {
  const history = provider.history !== "none" && encoder.chronological ? provider.history : "head-only"
  return {
    history,
    // Turn-scoped System is a lifetime refinement of a chronological privileged
    // message, not an independent transport feature. An encoder that cannot
    // preserve chronological System authority cannot gain turn-scoped authority
    // merely because it knows how to spell a lifetime field.
    turnScoped: history !== "head-only" && provider.turnScoped && encoder.turnScoped,
  }
}
