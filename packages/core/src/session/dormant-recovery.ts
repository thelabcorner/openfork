export * as SessionDormantRecovery from "./dormant-recovery"

import { Cause, Effect } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionExecutionOwner } from "./execution-owner"
import { SessionRecovery } from "./recovery"
import { SessionSchema } from "./schema"

/**
 * One-shot, opportunistic boot repair in the EXISTING Core execution service.
 * This does not own a second executor, create a timer, perform a frontend
 * history sweep, or reopen a Location/Instance. Every mutation is delegated to
 * SessionRecovery's exact death-proof claim and tool/turn settlement.
 *
 * Stability beats throughput: examine no more than 16 unverified generations
 * per boot and do not take recovery claims for unresolved external tool effects.
 * Busy/living foreign owners remain untouched.
 */
export const BOOT_RECOVERY_ATTEMPT_LIMIT = 16

export function selectDormantCandidates(
  states: ReadonlyMap<SessionSchema.ID, { readonly type: "busy" | "interrupted" }>,
  max = BOOT_RECOVERY_ATTEMPT_LIMIT,
): { readonly ids: readonly SessionSchema.ID[]; readonly truncated: boolean } {
  const limit = Math.max(0, Math.min(BOOT_RECOVERY_ATTEMPT_LIMIT, Math.trunc(max) || 0))
  const ids: SessionSchema.ID[] = []
  let truncated = false
  for (const [id, status] of states) {
    if (status.type !== "interrupted") continue
    if (ids.length >= limit) {
      truncated = true
      break
    }
    ids.push(id)
  }
  return { ids, truncated }
}

type Reader = Pick<Database.Interface["db"], "select">

export const reconcileDormant = Effect.fn("SessionDormantRecovery.reconcileDormant")(function* (
  db: Reader,
  ownership: SessionExecutionOwner.Interface,
  events: EventV2.Interface,
) {
  const selected = selectDormantCandidates(yield* ownership.listWorking())
  let recovered = 0
  let deferred = 0
  for (const sessionID of selected.ids) {
    const repaired = yield* Effect.gen(function* () {
      // Cheap, independent negative proof before taking recovery ownership.
      // Unresolved effects are left for the explicit supervisor/operator
      // containment path, preserving their existing recovery permissions.
      const hazards = yield* SessionRecovery.executionHazards(db, sessionID)
      if (hazards.currentTool || hazards.legacyTool) return "deferred" as const
      const result = yield* SessionRecovery.recoverDeadOwnerIfQuiescent(db, ownership, sessionID, events)
      return result.state === "recovered" ? "recovered" as const : "deferred" as const
    }).pipe(Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("Opportunistic dead Session recovery deferred", {
            sessionID, cause: Cause.pretty(cause),
          }).pipe(Effect.as("deferred" as const)),
    ))
    if (repaired === "recovered") recovered++
    else deferred++
    // Cooperatively yield to foreground SQLite/runner work. No recurring
    // timer or extra native interval is required in the one-shot boot sweep.
    yield* Effect.yieldNow
  }
  return { inspected: selected.ids.length, recovered, deferred, truncated: selected.truncated }
})
