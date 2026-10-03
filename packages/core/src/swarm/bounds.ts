/**
 * Shared byte-accurate bounds for durable/model-authored Swarm text.
 *
 * Keep persistence and model-facing projection on the same UTF-8 semantics so
 * oversized collaboration data cannot silently expand storage or prompt cost.
 */
export const TASK_RUN_RESULT_SUMMARY_MAX_BYTES = 4 * 1024

const encoder = new TextEncoder()

export function byteLength(text: string) {
  return encoder.encode(text).length
}

/** Longest prefix of `text` that fits `maxBytes` UTF-8 bytes on a character boundary. */
function utf8Prefix(text: string, maxBytes: number) {
  if (maxBytes <= 0) return ""
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = byteLength(char)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

/**
 * Byte-accurate truncation on a UTF-8 boundary. The marker is included inside
 * the budget, so the returned value never exceeds `maxBytes`.
 */
export function clampText(text: string, maxBytes: number) {
  if (maxBytes <= 0) return ""
  if (byteLength(text) <= maxBytes) return text
  const marker = " [truncated]"
  const budget = maxBytes - byteLength(marker)
  if (budget <= 0) return utf8Prefix(marker, maxBytes)
  return utf8Prefix(text, budget) + marker
}

/**
 * Durable successful-run summary. Empty/whitespace-only input is represented as
 * absence; useful text is trimmed and capped before it reaches SQLite.
 */
export function taskRunResultSummary(text: string | undefined) {
  const value = text?.trim()
  if (!value) return undefined
  return clampText(value, TASK_RUN_RESULT_SUMMARY_MAX_BYTES)
}
