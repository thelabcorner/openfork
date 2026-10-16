import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionOperatorRecovery } from "./operator-stop"
import type { SessionID } from "./schema"
import { Effect } from "effect"

/** Shared admission check; healthy live contention remains coalescible. */
export const requireResumeReady = Effect.fn("SessionResume.requireReady")(function* (sessionID: SessionID) {
  const ownership = yield* SessionExecutionOwner.Service
  const recovery = yield* SessionOperatorRecovery.Service
  const snapshot = yield* ownership.snapshot(sessionID)
  const recovered = yield* recovery.recover(sessionID, snapshot.generation)
  if (recovered === "uncontained" || recovered === "stale")
    return yield* Effect.fail(new Error("Session recovery raced execution or task ownership; Resume has not started execution. Retry Resume after ownership settles."))
  if (recovered === "live" && snapshot.recoveryOwnerID)
    return yield* Effect.fail(new Error("Session recovery is owned by another runtime; Resume has not started execution."))
})
