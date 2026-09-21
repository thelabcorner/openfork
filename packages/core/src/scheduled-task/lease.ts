export * as ScheduledTaskLease from "./lease"

import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { hydrateRun } from "./projection"
import { ScheduledTaskLeaseTable, ScheduledTaskRunTable, ScheduledTaskTable } from "./sql"

/** Heartbeat cadence for one active run (never per idle task). */
export const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Lease TTL must comfortably exceed the heartbeat interval. A lease whose
 * heartbeat is older than this is reclaimed: its owner is gone or wedged.
 */
export const LEASE_TTL_MS = 150_000

/**
 * Module-scoped rather than layer-scoped: V1 and V2 runtimes in the same
 * process must identify as one execution owner so they cannot both reclaim the
 * same lease. A restarted process gets a fresh id, and its predecessor's
 * leases are reclaimed by heartbeat staleness — NOT by identity, because two
 * processes can legitimately share one database (T0 decision 2).
 */
export const PROCESS_OWNER_ID = `scheduled-owner:${process.pid}:${crypto.randomUUID()}`

export interface Lease {
  readonly taskID: ScheduledTask.ID
  readonly fireFor: number
  readonly leaseID: string
  readonly attempt: number
}

export interface Interface {
  readonly ownerID: string
  /**
   * Claim exactly one firing attempt. The database adjudicates the race: an
   * unowned lease row is claimed with a conditional UPDATE, and a fresh claim
   * is an INSERT that loses cleanly on the task_id primary key.
   */
  readonly claim: (input: {
    readonly taskID: ScheduledTask.ID
    readonly fireFor: number
    readonly now: number
  }) => Effect.Effect<Lease | undefined>
  /** Extends a held lease. Returns false when ownership was lost. */
  readonly heartbeat: (input: { readonly leaseID: string; readonly now: number }) => Effect.Effect<boolean>
  /** Deletes a held lease immediately (terminal settlement or abort). */
  readonly release: (input: { readonly leaseID: string }) => Effect.Effect<void>
  /**
   * Converts a held lease into a pending retry: owner is cleared, attempt is
   * incremented, and the task cursor is moved to `nextAttemptAt`. The logical
   * `fire_for` stays attached so the run row is updated, never duplicated.
   */
  readonly scheduleRetry: (input: {
    readonly leaseID: string
    readonly nextAttemptAt: number
    readonly now: number
  }) => Effect.Effect<void>
  /**
   * Reclaims leases whose heartbeat is stale. `includeOwn` additionally
   * reclaims leases owned by this process: correct at construction (no live
   * run can exist yet), unsafe for a periodic sweep because same-process
   * runtimes share one owner id and must never steal a live lease.
   */
  readonly recoverStale: (input: {
    readonly now: number
    readonly includeOwn?: boolean
  }) => Effect.Effect<
    ReadonlyArray<{
      readonly taskID: ScheduledTask.ID
      readonly fireFor: number
      readonly run?: ScheduledTask.Run
    }>
  >
  /** Leases currently held by this process (N7 teardown assertion). */
  readonly held: () => Effect.Effect<ReadonlyArray<Lease>>
  readonly activeCount: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ScheduledTaskLease") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service

