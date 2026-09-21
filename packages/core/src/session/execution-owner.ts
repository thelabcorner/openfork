export * as SessionExecutionOwner from "./execution-owner"

import { and, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Semaphore } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { RuntimeOwner } from "../runtime-owner"
import { RuntimeOwnerTable } from "../runtime-owner.sql"
import { SessionExecutionOwnerTable } from "./execution-owner.sql"
import { SessionSchema } from "./schema"
import { SessionInputTable } from "./sql"

export type InterruptReason = "operator" | "pause" | "handoff" | "shutdown" | "recovery"

export interface Token {
  readonly sessionID: SessionSchema.ID
  readonly ownerID: RuntimeOwner.ID
  readonly generation: number
}

export interface RecoveryToken {
  readonly sessionID: SessionSchema.ID
  readonly ownerID: RuntimeOwner.ID
  readonly generation: number
  readonly recoveryOwnerID: RuntimeOwner.ID
}

export interface Snapshot {
  readonly sessionID: SessionSchema.ID
  readonly generation: number
  readonly ownerID?: RuntimeOwner.ID
  readonly acquiredAt?: number
  readonly interruptGeneration?: number
  readonly interruptReason?: InterruptReason
  readonly interruptRequestedAt?: number
  readonly recoveryOwnerID?: RuntimeOwner.ID
  readonly recoveryStartedAt?: number
  readonly runtime?: RuntimeOwner.Snapshot
}

export type AcquireResult =
  | { readonly state: "acquired"; readonly token: Token }
  | { readonly state: "busy"; readonly snapshot: Snapshot }

export type ReleaseResult = "released" | "continue" | "stale"
export type ExactReleaseResult = Exclude<ReleaseResult, "continue">
export type RecoveryClaimResult =
  | { readonly state: "idle"; readonly snapshot: Snapshot }
  | {
      readonly state: "blocked"
      readonly proof: Exclude<RuntimeOwner.LocalDeathProof, "dead">
      readonly snapshot: Snapshot
    }
  | { readonly state: "busy"; readonly snapshot: Snapshot }
  | { readonly state: "claimed"; readonly token: RecoveryToken; readonly snapshot: Snapshot }

