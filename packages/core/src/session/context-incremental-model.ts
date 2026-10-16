/**
 * Context ledger: version-1 candidate row and reversible scalar delta.
 *
 * This is a pure, storage-agnostic core of a future persistent materialization.
 * It MUST NOT be used as an authoritative read projection until the V1 event
 * projector, Context overlay projector, legacy repair and out-of-band writer
 * fences all share an atomic durability boundary. The existing SQL aggregate
 * remains the shipping source of truth.
 *
 * Storage invariant:
 *   summary' = summary - previousRow + nextRow
 * with duplicate event/replay inputs replacing, NOT incrementing, the row.
 * Each update needs only facts for the affected message; no session scan.
 */
export type ContextMaterializedTotals = Readonly<{
  messageCount: number
  excludedCount: number
  pinnedCount: number
  editedCount: number
  estimatedTokens: number
  estimatedTokensExcluded: number
}>
export type ContextMaterializedPart = Readonly<{
  id: string
  kind: string | null
  tokens: number
  version: number
  signed: boolean
  status: string | null
}>
export type ContextMaterializedOverlay = Readonly<{
  excluded: boolean
  pinned: boolean
  override?: { text?: unknown; collapsed?: unknown; partID?: unknown } | null
}>
export type ContextMaterializedInput = Readonly<{
  parts: readonly ContextMaterializedPart[]
  overlay?: ContextMaterializedOverlay
  stateOwned: boolean
  messageOpaque: boolean
}>

/** Null means facts are incomplete: never report a plausible zero token row. */
export function materializeContextMessage(input: ContextMaterializedInput): ContextMaterializedTotals | null {
  if (input.messageOpaque) return null
  let tokens = 4
  let signed = false
  let editTarget = false
  let collapseTarget = false
  let compacted = false
  const target = input.overlay?.override?.partID
  for (const part of input.parts) {
    if (part.version !== 1 || typeof part.kind !== "string" || !part.kind ||
      !Number.isSafeInteger(part.tokens) || part.tokens < 0) return null
    if (part.kind === "compaction") compacted = true
    tokens += part.tokens
    signed ||= part.signed
    if ((part.kind === "text" || part.kind === "reasoning") &&
      (target == null || target === part.id)) editTarget = true
    if (part.kind === "tool" && part.status === "completed" && target === part.id)
      collapseTarget = true
  }
  // Current SQL totals are only defined for ordinary chronological history.
  // A compaction mark may reorder the history after a summary completes.
  if (compacted || !Number.isSafeInteger(tokens)) return null
  const overlay = input.stateOwned ? undefined : input.overlay
  const excluded = !!overlay?.excluded && !overlay.pinned && !signed
  const pinned = !!overlay?.pinned
  const override = overlay?.override
  const edited = !excluded && (
    (override?.text != null && !signed && editTarget) ||
    (override?.collapsed === true && collapseTarget)
  )
  return {
    messageCount: 1,
    excludedCount: excluded ? 1 : 0,
    pinnedCount: pinned ? 1 : 0,
    editedCount: edited ? 1 : 0,
    estimatedTokens: excluded ? 0 : tokens,
    estimatedTokensExcluded: excluded ? tokens : 0,
  }
}

export const zeroContextMaterializedTotals: ContextMaterializedTotals = Object.freeze({
  messageCount: 0, excludedCount: 0, pinnedCount: 0,
  editedCount: 0, estimatedTokens: 0, estimatedTokensExcluded: 0,
})

const keys = [
  "messageCount", "excludedCount", "pinnedCount", "editedCount",
  "estimatedTokens", "estimatedTokensExcluded",
] as const

/**
 * Works for insert, update, delete, duplicate replay, signed reasoning,
 * edits and pins. A null row is *incomplete*, not an absent message; callers
 * track its validity separately instead of subtracting its 0 contribution.
 */
export function contextMaterializedDelta(
  previous: ContextMaterializedTotals | null | undefined,
  next: ContextMaterializedTotals | null | undefined,
): ContextMaterializedTotals {
  const result = {} as Record<(typeof keys)[number], number>
  for (const key of keys) result[key] = (next?.[key] ?? 0) - (previous?.[key] ?? 0)
  return result
}

export function addContextMaterializedTotals(
  current: ContextMaterializedTotals,
  delta: ContextMaterializedTotals,
): ContextMaterializedTotals {
  const result = {} as Record<(typeof keys)[number], number>
  for (const key of keys) {
    const value = current[key] + delta[key]
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Context materialized ${key} overflow/underflow`)
    result[key] = value
  }
  return result
}
