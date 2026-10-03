export * as SessionExecutionOwner from "./execution-owner"

import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm"
import { Context, Effect, Layer, Semaphore } from "effect"
import { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import {
  existingDirectoryKey,
  type AcquisitionID as DirectoryGuardAcquisitionID,
  type BlockedDirectory as DirectoryGuardBlockedDirectory,
  type DirectoryKey as DirectoryGuardDirectoryKey,
} from "../directory-maintenance-guard"
import { DirectoryMaintenanceGuardTable } from "../directory-maintenance-guard.sql"
import { DirectoryActivityLeaseTable } from "../directory-activity-lease.sql"
import { makeGlobalNode } from "../effect/app-node"
import { RuntimeOwner } from "../runtime-owner"
import { RuntimeOwnerTable } from "../runtime-owner.sql"
import { SessionExecutionOwnerTable } from "./execution-owner.sql"
import { SessionSchema } from "./schema"
import { PartTable, SessionInputTable, SessionMessageTable, SessionMessageToolOverlayTable, SessionTable } from "./sql"

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

export type MaintenanceBlockedReason =
  | "guard-active"
  | "guard-reconcile-required"
  | "directory-unresolvable"
  | "session-missing"

export interface MaintenanceBlocked {
  readonly state: "maintenance-blocked"
  readonly reason: MaintenanceBlockedReason
  readonly sessionID: SessionSchema.ID
  readonly directory: string | null
  readonly directoryKey: DirectoryGuardDirectoryKey | null
  readonly guards: ReadonlyArray<DirectoryGuardBlockedDirectory>
}

export type AcquireResult =
  | { readonly state: "acquired"; readonly token: Token }
  | { readonly state: "busy"; readonly snapshot: Snapshot }
  | MaintenanceBlocked

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
  /** Process-local admission with one shared activation marker per Session generation. */
  readonly tryAcquireLocal: (sessionID: SessionSchema.ID) => Effect.Effect<AcquireResult>
  /** Exact local activation token, when this process currently owns one. */
  readonly localActivation: (sessionID: SessionSchema.ID) => Effect.Effect<Token | undefined>
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
  /** Global, storage-backed working-session projection; never enters a Location. */
  readonly listWorking: () => Effect.Effect<ReadonlyMap<SessionSchema.ID, { readonly type: "busy" }>>
  readonly listWorkingByDirectory: (directory: string) => Effect.Effect<ReadonlyMap<SessionSchema.ID, { readonly type: "busy" }>>
  /** Intersect known non-idle status candidates with one durable directory. */
  readonly listSessionIDsByDirectory: (
    directory: string,
    candidates: readonly SessionSchema.ID[],
  ) => Effect.Effect<SessionSchema.ID[]>
  readonly requestInterrupt: (
    sessionID: SessionSchema.ID,
    reason: InterruptReason,
    expectedGeneration?: number,
  ) => Effect.Effect<
    | { readonly state: "idle" }
    | { readonly state: "stale"; readonly snapshot: Snapshot }
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

// RuntimeOwner heartbeats are emitted every 30 seconds. Require three missed
// beats before process-death probing can authorize any lease recovery.
export const RUNTIME_OWNER_STALE_AFTER_MS = RuntimeOwner.HEARTBEAT_INTERVAL_MS * 3

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

/**
 * Startup-only lease reconciliation. Scan candidates in bounded 128-row pages
 * and clear execution authority only when both heartbeat and local process
 * identity prove the owner dead. Durable in-flight tool effects keep their
 * generation fenced for explicit reconciliation.
 */
export const reconcileDeadOwnersAtStartup = Effect.fn("SessionExecutionOwner.reconcileDeadOwnersAtStartup")(
  function* (db: Database.Interface["db"], readDb: Database.Interface["readDb"], runtime: RuntimeOwner.Interface) {
    let reclaimed = 0
    let cursor: string | undefined
    const staleBefore = Date.now() - RUNTIME_OWNER_STALE_AFTER_MS
    // A process owner can own many Sessions. Its immutable incarnation ID and
    // PID death proof are shared evidence, so read/probe each owner once per
    // sweep instead of repeating two SQLite lookups for every owned Session.
    const ownerLiveness = new Map<
      RuntimeOwner.ID,
      { readonly owner: RuntimeOwner.Snapshot | undefined; proof?: RuntimeOwner.LocalDeathProof }
    >()
    const inspectOwner = Effect.fnUntraced(function* (ownerID: RuntimeOwner.ID) {
      let state = ownerLiveness.get(ownerID)
      if (!state) {
        state = { owner: yield* runtime.snapshot(ownerID) }
        ownerLiveness.set(ownerID, state)
      }
      if (
        state.owner &&
        !state.proof &&
        Date.now() - state.owner.heartbeatAt >= RUNTIME_OWNER_STALE_AFTER_MS
      ) {
        state.proof = yield* runtime.proveLocalDeath(ownerID)
      }
      return state
    })
    const staleOwners = readDb
      .select({ id: RuntimeOwnerTable.id })
      .from(RuntimeOwnerTable)
      .where(lte(RuntimeOwnerTable.heartbeat_at, staleBefore))
    for (;;) {
      const page = yield* readDb
        .select()
        .from(SessionExecutionOwnerTable)
        .where(
          and(
            isNotNull(SessionExecutionOwnerTable.owner_id),
            inArray(SessionExecutionOwnerTable.owner_id, staleOwners),
            cursor ? gt(SessionExecutionOwnerTable.session_id, cursor) : undefined,
          ),
        )
        .orderBy(asc(SessionExecutionOwnerTable.session_id))
        .limit(128)
        .all()
        .pipe(Effect.orDie)
      if (page.length === 0) break
      // Advance before mutating owner_id so cleared rows cannot shift the next
      // page and hide later sessions (OFFSET pagination is unsafe here).
      cursor = page[page.length - 1]!.session_id
      const candidates: typeof page = []
      for (const row of page) {
        if (!row.owner_id) continue
        const ownerID = row.owner_id as RuntimeOwner.ID
        const owner = yield* inspectOwner(ownerID)
        if (!owner.owner || Date.now() - owner.owner.heartbeatAt < RUNTIME_OWNER_STALE_AFTER_MS) continue
        if (owner.proof !== "dead") continue

        if (row.recovery_owner_id) {
          const recoveryOwnerID = row.recovery_owner_id as RuntimeOwner.ID
          const recoveryOwner = yield* inspectOwner(recoveryOwnerID)
          if (
            !recoveryOwner.owner ||
            Date.now() - recoveryOwner.owner.heartbeatAt < RUNTIME_OWNER_STALE_AFTER_MS
          )
            continue
          if (recoveryOwner.proof !== "dead") continue
        }
        candidates.push(row)
      }

      // Tool-effect fencing is a per-session fact, but startup discovers it
      // for a bounded page. Batch these indexed lookups so dead-owner recovery
      // does not issue two round trips per candidate session.
      const candidateIDs = candidates.map((row) => SessionSchema.ID.make(row.session_id))
      const sessionsWithCurrentTools = new Set<string>(
        candidateIDs.length === 0
          ? []
          : (yield* readDb
              .selectDistinct({ sessionID: SessionMessageTable.session_id })
              .from(SessionMessageTable)
              .innerJoin(
                SessionMessageToolOverlayTable,
                eq(SessionMessageToolOverlayTable.message_id, SessionMessageTable.id),
              )
              .where(
                and(
                  inArray(SessionMessageTable.session_id, candidateIDs),
                  eq(SessionMessageTable.type, "assistant"),
                  isNull(SessionMessageToolOverlayTable.settlement_event_id),
                ),
              )
              .all()
              .pipe(Effect.orDie)).map((row) => row.sessionID),
      )
      const sessionsWithLegacyTools = new Set<string>(
        candidateIDs.length === 0
          ? []
          : (yield* readDb
              .selectDistinct({ sessionID: PartTable.session_id })
              .from(PartTable)
              .where(
                and(
                  inArray(PartTable.session_id, candidateIDs),
                  sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
                  sql`json_extract(${PartTable.data}, '$.state.status') IN ('pending', 'running')`,
                ),
              )
              .all()
              .pipe(Effect.orDie)).map((row) => row.sessionID),
      )

      for (const row of candidates) {
        if (sessionsWithCurrentTools.has(row.session_id) || sessionsWithLegacyTools.has(row.session_id)) continue
        const ownerID = row.owner_id as RuntimeOwner.ID

        const ownerCondition =
          row.recovery_owner_id === null
            ? isNull(SessionExecutionOwnerTable.recovery_owner_id)
            : eq(SessionExecutionOwnerTable.recovery_owner_id, row.recovery_owner_id)
        const cleared = yield* db
          .transaction(
            (tx) =>
              tx
                .update(SessionExecutionOwnerTable)
                .set({
                  owner_id: null,
                  acquired_at: null,
                  // The generation is being abandoned; its execution-end fact is
                  // no longer attributable to anything still owned.
                  interrupt_generation: null,
                  interrupt_reason: null,
                  interrupt_requested_at: null,
                  recovery_owner_id: null,
                  recovery_started_at: null,
                })
                .where(
                  and(
                    eq(SessionExecutionOwnerTable.session_id, row.session_id),
                    eq(SessionExecutionOwnerTable.owner_id, ownerID),
                    eq(SessionExecutionOwnerTable.generation, row.generation),
                    ownerCondition,
                  ),
                )
              .returning({ sessionID: SessionExecutionOwnerTable.session_id })
              .get()
              .pipe(Effect.orDie),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        if (cleared) reclaimed++
      }
      if (page.length === 128) yield* Effect.yieldNow
    }
    yield* collectDeadRuntimeOwners(db, readDb, runtime)
    return reclaimed
  },
)

const collectDeadRuntimeOwners = Effect.fn("SessionExecutionOwner.collectDeadRuntimeOwners")(
  function* (db: Database.Interface["db"], readDb: Database.Interface["readDb"], runtime: RuntimeOwner.Interface) {
    let cursor: string | undefined
    const staleBefore = Date.now() - RUNTIME_OWNER_STALE_AFTER_MS
    for (;;) {
      const owners = yield* readDb
        .select()
        .from(RuntimeOwnerTable)
        .where(
          and(
            lte(RuntimeOwnerTable.heartbeat_at, staleBefore),
            cursor ? gt(RuntimeOwnerTable.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(RuntimeOwnerTable.id))
        .limit(128)
        .all()
        .pipe(Effect.orDie)
      if (owners.length === 0) break
      cursor = owners[owners.length - 1]!.id
      const ownerIDs = owners.map((owner) => owner.id)
      const referencedOwnerIDs = new Set<string>([
        ...(yield* readDb
          .selectDistinct({ ownerID: SessionExecutionOwnerTable.owner_id })
          .from(SessionExecutionOwnerTable)
          .where(
            or(
              inArray(SessionExecutionOwnerTable.owner_id, ownerIDs),
              inArray(SessionExecutionOwnerTable.recovery_owner_id, ownerIDs),
            ),
          )
          .all()
          .pipe(Effect.orDie)).flatMap((row) => [row.ownerID].filter((value): value is string => value !== null)),
        ...(yield* readDb
          .selectDistinct({ ownerID: DirectoryMaintenanceGuardTable.owner_id })
          .from(DirectoryMaintenanceGuardTable)
          .where(inArray(DirectoryMaintenanceGuardTable.owner_id, ownerIDs))
          .all()
          .pipe(Effect.orDie)).map((row) => row.ownerID),
        ...(yield* readDb
          .selectDistinct({ ownerID: DirectoryActivityLeaseTable.owner_id })
          .from(DirectoryActivityLeaseTable)
          .where(inArray(DirectoryActivityLeaseTable.owner_id, ownerIDs))
          .all()
          .pipe(Effect.orDie)).map((row) => row.ownerID),
      ])
      for (const owner of owners) {
        if (referencedOwnerIDs.has(owner.id)) continue
        if (Date.now() - owner.heartbeat_at < RUNTIME_OWNER_STALE_AFTER_MS) continue
        if ((yield* runtime.proveLocalDeath(owner.id as RuntimeOwner.ID)) !== "dead") continue
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                // The reference scan above uses the read connection and is only
                // an optimization. Re-check under the writer reservation so a
                // concurrent owner reference cannot race this delete into a
                // foreign-key failure.
                const referenced =
                  (yield* tx
                    .select({ ownerID: SessionExecutionOwnerTable.owner_id })
                    .from(SessionExecutionOwnerTable)
                    .where(
                      or(
                        eq(SessionExecutionOwnerTable.owner_id, owner.id),
                        eq(SessionExecutionOwnerTable.recovery_owner_id, owner.id),
                      ),
                    )
                    .limit(1)
                    .get()
                    .pipe(Effect.orDie)) !== undefined ||
                  (yield* tx
                    .select({ ownerID: DirectoryMaintenanceGuardTable.owner_id })
                    .from(DirectoryMaintenanceGuardTable)
                    .where(eq(DirectoryMaintenanceGuardTable.owner_id, owner.id))
                    .limit(1)
                    .get()
                    .pipe(Effect.orDie)) !== undefined ||
                  (yield* tx
                    .select({ ownerID: DirectoryActivityLeaseTable.owner_id })
                    .from(DirectoryActivityLeaseTable)
                    .where(eq(DirectoryActivityLeaseTable.owner_id, owner.id))
                    .limit(1)
                    .get()
                    .pipe(Effect.orDie)) !== undefined
                if (referenced) return

                yield* tx
                  .delete(RuntimeOwnerTable)
                  .where(
                    and(
                      eq(RuntimeOwnerTable.id, owner.id),
                      eq(RuntimeOwnerTable.pid, owner.pid),
                      eq(RuntimeOwnerTable.started_at, owner.started_at),
                      eq(RuntimeOwnerTable.heartbeat_at, owner.heartbeat_at),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }
      if (owners.length === 128) yield* Effect.yieldNow
    }
  },
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const runtime = yield* RuntimeOwner.Service
    const retentions = new Map<string, RuntimeOwner.Retention>()
    const recoveryRetentions = new Map<string, RuntimeOwner.Retention>()
    const recoveryLock = Semaphore.makeUnsafe(1)
    const activationLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
    const activations = new Map<SessionSchema.ID, Token>()
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

    // Finalize the retain -> durable owner publication boundary. If an
    // interruption lands after the Session owner row commits but before the
    // in-memory retention transfer, adopt the retention from durable exact
    // owner state. Otherwise release it exactly once.
    const reconcileAcquireExitRetention = Effect.fn("SessionExecutionOwner.reconcileAcquireExitRetention")(
      function* (sessionID: SessionSchema.ID, retention: RuntimeOwner.Retention) {
        const row = yield* readDb
          .select()
          .from(SessionExecutionOwnerTable)
          .where(eq(SessionExecutionOwnerTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        const token = row ? tokenOf(row) : undefined
        if (token?.ownerID === runtime.id) {
          const key = tokenKey(token)
          if (retentions.has(key)) {
            yield* retention.release
            return
          }
          retentions.set(key, retention)
          return
        }
        yield* retention.release
      },
    )

    const clearLocalActivation = Effect.fn("SessionExecutionOwner.clearLocalActivation")(function* (token: Token) {
      const active = activations.get(token.sessionID)
      if (active?.ownerID === token.ownerID && active.generation === token.generation) {
        activations.delete(token.sessionID)
      }
    })

    const localActivation = Effect.fn("SessionExecutionOwner.localActivation")(function* (sessionID: SessionSchema.ID) {
      return activations.get(sessionID)
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

    yield* reconcileDeadOwnersAtStartup(db, readDb, runtime)


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
            const previousRecoveryRuntime = yield* runtime.snapshot(previousRecoveryOwnerID)
            if (
              !previousRecoveryRuntime ||
              Date.now() - previousRecoveryRuntime.heartbeatAt < RUNTIME_OWNER_STALE_AFTER_MS
            ) {
              yield* retention.release
              return { state: "busy" as const, snapshot: yield* hydrateSnapshot(row) }
            }
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

          const ownerRuntime = yield* runtime.snapshot(observed.ownerID)
          if (!ownerRuntime || Date.now() - ownerRuntime.heartbeatAt < RUNTIME_OWNER_STALE_AFTER_MS) {
            yield* retention.release
            return {
              state: "blocked" as const,
              proof: "alive-or-unknown" as const,
              snapshot: yield* hydrateSnapshot(row),
            }
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
      let transferred = false
      return yield* Effect.acquireUseRelease(
        // Ensure the RuntimeOwner FK target exists and keep its one process
        // heartbeat alive before publishing durable Session ownership.
        runtime.retain,
        (retention) =>
          Effect.gen(function* () {
            const result = yield* db
              .transaction(
                (tx) =>
                  Effect.gen(function* () {
                    // Maintenance authority has precedence over ordinary busy
                    // ownership so callers can never route a live maintenance
                    // fence into dead-owner recovery.
                    const session = yield* tx
                      .select({ directory: SessionTable.directory })
                      .from(SessionTable)
                      .where(eq(SessionTable.id, sessionID))
                      .get()
                      .pipe(Effect.orDie)
                    if (!session) {
                      return {
                        state: "maintenance-blocked" as const,
                        reason: "session-missing" as const,
                        sessionID,
                        directory: null,
                        directoryKey: null,
                        guards: [] as ReadonlyArray<DirectoryGuardBlockedDirectory>,
                      }
                    }

                    // Ordinary execution does not pay for physical filesystem
                    // canonicalization while no maintenance authority exists.
                    // This is race-safe because this IMMEDIATE transaction
                    // excludes guard publication until admission commits, and
                    // guard.acquire symmetrically checks active execution.
                    const anyHeldGuard = yield* tx
                      .select({ directory: DirectoryMaintenanceGuardTable.directory })
                      .from(DirectoryMaintenanceGuardTable)
                      .where(ne(DirectoryMaintenanceGuardTable.state, "released"))
                      .limit(1)
                      .get()
                      .pipe(Effect.orDie)
                    if (anyHeldGuard) {
                      const directoryKey = existingDirectoryKey(session.directory)
                      if (directoryKey === undefined) {
                        return {
                          state: "maintenance-blocked" as const,
                          reason: "directory-unresolvable" as const,
                          sessionID,
                          directory: session.directory,
                          directoryKey: null,
                          guards: [] as ReadonlyArray<DirectoryGuardBlockedDirectory>,
                        }
                      }

                      const guard = yield* tx
                        .select()
                        .from(DirectoryMaintenanceGuardTable)
                        .where(
                          and(
                            eq(DirectoryMaintenanceGuardTable.directory, directoryKey),
                            ne(DirectoryMaintenanceGuardTable.state, "released"),
                          ),
                        )
                        .get()
                        .pipe(Effect.orDie)
                      if (guard) {
                        const blocked: DirectoryGuardBlockedDirectory = {
                          directory: guard.directory as DirectoryGuardDirectoryKey,
                          guardId: guard.guard_id,
                          ownerID: guard.owner_id as RuntimeOwner.ID,
                          acquisitionId: guard.acquisition_id as DirectoryGuardAcquisitionID,
                          generation: guard.generation,
                          state: guard.state as DirectoryGuardBlockedDirectory["state"],
                        }
                        return {
                          state: "maintenance-blocked" as const,
                          reason:
                            guard.state === "reconcile_required"
                              ? ("guard-reconcile-required" as const)
                              : ("guard-active" as const),
                          sessionID,
                          directory: session.directory,
                          directoryKey,
                          guards: [blocked],
                        }
                      }
                    }

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
                      if (!inserted)
                        return yield* Effect.die("Failed to acquire Session execution owner for " + sessionID)
                      return { state: "acquired" as const, row: inserted }
                    }

                    const updated = yield* tx
                      .update(SessionExecutionOwnerTable)
                      .set({
                        generation: existing.generation + 1,
                        owner_id: runtime.id,
                        acquired_at: now,
                        // A new generation has not completed anything yet. Without
                        // this, a stale marker could be read as proof for it.
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

            if (result.state === "maintenance-blocked") return result
            if (result.state === "busy") {
              return { state: "busy" as const, snapshot: yield* hydrateSnapshot(result.row) }
            }
            const token = tokenOf(result.row)
            if (!token) return yield* Effect.die("Acquired Session execution row is unexpectedly idle for " + sessionID)
            retentions.set(tokenKey(token), retention)
            transferred = true
            return { state: "acquired" as const, token }
          }),
        (retention) =>
          Effect.suspend(() =>
            transferred ? Effect.void : reconcileAcquireExitRetention(sessionID, retention),
          ).pipe(Effect.uninterruptible),
      )
    })

    const tryAcquireLocal = Effect.fn("SessionExecutionOwner.tryAcquireLocal")(function* (sessionID: SessionSchema.ID) {
      return yield* activationLocks.withLock(sessionID)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const active = activations.get(sessionID)
            if (active) {
              const current = yield* snapshot(sessionID)
              if (current.ownerID === active.ownerID && current.generation === active.generation) {
                return { state: "busy" as const, snapshot: current }
              }
              activations.delete(sessionID)
            }

            let acquired = yield* tryAcquire(sessionID)
            if (acquired.state === "busy" && acquired.snapshot.ownerID === runtime.id) {
              yield* Effect.logWarning("Recovering orphaned local Session execution owner", {
                sessionID,
                generation: acquired.snapshot.generation,
                acquiredAt: acquired.snapshot.acquiredAt,
                interruptRequestedAt: acquired.snapshot.interruptRequestedAt,
              })
              yield* release({
                sessionID,
                ownerID: runtime.id,
                generation: acquired.snapshot.generation,
              })
              acquired = yield* tryAcquire(sessionID)
            }

            if (acquired.state === "acquired") activations.set(sessionID, acquired.token)
            return acquired
          }),
        ),
      )
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
              if (pending) {
                // The SAME generation is about to execute again. The consumed
                // watermark is deliberately NOT cleared: it is monotonic truth
                // about what a successful cycle already drained, and input below
                // it does not become unprocessed just because more work arrived.
                return "continue" as const
              }

              const released = yield* tx
                .update(SessionExecutionOwnerTable)
                .set({
                  owner_id: null,
                  acquired_at: null,
                  // A released generation owns nothing, so its completion fact
                  // is no longer attributable to anything.
                  interrupt_generation: null,
                  interrupt_reason: null,
                  interrupt_requested_at: null,
                })
                .where(
                  and(
                    eq(SessionExecutionOwnerTable.session_id, token.sessionID),
                    eq(SessionExecutionOwnerTable.owner_id, token.ownerID),
                    eq(SessionExecutionOwnerTable.generation, token.generation),
                    isNull(SessionExecutionOwnerTable.recovery_owner_id),
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
      if (result !== "continue") {
        yield* releaseRetention(token)
        yield* clearLocalActivation(token)
      }
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
              })
              .where(
                and(
                  eq(SessionExecutionOwnerTable.session_id, token.sessionID),
                  eq(SessionExecutionOwnerTable.owner_id, token.ownerID),
                  eq(SessionExecutionOwnerTable.generation, token.generation),
                  isNull(SessionExecutionOwnerTable.recovery_owner_id),
                ),
              )
              .returning({ sessionID: SessionExecutionOwnerTable.session_id })
              .get()
              .pipe(Effect.orDie),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      yield* releaseRetention(token)
      yield* clearLocalActivation(token)
      return released ? ("released" as const) : ("stale" as const)
    })

    const requestInterrupt = Effect.fn("SessionExecutionOwner.requestInterrupt")(function* (
      sessionID: SessionSchema.ID,
      reason: InterruptReason,
      expectedGeneration?: number,
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
              if (expectedGeneration !== undefined && token.generation !== expectedGeneration) {
                return { state: "stale" as const, snapshot: snapshotOf(row) }
              }
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

    const listWorking = Effect.fn("SessionExecutionOwner.listWorking")(function* () {
      const rows = yield* readDb
        .select({ sessionID: SessionExecutionOwnerTable.session_id })
        .from(SessionExecutionOwnerTable)
        .where(isNotNull(SessionExecutionOwnerTable.owner_id))
        .all()
        .pipe(Effect.orDie)
      return new Map(rows.map((row) => [SessionSchema.ID.make(row.sessionID), { type: "busy" as const }]))
    })

    const listWorkingByDirectory = Effect.fn("SessionExecutionOwner.listWorkingByDirectory")(function* (directory: string) {
      const rows = yield* readDb
        .select({ sessionID: SessionExecutionOwnerTable.session_id })
        .from(SessionExecutionOwnerTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionExecutionOwnerTable.session_id))
        .where(and(eq(SessionTable.directory, directory), isNotNull(SessionExecutionOwnerTable.owner_id)))
        .all()
        .pipe(Effect.orDie)
      return new Map(rows.map((row) => [SessionSchema.ID.make(row.sessionID), { type: "busy" as const }]))
    })

    const listSessionIDsByDirectory = Effect.fn("SessionExecutionOwner.listSessionIDsByDirectory")(function* (
      directory: string,
      candidates: readonly SessionSchema.ID[],
    ) {
      if (candidates.length === 0) return []
      const rows: { sessionID: string }[] = []
      for (let offset = 0; offset < candidates.length; offset += 500) {
        const page = yield* readDb
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(
            and(
              eq(SessionTable.directory, directory),
              inArray(SessionTable.id, [...candidates.slice(offset, offset + 500)]),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        rows.push(...page)
      }
      return rows.map((row) => SessionSchema.ID.make(row.sessionID))
    })

    return Service.of({
      tryAcquire,
      tryAcquireLocal,
      localActivation,
      releaseIfDrained,
      release,
      snapshot,
      listWorking,
      listWorkingByDirectory,
      listSessionIDsByDirectory,
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