export interface Interface {
  readonly tryAcquire: (sessionID: SessionSchema.ID) => Effect.Effect<AcquireResult>
  /**
   * Releases only the exact owner+generation and only when the durable Session
   * inbox is empty in the same IMMEDIATE transaction.
   */
  readonly releaseIfDrained: (token: Token) => Effect.Effect<ReleaseResult>
  /**
   * Exact-generation release after an explicit quiescence/cancellation barrier.
   * Unlike releaseIfDrained this deliberately ignores pending SessionInput:
   * cancelling execution must not consume or auto-run durable inbox work.
   */
  readonly release: (token: Token) => Effect.Effect<ExactReleaseResult>
  readonly snapshot: (sessionID: SessionSchema.ID) => Effect.Effect<Snapshot>
  readonly requestInterrupt: (
    sessionID: SessionSchema.ID,
    reason: InterruptReason,
  ) => Effect.Effect<
    | { readonly state: "idle" }
    | {
        readonly state: "requested"
        readonly token: Token
        readonly interruptGeneration: number
      }
  >
  /**
   * Claim exclusive reconciliation authority for a proven-dead execution owner.
   *
   * Heartbeat staleness is never sufficient. The old owner/generation remains
   * recorded while recovery is claimed, so normal execution cannot overlap it.
   * This API deliberately does NOT clear execution ownership; containment and
   * uncertain-effect reconciliation remain separate prerequisites.
   */
  readonly tryClaimRecovery: (sessionID: SessionSchema.ID) => Effect.Effect<RecoveryClaimResult>
  /**
   * Completes recovery only for the exact dead-owner generation and exact
   * recovery owner that proved quiescence. Pending SessionInput is preserved;
   * the next activation acquires generation + 1.
   */
  readonly completeRecovery: (token: RecoveryToken) => Effect.Effect<ExactReleaseResult>
  /**
   * Releases only this process's exact recovery claim. It never clears the old
   * execution owner or advances the Session generation.
   */
  readonly abandonRecovery: (token: RecoveryToken) => Effect.Effect<ExactReleaseResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionExecutionOwner") {}

type Row = typeof SessionExecutionOwnerTable.$inferSelect

const tokenOf = (row: Row): Token | undefined =>
  row.owner_id === null
    ? undefined
    : {
        sessionID: SessionSchema.ID.make(row.session_id),
        ownerID: row.owner_id as RuntimeOwner.ID,
        generation: row.generation,
      }

const snapshotOf = (row: Row, runtime?: RuntimeOwner.Snapshot): Snapshot => ({
  sessionID: SessionSchema.ID.make(row.session_id),
  generation: row.generation,
  ...(row.owner_id === null ? {} : { ownerID: row.owner_id as RuntimeOwner.ID }),
  ...(row.acquired_at === null ? {} : { acquiredAt: row.acquired_at }),
  ...(row.interrupt_generation === null ? {} : { interruptGeneration: row.interrupt_generation }),
  ...(row.interrupt_reason === null ? {} : { interruptReason: row.interrupt_reason as InterruptReason }),
  ...(row.interrupt_requested_at === null ? {} : { interruptRequestedAt: row.interrupt_requested_at }),
  ...(row.recovery_owner_id === null ? {} : { recoveryOwnerID: row.recovery_owner_id as RuntimeOwner.ID }),
  ...(row.recovery_started_at === null ? {} : { recoveryStartedAt: row.recovery_started_at }),
  ...(runtime === undefined ? {} : { runtime }),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const runtime = yield* RuntimeOwner.Service
    const retentions = new Map<string, RuntimeOwner.Retention>()
    const recoveryRetentions = new Map<string, RuntimeOwner.Retention>()
    const recoveryLock = Semaphore.makeUnsafe(1)
    const tokenKey = (token: Token) => token.sessionID + ":" + token.generation
    const recoveryTokenKey = (token: RecoveryToken) =>
      token.sessionID + ":" + token.generation + ":" + token.ownerID + ":" + token.recoveryOwnerID

    const releaseRetention = Effect.fn("SessionExecutionOwner.releaseRetention")(function* (token: Token) {
      const key = tokenKey(token)
      const retention = retentions.get(key)
      if (!retention) return
      retentions.delete(key)
      yield* retention.release
    })

    const hydrateSnapshot = Effect.fn("SessionExecutionOwner.hydrateSnapshot")(function* (row: Row) {
      const owner = row.owner_id === null ? undefined : yield* runtime.snapshot(row.owner_id as RuntimeOwner.ID)
      return snapshotOf(row, owner)
    })

    const snapshot = Effect.fn("SessionExecutionOwner.snapshot")(function* (sessionID: SessionSchema.ID) {
      const row = yield* readDb
        .select()
        .from(SessionExecutionOwnerTable)
        .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (row) return yield* hydrateSnapshot(row)
      return { sessionID, generation: 0 } satisfies Snapshot
    })

    const recoveryTokenOf = (row: Row): RecoveryToken | undefined =>
      row.owner_id === null || row.recovery_owner_id === null
        ? undefined
        : {
            sessionID: SessionSchema.ID.make(row.session_id),
            ownerID: row.owner_id as RuntimeOwner.ID,
            generation: row.generation,
            recoveryOwnerID: row.recovery_owner_id as RuntimeOwner.ID,
          }

    const releaseRecoveryRetention = Effect.fn("SessionExecutionOwner.releaseRecoveryRetention")(function* (
      token: RecoveryToken,
    ) {
      const key = recoveryTokenKey(token)
      const retention = recoveryRetentions.get(key)
      if (!retention) return
      recoveryRetentions.delete(key)
      yield* retention.release
    })

    const tryClaimRecovery = Effect.fn("SessionExecutionOwner.tryClaimRecovery")(function* (
      sessionID: SessionSchema.ID,
    ) {
      return yield* recoveryLock.withPermit(
        Effect.gen(function* () {
          const retention = yield* runtime.retain
          const row = yield* readDb
            .select()
            .from(SessionExecutionOwnerTable)
            .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row || row.owner_id === null) {
            yield* retention.release
            return {
              state: "idle" as const,
              snapshot: row ? yield* hydrateSnapshot(row) : ({ sessionID, generation: 0 } satisfies Snapshot),
            }
          }

          const observed = tokenOf(row)!
          if (row.recovery_owner_id !== null) {
            if (row.recovery_owner_id === runtime.id) {
              const token = recoveryTokenOf(row)!
              const key = recoveryTokenKey(token)
              if (recoveryRetentions.has(key)) yield* retention.release
              else recoveryRetentions.set(key, retention)
              return { state: "claimed" as const, token, snapshot: yield* hydrateSnapshot(row) }
            }

            const previousRecoveryOwnerID = row.recovery_owner_id as RuntimeOwner.ID
            const recoveryProof = yield* runtime.proveLocalDeath(previousRecoveryOwnerID)
            if (recoveryProof !== "dead") {
              yield* retention.release
              return { state: "busy" as const, snapshot: yield* hydrateSnapshot(row) }
            }

            // Recovery ownership is itself crash-recoverable, but only with an
            // exact CAS over the original execution owner/generation and the
            // previous recovery owner. This never clears or advances Session
            // execution authority.
            const reclaimedAt = Date.now()
            const reclaimed = yield* db
              .transaction(
                (tx) =>
                  tx
                    .update(SessionExecutionOwnerTable)
                    .set({
                      recovery_owner_id: runtime.id,
                      recovery_started_at: reclaimedAt,
                    })
                    .where(
                      and(
                        eq(SessionExecutionOwnerTable.session_id, observed.sessionID),
                        eq(SessionExecutionOwnerTable.owner_id, observed.ownerID),
                        eq(SessionExecutionOwnerTable.generation, observed.generation),
                        eq(SessionExecutionOwnerTable.recovery_owner_id, previousRecoveryOwnerID),
                      ),
                    )
                    .returning()
                    .get()
                    .pipe(Effect.orDie),
                { behavior: "immediate" },
              )
              .pipe(Effect.orDie)
            if (reclaimed) {
              const token = recoveryTokenOf(reclaimed)!
              recoveryRetentions.set(recoveryTokenKey(token), retention)
              return { state: "claimed" as const, token, snapshot: yield* hydrateSnapshot(reclaimed) }
            }

            yield* retention.release
            const current = yield* readDb
              .select()
              .from(SessionExecutionOwnerTable)
              .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!current || current.owner_id === null)
              return {
                state: "idle" as const,
                snapshot: current
                  ? yield* hydrateSnapshot(current)
                  : ({ sessionID, generation: 0 } satisfies Snapshot),
              }
            return { state: "busy" as const, snapshot: yield* hydrateSnapshot(current) }
          }

          const proof = yield* runtime.proveLocalDeath(observed.ownerID)
          if (proof !== "dead") {
            yield* retention.release
            return { state: "blocked" as const, proof, snapshot: yield* hydrateSnapshot(row) }
          }

          const startedAt = Date.now()
          const claimed = yield* db
            .transaction(
              (tx) =>
                tx
                  .update(SessionExecutionOwnerTable)
                  .set({
                    recovery_owner_id: runtime.id,
                    recovery_started_at: startedAt,
                  })
                  .where(
                    and(
                      eq(SessionExecutionOwnerTable.session_id, observed.sessionID),
                      eq(SessionExecutionOwnerTable.owner_id, observed.ownerID),
                      eq(SessionExecutionOwnerTable.generation, observed.generation),
                      isNull(SessionExecutionOwnerTable.recovery_owner_id),
                    ),
                  )
                  .returning()
                  .get()
                  .pipe(Effect.orDie),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)

          if (!claimed) {
            yield* retention.release
            const current = yield* readDb
              .select()
              .from(SessionExecutionOwnerTable)
              .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!current || current.owner_id === null)
              return {
                state: "idle" as const,
                snapshot: current
                  ? yield* hydrateSnapshot(current)
                  : ({ sessionID, generation: 0 } satisfies Snapshot),
              }
            if (current.recovery_owner_id === runtime.id) {
              const token = recoveryTokenOf(current)!
              recoveryRetentions.set(recoveryTokenKey(token), yield* runtime.retain)
              return { state: "claimed" as const, token, snapshot: yield* hydrateSnapshot(current) }
            }
            return { state: "busy" as const, snapshot: yield* hydrateSnapshot(current) }
          }

          const token = recoveryTokenOf(claimed)!
          recoveryRetentions.set(recoveryTokenKey(token), retention)
          return { state: "claimed" as const, token, snapshot: yield* hydrateSnapshot(claimed) }
        }),
      )
    })

    const abandonRecovery = Effect.fn("SessionExecutionOwner.abandonRecovery")(function* (token: RecoveryToken) {
      const released = yield* db
        .transaction(
          (tx) =>
            tx
              .update(SessionExecutionOwnerTable)
              .set({
                recovery_owner_id: null,
                recovery_started_at: null,
              })
              .where(
                and(
                  eq(SessionExecutionOwnerTable.session_id, token.sessionID),
                  eq(SessionExecutionOwnerTable.owner_id, token.ownerID),
                  eq(SessionExecutionOwnerTable.generation, token.generation),
                  eq(SessionExecutionOwnerTable.recovery_owner_id, token.recoveryOwnerID),
                ),
              )
              .returning({ sessionID: SessionExecutionOwnerTable.session_id })
              .get()
              .pipe(Effect.orDie),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      yield* releaseRecoveryRetention(token)
      return released ? ("released" as const) : ("stale" as const)
    })

    const completeRecovery = Effect.fn("SessionExecutionOwner.completeRecovery")(function* (token: RecoveryToken) {
      const released = yield* db
        .transaction(
          (tx) =>
            tx
              .update(SessionExecutionOwnerTable)
              .set({
                owner_id: null,
                acquired_at: null,
                interrupt_generation: null,
                interrupt_reason: null,
                interrupt_requested_at: null,
                recovery_owner_id: null,
                recovery_started_at: null,
              })
              .where(
                and(
                  eq(SessionExecutionOwnerTable.session_id, token.sessionID),
                  eq(SessionExecutionOwnerTable.owner_id, token.ownerID),
                  eq(SessionExecutionOwnerTable.generation, token.generation),
                  eq(SessionExecutionOwnerTable.recovery_owner_id, token.recoveryOwnerID),
                ),
              )
              .returning({ sessionID: SessionExecutionOwnerTable.session_id })
              .get()
              .pipe(Effect.orDie),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      yield* releaseRecoveryRetention(token)
      return released ? ("released" as const) : ("stale" as const)
    })

    const tryAcquire = Effect.fn("SessionExecutionOwner.tryAcquire")(function* (sessionID: SessionSchema.ID) {
      // Ensure the RuntimeOwner FK target exists and keep its one process
      // heartbeat alive before publishing durable Session ownership.
      const retention = yield* runtime.retain
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const existing = yield* tx
                .select()
                .from(SessionExecutionOwnerTable)
                .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
                .get()
                .pipe(Effect.orDie)
              if (existing?.owner_id) return { state: "busy" as const, row: existing }

              const now = Date.now()
              if (!existing) {
                const inserted = yield* tx
                  .insert(SessionExecutionOwnerTable)
                  .values({
                    session_id: sessionID,
                    generation: 1,
                    owner_id: runtime.id,
                    acquired_at: now,
                  })
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
                if (!inserted) return yield* Effect.die("Failed to acquire Session execution owner for " + sessionID)
                return { state: "acquired" as const, row: inserted }
              }

              const updated = yield* tx
                .update(SessionExecutionOwnerTable)
                .set({
                  generation: existing.generation + 1,
                  owner_id: runtime.id,
                  acquired_at: now,
                  interrupt_generation: null,
                  interrupt_reason: null,
                  interrupt_requested_at: null,
                  recovery_owner_id: null,
                  recovery_started_at: null,
                })
                .where(
                  and(
                    eq(SessionExecutionOwnerTable.session_id, sessionID),
                    eq(SessionExecutionOwnerTable.generation, existing.generation),
                    isNull(SessionExecutionOwnerTable.owner_id),
                  ),
                )
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (!updated) {
                const raced = yield* tx
                  .select()
                  .from(SessionExecutionOwnerTable)
                  .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (!raced) return yield* Effect.die("Session execution owner disappeared for " + sessionID)
                return { state: "busy" as const, row: raced }
              }
              return { state: "acquired" as const, row: updated }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)

      if (result.state === "busy") {
        yield* retention.release
        return { state: "busy" as const, snapshot: yield* hydrateSnapshot(result.row) }
      }
      const token = tokenOf(result.row)
      if (!token) {
        yield* retention.release
        return yield* Effect.die("Acquired Session execution row is unexpectedly idle for " + sessionID)
      }
      retentions.set(tokenKey(token), retention)
      return { state: "acquired" as const, token }
    })

    const releaseIfDrained = Effect.fn("SessionExecutionOwner.releaseIfDrained")(function* (token: Token) {
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const owned = yield* tx
                .select({ generation: SessionExecutionOwnerTable.generation })
                .from(SessionExecutionOwnerTable)
                .where(
                  and(
                    eq(SessionExecutionOwnerTable.session_id, token.sessionID),
                    eq(SessionExecutionOwnerTable.owner_id, token.ownerID),
                    eq(SessionExecutionOwnerTable.generation, token.generation),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (!owned) return "stale" as const

              const pending = yield* tx
                .select({ id: SessionInputTable.id })
                .from(SessionInputTable)
                .where(
                  and(
                    eq(SessionInputTable.session_id, token.sessionID),
                    isNull(SessionInputTable.promoted_seq),
                    isNull(SessionInputTable.revoked_seq),
                  ),
                )
                .limit(1)
                .get()
                .pipe(Effect.orDie)
              if (pending) return "continue" as const

              const released = yield* tx
                .update(SessionExecutionOwnerTable)
                .set({
                  owner_id: null,
                  acquired_at: null,
                  interrupt_generation: null,
                  interrupt_reason: null,
                  interrupt_requested_at: null,
                  recovery_owner_id: null,
                  recovery_started_at: null,
                })
                .where(
                  and(
                    eq(SessionExecutionOwnerTable.session_id, token.sessionID),
                    eq(SessionExecutionOwnerTable.owner_id, token.ownerID),
                    eq(SessionExecutionOwnerTable.generation, token.generation),
                  ),
                )
                .returning({ sessionID: SessionExecutionOwnerTable.session_id })
                .get()
                .pipe(Effect.orDie)
              return released ? ("released" as const) : ("stale" as const)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (result !== "continue") yield* releaseRetention(token)
      return result
    })

    const release = Effect.fn("SessionExecutionOwner.release")(function* (token: Token) {
      const released = yield* db
        .transaction(
          (tx) =>
            tx
              .update(SessionExecutionOwnerTable)
              .set({
                owner_id: null,
                acquired_at: null,
                interrupt_generation: null,
                interrupt_reason: null,
                interrupt_requested_at: null,
                recovery_owner_id: null,
                recovery_started_at: null,
              })
              .where(
                and(
                  eq(SessionExecutionOwnerTable.session_id, token.sessionID),
                  eq(SessionExecutionOwnerTable.owner_id, token.ownerID),
                  eq(SessionExecutionOwnerTable.generation, token.generation),
                ),
              )
              .returning({ sessionID: SessionExecutionOwnerTable.session_id })
              .get()
              .pipe(Effect.orDie),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      yield* releaseRetention(token)
      return released ? ("released" as const) : ("stale" as const)
    })

    const requestInterrupt = Effect.fn("SessionExecutionOwner.requestInterrupt")(function* (
      sessionID: SessionSchema.ID,
      reason: InterruptReason,
    ) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(SessionExecutionOwnerTable)
                .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
                .get()
                .pipe(Effect.orDie)
              const token = row && tokenOf(row)
              if (!row || !token) return { state: "idle" as const }
              const interruptGeneration = (row.interrupt_generation ?? 0) + 1
              const requestedAt = Date.now()
              const updated = yield* tx
                .update(SessionExecutionOwnerTable)
                .set({
                  interrupt_generation: interruptGeneration,
                  interrupt_reason: reason,
                  interrupt_requested_at: requestedAt,
                })
                .where(
                  and(
                    eq(SessionExecutionOwnerTable.session_id, sessionID),
                    eq(SessionExecutionOwnerTable.owner_id, token.ownerID),
                    eq(SessionExecutionOwnerTable.generation, token.generation),
                  ),
                )
                .returning({ sessionID: SessionExecutionOwnerTable.session_id })
                .get()
                .pipe(Effect.orDie)
              if (!updated) return { state: "idle" as const }

              const owner = yield* tx
                .select({ controlEpoch: RuntimeOwnerTable.control_epoch })
                .from(RuntimeOwnerTable)
                .where(eq(RuntimeOwnerTable.id, token.ownerID))
                .get()
                .pipe(Effect.orDie)
              if (owner)
                yield* tx
                  .update(RuntimeOwnerTable)
                  .set({ control_epoch: owner.controlEpoch + 1 })
                  .where(eq(RuntimeOwnerTable.id, token.ownerID))
                  .run()
                  .pipe(Effect.orDie)

              return {
                state: "requested" as const,
                token,
                interruptGeneration,
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    return Service.of({
      tryAcquire,
      releaseIfDrained,
      release,
      snapshot,
      requestInterrupt,
      tryClaimRecovery,
      completeRecovery,
      abandonRecovery,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, RuntimeOwner.node],
})
