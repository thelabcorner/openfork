/**
 * Durable, bounded Context part facts. V1 PartUpdated owns these values while
 * the exact part is already materialized; the Context ledger need not transfer
 * multi-megabyte tool results from SQLite into the renderer/sidecar just to
 * calculate token estimates, previews and signature locks.
 *
 * This projection never contains raw provider reasoning or full tool output.
 * The schema-version column controls safe fallback for historical part rows.
 */
export const CONTEXT_PART_FACT_VERSION = 1
const tokenEstimate = (text: unknown) =>
  typeof text === "string" && text.length > 0 ? Math.max(1, Math.ceil(text.length / 4)) : 0

export function contextPartFacts(part: { readonly type: string }) {
  const source = part as unknown as {
    type: string
    text?: string
    tool?: string
    state?: { status: string; output?: string; error?: string }
    metadata?: { anthropic?: { signature?: unknown } }
    synthetic?: boolean
    ignored?: boolean
  }
  const isText = source.type === "text" || source.type === "reasoning"
  const tool = source.type === "tool" ? source.state : undefined
  const status = tool?.status
  return {
    context_projection_version: CONTEXT_PART_FACT_VERSION,
    context_kind: source.type,
    context_tokens: isText ? tokenEstimate(source.text)
      : source.type === "file" ? 200
      : status === "completed" ? tokenEstimate(tool?.output)
      : status === "error" ? tokenEstimate(tool?.error) : 0,
    context_preview: isText ? (source.text ?? "").slice(0, 120)
      : source.type === "tool" ? (source.tool ?? "") : null,
    context_signed: source.type === "reasoning" && source.metadata?.anthropic?.signature != null,
    context_status: status ?? null,
    context_synthetic: source.synthetic === true,
    context_ignored: source.ignored === true,
  }
}
