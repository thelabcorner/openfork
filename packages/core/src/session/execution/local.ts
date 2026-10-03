import { Cause, Effect, Exit, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionExecutionOwner } from "../execution-owner"
import { GoalAutomation } from "../../goal/automation"
import { Database } from "../../database/database"
import { SessionRecovery } from "../recovery"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const automation = yield* GoalAutomation.Service
    const ownership = yield* SessionExecutionOwner.Service
    const { db } = yield* Database.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        let acquired = yield* ownership.tryAcquireLocal(sessionID)
        if (acquired.state === "maintenance-blocked") {
          yield* Effect.logInfo("Session execution admission blocked by directory maintenance", {
            sessionID,
            reason: acquired.reason,
            directory: acquired.directory,
            directoryKey: acquired.directoryKey,
            guards: acquired.guards,
          })
          return
        }
        if (acquired.state === "busy") {
          const recovery = yield* SessionRecovery.recoverDeadOwnerIfQuiescent(db, ownership, sessionID)
          if (recovery.state === "recovered") acquired = yield* ownership.tryAcquireLocal(sessionID)
          else if (recovery.state === "effect-unknown")
            yield* Effect.logWarning("Session recovery remains fenced by unresolved execution effects", {
              sessionID,
              generation: recovery.token.generation,
              hazards: recovery.hazards,
            })
        }
        if (acquired.state === "maintenance-blocked") {
          yield* Effect.logInfo("Session execution admission became maintenance-blocked after recovery", {
            sessionID,
            reason: acquired.reason,
            directory: acquired.directory,
            directoryKey: acquired.directoryKey,
            guards: acquired.guards,
          })
          return
        }
        // Another process already owns this Session. The durable inbox is the
        // wake signal: that owner's release-if-drained transaction must observe
        // newly committed work and continue. Do not create a second runner.
        if (acquired.state === "busy") return

        const token = acquired.token
        let ownershipSettled = false
        return yield* Effect.gen(function* () {
          let nextForce = force
          let firstFailure: Cause.Cause<SessionRunner.RunError> | undefined
          while (true) {
            const exit = yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force: nextForce })).pipe(
              Effect.provide(locations.get(session.location)),
              Effect.exit,
            )
            if (Exit.isFailure(exit) && firstFailure === undefined) firstFailure = exit.cause


            const release = yield* ownership.releaseIfDrained(token)
            if (release === "continue") {
              // New durable work committed before release. It is not an explicit
              // forced run, even if the activation began through resume().
              nextForce = false
              continue
            }
            // "released" means this generation was cleared here; "stale"
            // means another exact owner/generation is already authoritative.
            // Either way this activation has no ownership left to clean up.
            ownershipSettled = true
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              yield* Effect.logError("Failed to drain Session", exit.cause).pipe(Effect.annotateLogs({ sessionID }))
            }
            if (firstFailure) return yield* Effect.failCause(firstFailure)
            return
          }
        }).pipe(
          // SessionRunCoordinator.interrupt() interrupts this outer drain
          // fiber. An interrupt that lands while SessionRunner is active skips
          // the statements after that yield, so releaseIfDrained() cannot be
          // our cancellation barrier. Effect finalization first unwinds the
          // runner/location scope, then exact-releases only this generation.
          // Pending SessionInput is intentionally preserved for a later wake.
          Effect.ensuring(
            Effect.suspend(() =>
              ownershipSettled ? Effect.void : ownership.release(token).pipe(Effect.asVoid),
            ),
          ),
        )
      }),
    })

    // Recover reservations left by a process crash through the exact same
    // coordinator used for ordinary prompt wakes. Yield once so construction of
    // the surrounding service graph can settle before any recovered drain asks
    // the Location map for its runner.
    yield* Effect.gen(function* () {
      yield* Effect.yieldNow
      const pending = yield* automation.pendingSessions()
      yield* Effect.forEach(pending, coordinator.wake, { concurrency: 8, discard: true })
    }).pipe(Effect.forkScoped)

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: (sessionID) =>
        ownership.requestInterrupt(sessionID, "operator").pipe(
          Effect.andThen(coordinator.interrupt(sessionID)),
          Effect.asVoid,
        ),
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, GoalAutomation.node, SessionExecutionOwner.node, Database.node],
})

export * as SessionExecutionLocal from "./local"
