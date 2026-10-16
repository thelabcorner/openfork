/**
 * A provider can surface a fixed unavailable notice in its reasoning payload
 * instead of an actual reasoning summary. The original part remains durable
 * and authoritative; this classifier is for presentation and safe cross-model
 * history lowering (never provider-native continuation rewrites).
 *
 * Match only the entire observed sentinel. Never classify a substantive message
 * that merely contains the words, and never use reasoning-token counts to infer
 * what the provider actually returned.
 */
export function isUnavailableReasoningSentinel(text: string): boolean {
  if (text.length > 96) return false
  return /^\s*No reasoning available\.(?:<\|start\|>)?\s*$/.test(text)
}

/**
 * Avoid flashing a partially streamed sentinel before its final byte arrives.
 * Use this ONLY for unfinished reasoning parts; a completed genuine fragment
 * such as "No" must remain visible. Real content becomes visible immediately
 * when its prefix diverges from these two fixed known notices.
 */
export function isPendingUnavailableReasoningPrefix(text: string): boolean {
  if (text.length > 96) return false
  const prefix = text.trimStart()
  if (!prefix) return false
  return "No reasoning available.".startsWith(prefix) ||
    "No reasoning available.<|start|>".startsWith(prefix)
}
