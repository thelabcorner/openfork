/**
 * Context edits become durable EventV2 records and searchable overlay state.
 * Bound UTF-8 payload bytes before touching SQLite, not just operation count:
 * JavaScript's .length counts UTF-16 code units and underestimates many inputs.
 */
export const MAX_CONTEXT_REPLACEMENT_BYTES = 4 * 1024 * 1024
export const MAX_CONTEXT_BATCH_TEXT_BYTES = 8 * 1024 * 1024

export function withinContextPayloadBudget(
  operations: readonly { readonly type: string; readonly content?: unknown }[],
): boolean {
  let accumulated = 0
  for (const operation of operations) {
    if (operation.type !== "text.replace") continue
    if (typeof operation.content !== "string") return false
    const bytes = Buffer.byteLength(operation.content, "utf8")
    if (bytes > MAX_CONTEXT_REPLACEMENT_BYTES) return false
    accumulated += bytes
    if (accumulated > MAX_CONTEXT_BATCH_TEXT_BYTES) return false
  }
  return true
}