    const claim = Effect.fn("ScheduledTaskLease.claim")(function* (input: {
      taskID: ScheduledTask.ID
      fireFor: number
      now: number
    }) {
      const existing = yield* db
        .select()
        .from(ScheduledTaskLeaseTable)
        .where(eq(ScheduledTaskLeaseTable.task_id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (existing && existing.owner !== null) return undefined

      if (existing) {
        // Pending retry or recovered orphan: take it over without touching the
        // logical instant or the attempt counter.
        const claimed = yield* db
          .update(ScheduledTaskLeaseTable)
          .set({ owner: PROCESS_OWNER_ID, heartbeat_at: input.now })
          .where(and(eq(ScheduledTaskLeaseTable.task_id, input.taskID), isNull(ScheduledTaskLeaseTable.owner)))
          .returning()
          .get()
          .pipe(Effect.orDie)
        return claimed ? toLease(claimed) : undefined
      }

      const leaseID = crypto.randomUUID()
      const inserted = yield* db
        .insert(ScheduledTaskLeaseTable)
        .values({
          task_id: input.taskID,
          fire_for: input.fireFor,
          lease_id: leaseID,
          owner: PROCESS_OWNER_ID,
          acquired_at: input.now,
          heartbeat_at: input.now,
          attempt: 1,
        })
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      return inserted ? toLease(inserted) : undefined
    })

    const heartbeat = Effect.fn("ScheduledTaskLease.heartbeat")(function* (input: {
      leaseID: string
      now: number
    }) {
      const updated = yield* db
        .update(ScheduledTaskLeaseTable)
        .set({ heartbeat_at: input.now })
        .where(
          and(
            eq(ScheduledTaskLeaseTable.lease_id, input.leaseID),
            eq(ScheduledTaskLeaseTable.owner, PROCESS_OWNER_ID),
          ),
        )
        .returning({ lease_id: ScheduledTaskLeaseTable.lease_id })
        .get()
        .pipe(Effect.orDie)
      return updated !== undefined
    })

    const release = Effect.fn("ScheduledTaskLease.release")(function* (input: { leaseID: string }) {
      yield* db
        .delete(ScheduledTaskLeaseTable)
        .where(
          and(
            eq(ScheduledTaskLeaseTable.lease_id, input.leaseID),
            eq(ScheduledTaskLeaseTable.owner, PROCESS_OWNER_ID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const scheduleRetry = Effect.fn("ScheduledTaskLease.scheduleRetry")(function* (input: {
      leaseID: string
      nextAttemptAt: number
      now: number
    }) {
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
            const row = yield* tx
              .update(ScheduledTaskLeaseTable)
              .set({
                owner: null,
                attempt: sql`${ScheduledTaskLeaseTable.attempt} + 1`,
                heartbeat_at: input.now,
              })
              .where(
                and(
                  eq(ScheduledTaskLeaseTable.lease_id, input.leaseID),
                  eq(ScheduledTaskLeaseTable.owner, PROCESS_OWNER_ID),
                ),
              )
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!row) return
            yield* tx
              .update(ScheduledTaskTable)
              .set({ next_run_at: input.nextAttemptAt, time_updated: input.now })
              .where(eq(ScheduledTaskTable.id, row.task_id))
              .run()
              .pipe(Effect.orDie)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const recoverStale = Effect.fn("ScheduledTaskLease.recoverStale")(function* (input: {
      now: number
      includeOwn?: boolean
    }) {
      const staleAt = input.now - LEASE_TTL_MS
      const stale = lt(ScheduledTaskLeaseTable.heartbeat_at, staleAt)
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
            // Discovery and reclamation must share the same writer transaction.
            // Reading candidate leases before BEGIN IMMEDIATE creates a TOCTOU
            // window where a live owner can heartbeat after discovery but before
            // the recovery write. Re-evaluate the stale predicate under the
            // writer reservation and condition every mutation on the exact lease
            // identity/owner/heartbeat observed.
            const rows = yield* tx
              .select()
              .from(ScheduledTaskLeaseTable)
              .where(
                and(
                  isNotNull(ScheduledTaskLeaseTable.owner),
                  input.includeOwn
                    ? or(eq(ScheduledTaskLeaseTable.owner, PROCESS_OWNER_ID), stale)
                    : stale,
                ),
              )
              .all()
              .pipe(Effect.orDie)
            const reclaimed: Array<{
              taskID: ScheduledTask.ID
              fireFor: number
              run?: ScheduledTask.Run
            }> = []
            for (const row of rows) {
              const recovered = yield* tx
                .update(ScheduledTaskLeaseTable)
                .set({
                  owner: null,
                  attempt: sql`${ScheduledTaskLeaseTable.attempt} + 1`,
                  heartbeat_at: input.now,
                })
                .where(
                  and(
                    eq(ScheduledTaskLeaseTable.task_id, row.task_id),
                    eq(ScheduledTaskLeaseTable.owner, row.owner!),
                    eq(ScheduledTaskLeaseTable.lease_id, row.lease_id),
                    eq(ScheduledTaskLeaseTable.heartbeat_at, row.heartbeat_at),
                  ),
                )
                .returning({ task_id: ScheduledTaskLeaseTable.task_id })
                .get()
                .pipe(Effect.orDie)
              if (!recovered) continue
              const abandoned = yield* tx
                .update(ScheduledTaskRunTable)
                .set({
                  status: "abandoned",
                  finished_at: input.now,
                  acknowledged_at: input.now,
                  error_kind: sql`coalesce(${ScheduledTaskRunTable.error_kind}, 'internal')`,
                  error_message: "run abandoned: lease heartbeat expired",
                })
                .where(
                  and(
                    eq(ScheduledTaskRunTable.task_id, row.task_id),
                    eq(ScheduledTaskRunTable.fire_for, row.fire_for),
                    eq(ScheduledTaskRunTable.attempt, row.attempt),
                    inArray(ScheduledTaskRunTable.status, ["running", "waiting"]),
                  ),
                )
                .returning()
                .get()
                .pipe(Effect.orDie)
              reclaimed.push({
                taskID: row.task_id,
                fireFor: row.fire_for,
                ...(abandoned ? { run: hydrateRun(abandoned) } : {}),
              })
            }
            return reclaimed
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const held = Effect.fn("ScheduledTaskLease.held")(function* () {
      const rows = yield* readDb
        .select()
        .from(ScheduledTaskLeaseTable)
        .where(eq(ScheduledTaskLeaseTable.owner, PROCESS_OWNER_ID))
        .all()
        .pipe(Effect.orDie)
      return rows.map(toLease)
    })

    const activeCount = Effect.fn("ScheduledTaskLease.activeCount")(function* () {
      const rows = yield* readDb
        .select({ count: sql<number>`count(*)` })
        .from(ScheduledTaskLeaseTable)
        .where(eq(ScheduledTaskLeaseTable.owner, PROCESS_OWNER_ID))
        .get()
        .pipe(Effect.orDie)
      return rows?.count ?? 0
    })

    return Service.of({ ownerID: PROCESS_OWNER_ID, claim, heartbeat, release, scheduleRetry, recoverStale, held, activeCount })
  }),
)

function toLease(row: typeof ScheduledTaskLeaseTable.$inferSelect): Lease {
  return {
    taskID: row.task_id,
    fireFor: row.fire_for,
    leaseID: row.lease_id,
    attempt: row.attempt,
  }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
