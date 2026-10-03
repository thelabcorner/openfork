export * as UsageClassification from "./classification"

export const MAINTENANCE_MODE = "maintenance"

/**
 * Classify provider work that supports a Session without belonging to ordinary
 * user-facing work. Conversation-backed maintenance (compaction, summaries,
 * durable special-agent transcripts) stays in usage_record so Session-local
 * observability has one settlement ledger, then is routed out of ordinary Usage
 * aggregates here.
 */
export function maintenanceAgent(input: {
  readonly agent?: string | null
  readonly mode?: string | null
}): string | undefined {
  if (input.mode === MAINTENANCE_MODE) return input.agent || "maintenance"
  if (input.mode === "compaction" || input.agent === "compaction") return "compaction"
  if (input.agent === "summary") return "summary"
  return undefined
}

export function isUserFacing(input: {
  readonly agent?: string | null
  readonly mode?: string | null
}) {
  return maintenanceAgent(input) === undefined
}

/**
 * Special-agent transcript settlements are mirrored into usage_record for
 * Session-local observability while maintenance_usage remains their global
 * accounting ledger. Callers aggregating both ledgers must therefore skip the
 * mirrored usage_record row after classifying it as non-user-facing.
 */
export function isMirroredMaintenanceSettlement(input: { readonly mode?: string | null }) {
  return input.mode === MAINTENANCE_MODE
}
