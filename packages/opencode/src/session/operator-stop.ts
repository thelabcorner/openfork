import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { Database as DatabaseService } from "@opencode-ai/core/database/database"
import { SessionExecutionOwner as ExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import { SessionStatus } from "./status"
import { SwarmContainment } from "@/swarm/containment"
import type { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import type { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionContainment } from "@opencode-ai/core/session/containment"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import type { SessionID } from "./schema"

/**
 * An explicit operator Stop abandons the dead execution's unknown result.
 * It never asserts that an external effect was undone or safely replayable.
 * The callback pauses the Session before sealing this acknowledgement so no
 * autonomous continuation can replay the interrupted work after release.
 */
const acknowledgeStoppedOwner = Effect.fn("SessionOperatorRecovery.acknowledgeStoppedOwner")(function* (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  owner: SessionExecutionOwner.Interface,
  sessionID: SessionID,
  generation: number,
  pause: Effect.Effect<void>,
  prepare: (token: SessionExecutionOwner.Token | SessionExecutionOwner.RecoveryToken) => Effect.Effect<boolean>,
) {
  const observed = yield* owner.snapshot(sessionID)
  if (observed.generation !== generation) return "stale" as const
  if (!observed.ownerID) {
    const hazards = yield* SessionRecovery.executionHazards(db, sessionID)
    if (!hazards.currentTool && !hazards.legacyTool) return "idle" as const
    const acquired = yield* owner.tryAcquireLocal(sessionID)
    if (acquired.state !== "acquired") return "stale" as const
    if (acquired.token.generation !== generation + 1) {
      yield* owner.release(acquired.token)
      return "stale" as const
    }
    // This is a repair reservation, never a live executor. Always relinquish
    // it on failure so a later explicit recovery can retry in this runtime.
    // Admission independently rejects unresolved ownerless tool records.
    return yield* Effect.gen(function* () {
      yield* pause
      if (!(yield* prepare(acquired.token))) return "uncontained" as const
      yield* SessionRecovery.failInterruptedTools(db, events, sessionID)
      const remaining = yield* SessionRecovery.executionHazards(db, sessionID)
      if (remaining.currentTool || remaining.legacyTool) return "uncontained" as const
      return (yield* owner.release(acquired.token)) === "released" ? "recovered" as const : "stale" as const
    }).pipe(Effect.ensuring(owner.release(acquired.token)))
  }
  const claim = yield* owner.tryClaimRecovery(sessionID, { verifyDeathNow: true })
  if (claim.state === "idle") return "idle" as const
  if (claim.state !== "claimed") return "live" as const
  if (claim.token.generation !== generation) {
    yield* owner.abandonRecovery(claim.token)
    return "stale" as const
  }
  yield* pause
  if (!(yield* prepare(claim.token))) return "uncontained" as const
  const result = yield* SessionContainment.containAcknowledgedEffects(db, events, owner, claim.token)
  if (result.state === "contained" && result.release === "released") return "recovered" as const
  return result.state === "uncontained" ? "uncontained" as const : "stale" as const
})

export * as SessionOperatorRecovery from "./operator-stop"

export interface Interface {
  /** Explicit Stop/Pause/Resume abandons a dead generation's result as unknown. */
  readonly recover: (sessionID: SessionID, generation: number) => Effect.Effect<
    "stale" | "recovered" | "uncontained" | "idle" | "live"
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionOperatorRecovery") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const { db } = yield* DatabaseService.Service
  const events = yield* EventV2Bridge.Service
  const ownership = yield* ExecutionOwner.Service
  const sessions = yield* Session.Service
  const status = yield* SessionStatus.Service
  const swarm = yield* SwarmContainment.Service
  const locks = KeyedMutex.makeUnsafe<SessionID>()
  return Service.of({
    recover: (sessionID, generation) => locks.withLock(sessionID)(Effect.gen(function* () {
      const result = yield* acknowledgeStoppedOwner(db, events, ownership, sessionID, generation,
        sessions.get(sessionID).pipe(Effect.flatMap((session) => sessions.setPaused({
          sessionID, pausedAt: session.pausedAt ?? Date.now(),
        })), Effect.orDie),
        (token) => swarm.abandonSession(token).pipe(Effect.orDie),
      )
      if (result === "recovered") yield* status.set(sessionID, { type: "idle" }, "aborted")
      return result
    })),
  })
}))

export const node = LayerNode.make({ service: Service, layer,
  deps: [DatabaseService.node, ExecutionOwner.node, EventV2Bridge.node, Session.node, SessionStatus.node, SwarmContainment.node],
})
