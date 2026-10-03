export * as SessionContainment from "./containment"

import { Effect } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import type { SessionExecutionOwner } from "./execution-owner"
import { executionHazards, failInterruptedTools, type ExecutionHazards } from "./recovery"

type DatabaseReader = Pick<Database.Interface["db"], "select">

export type ContainedEffectsResult =
  /** The caller's recovery claim is no longer the durable one; nothing was touched. */
  | { readonly state: "stale"; readonly snapshot: SessionExecutionOwner.Snapshot }
  /**
   * Sealing could not prove quiescence for every hazard (for example a hazard
   * only visible in the retained V1 projection). Authority stays fenced.
   */
  | { readonly state: "uncontained"; readonly hazards: ExecutionHazards; readonly sealed: number }
  | {
      readonly state: "contained"
      readonly token: SessionExecutionOwner.RecoveryToken
      readonly sealed: number
      readonly release: SessionExecutionOwner.ExactReleaseResult
    }

/**
 * Explicit containment acknowledgement for a dead owner's unresolved effects.
 *
 * Automatic dead-owner recovery deliberately refuses to proceed while any durable
 * tool boundary is unresolved, because a hard-dead runtime may have left an OS
 * child mutating the workspace. Left alone, that refusal is permanent: the claim
 * is retained, the generation stays fenced, and every higher-level consumer that
 * is waiting on that generation (for example a Swarm lease stuck in `retiring`)
 * waits forever. This function is the one fail-closed seam an operator
 * acknowledgement flows through.
 *
 * Honesty contract. Sealing here is transcript repair, not a claim about the
 * outside world. Unresolved tool rows are settled with an unknown error; nothing
 * asserts the effect completed, failed, or was avoided. Deciding what that means
 * for a task's outcome stays with the caller.
 *
 * - Authority comes from the caller's exact `RecoveryToken`. SessionExecutionOwner
 *   only issues one after proving local death, so no caller can acknowledge the
 *   effects of a live or merely unknown owner, and re-asserting a stale token
 *   fails closed before anything is written.
 * - Containment seals before it releases. Releasing first would drop the fence
 *   while the effects are still unknown; sealing first keeps the generation
 *   fenced until the acknowledgement is durable. A crash between the two leaves
 *   the claim held with the effects already sealed, so a later recovery owner
 *   converges through this same function rather than treating the generation as
 *   silently quiescent.
 * - Authority is released only when a fresh hazard re-read proves quiescence in
 *   both projections, so evidence this function cannot seal keeps the fence.
 *
 * Re-running is safe: sealing is idempotent and `completeRecovery` is an exact
 * CAS, so a repeated acknowledgement reports `stale` instead of releasing twice.
 */
export const containAcknowledgedEffects = Effect.fn("SessionContainment.containAcknowledgedEffects")(function* (
  db: DatabaseReader,
  events: EventV2.Interface,
  ownership: SessionExecutionOwner.Interface,
  token: SessionExecutionOwner.RecoveryToken,
) {
  const snapshot = yield* ownership.snapshot(token.sessionID)
  if (
    snapshot.ownerID !== token.ownerID ||
    snapshot.generation !== token.generation ||
    snapshot.recoveryOwnerID !== token.recoveryOwnerID
  )
    return { state: "stale" as const, snapshot }

  const sealed = (yield* failInterruptedTools(db, events, token.sessionID)).settled
  const remaining = yield* executionHazards(db, token.sessionID)
  if (remaining.currentTool || remaining.legacyTool) return { state: "uncontained" as const, hazards: remaining, sealed }

  const release = yield* ownership.completeRecovery(token)
  return { state: "contained" as const, token, sealed, release }
})
