import { and, asc, count, eq, inArray, lte } from "drizzle-orm"
import { Effect } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import type { DatabaseShape } from "../database/database"
import { hydrateInfo } from "./projection"
import { SwarmMemberTable, SwarmTable, SwarmTaskLeaseTable, SwarmTaskTable } from "./sql"

type Db = DatabaseShape

/**
 * A `creating` Swarm that has not advanced past aggregate creation.
 *
 * `Swarm.create` durably inserts `status = "creating"`; promotion to `active`
 * happens in a later, separate transaction. A crash between the two leaves an
 * inert row with no coordinator, no members, and no work. Nothing else in the
 * runtime promotes or retires it, so it would otherwise stay `creating` forever.
 *
 * This projection is read-only and bootstrap-free. Closure itself reuses the
 * ordinary revision-CAS `Swarm.update` path so closing an abandoned aggregate
 * emits the same `Swarm.Event.Updated` audit row as any other status change and
 * cannot silently delete history.
 */
export interface AbandonedCreatingTarget {
  readonly swarm: Swarm.Info
  readonly idleForMs: number
  readonly members: number
  readonly tasks: number
  readonly leases: number
}

/**
 * A long-lived `active` Swarm that owns no live execution authority at all.
 *
 * Reported for operator visibility only. An idle Swarm is a legitimate steady
 * state (a coordinator may be waiting on a human for hours), so this projection
 * deliberately has no automatic transition: closing one is an operator
 * decision, and inferring abandonment from idleness alone would destroy audit
 * history for a Swarm that is merely quiet.
 */
export interface StaleActiveTarget {
  readonly swarm: Swarm.Info
  readonly idleForMs: number
  readonly openTasks: number
  readonly leases: number
}

export interface AggregateScanInput {
  /** Only aggregates whose last durable update is at or before this are candidates. */
  readonly staleBefore: number
  readonly limit?: number
}

function boundedLimit(value: number | undefined) {
  return Math.min(256, Math.max(1, Math.trunc(value ?? 64)))
}

export function makeAggregateRecoveryOperations(input: { readonly readDb: Db }) {
  const { readDb } = input

  /**
   * Batch child counts for one Swarm page. Deliberately three grouped queries
   * for the whole page rather than N+1 per aggregate: this projection runs on
   * the global deadline sweep and must stay cheap as the Swarm catalog grows.
   */
  const childCounts = Effect.fn("Swarm.aggregateChildCounts")(function* (swarmIDs: ReadonlyArray<Swarm.ID>) {
    if (swarmIDs.length === 0)
      return { members: new Map<string, number>(), tasks: new Map<string, number>(), leases: new Map<string, number>() }

    const [memberRows, taskRows, leaseRows] = yield* Effect.all(
      [
        readDb
          .select({ swarmID: SwarmMemberTable.swarm_id, total: count() })
          .from(SwarmMemberTable)
          .where(inArray(SwarmMemberTable.swarm_id, swarmIDs))
          .groupBy(SwarmMemberTable.swarm_id)
          .all(),
        readDb
          .select({ swarmID: SwarmTaskTable.swarm_id, total: count() })
          .from(SwarmTaskTable)
          .where(inArray(SwarmTaskTable.swarm_id, swarmIDs))
          .groupBy(SwarmTaskTable.swarm_id)
          .all(),
        readDb
          .select({ swarmID: SwarmTaskLeaseTable.task_id, total: count() })
          .from(SwarmTaskLeaseTable)
          .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
          .where(inArray(SwarmTaskTable.swarm_id, swarmIDs))
          .groupBy(SwarmTaskTable.swarm_id)
          .all(),
      ],
      { concurrency: 3 },
    )

    return {
      members: new Map(memberRows.map((row) => [row.swarmID, row.total] as const)),
      tasks: new Map(taskRows.map((row) => [row.swarmID, row.total] as const)),
      leases: new Map(leaseRows.map((row) => [row.swarmID, row.total] as const)),
    }
  })

  const abandonedCreating = Effect.fn("Swarm.abandonedCreatingSwarms")(function* (request: AggregateScanInput) {
    const limit = boundedLimit(request.limit)
    const rows = yield* readDb
      .select()
      .from(SwarmTable)
      .where(and(eq(SwarmTable.status, "creating"), lte(SwarmTable.time_updated, request.staleBefore)))
      .orderBy(asc(SwarmTable.time_updated), asc(SwarmTable.id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return [] as ReadonlyArray<AbandonedCreatingTarget>

    const counts = yield* childCounts(rows.map((row) => row.id))
    return rows.map((row) => ({
      swarm: hydrateInfo(row),
      idleForMs: request.staleBefore - row.time_updated,
      members: counts.members.get(row.id) ?? 0,
      tasks: counts.tasks.get(row.id) ?? 0,
      leases: counts.leases.get(row.id) ?? 0,
    })) satisfies ReadonlyArray<AbandonedCreatingTarget>
  })

  const staleActive = Effect.fn("Swarm.staleActiveSwarms")(function* (request: AggregateScanInput) {
    const limit = boundedLimit(request.limit)
    const rows = yield* readDb
      .select()
      .from(SwarmTable)
      .where(and(eq(SwarmTable.status, "active"), lte(SwarmTable.time_updated, request.staleBefore)))
      .orderBy(asc(SwarmTable.time_updated), asc(SwarmTable.id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return [] as ReadonlyArray<StaleActiveTarget>

    const counts = yield* childCounts(rows.map((row) => row.id))
    const openTaskRows = yield* readDb
      .select({ swarmID: SwarmTaskTable.swarm_id, total: count() })
      .from(SwarmTaskTable)
      .where(
        and(
          inArray(SwarmTaskTable.swarm_id, rows.map((row) => row.id)),
          inArray(SwarmTaskTable.status, ["pending", "ready", "working", "review_pending", "changes_requested"]),
        ),
      )
      .groupBy(SwarmTaskTable.swarm_id)
      .all()
      .pipe(Effect.orDie)
    const openTasks = new Map(openTaskRows.map((row) => [row.swarmID, row.total] as const))

    return rows.map((row) => ({
      swarm: hydrateInfo(row),
      idleForMs: request.staleBefore - row.time_updated,
      openTasks: openTasks.get(row.id) ?? 0,
      leases: counts.leases.get(row.id) ?? 0,
    })) satisfies ReadonlyArray<StaleActiveTarget>
  })

  return { abandonedCreating, staleActive }
}
