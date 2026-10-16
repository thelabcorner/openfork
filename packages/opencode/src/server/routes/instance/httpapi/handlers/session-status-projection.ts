import type { Info } from "@opencode-ai/schema/session-status-event"

export type WorkingStatus = { readonly type: "busy" | "interrupted" }

/** Merge ephemeral display status with the durable execution-owner projection. */
export function projectSessionStatus(
  cached: Record<string, Info>,
  working: ReadonlyMap<string, WorkingStatus>,
) {
  const result: Record<string, Info> = {}
  // SessionStatus is process-local display state. Only a durable owner can
  // prove that busy/retry/interrupted state still has a live generation or a
  // fenced generation requiring recovery.
  for (const [sessionID, status] of working) {
    if (status.type === "interrupted") {
      result[sessionID] = status
      continue
    }
    // Preserve retry detail only while the owner proves this Session is still
    // inside the executing drain; without an owner there is no retry executor.
    result[sessionID] = cached[sessionID]?.type === "retry" ? cached[sessionID] : status
  }
  return result
}
