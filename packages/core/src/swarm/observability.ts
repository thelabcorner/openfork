import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Swarm as SwarmModel } from "@opencode-ai/schema/swarm"
import type { DatabaseShape } from "../database/database"
import { requireSwarmRow } from "./repository"
import {
  SwarmBlackboardTable,
  SwarmClaimTable,
  SwarmDeliverableTable,
  SwarmMemberTable,
  SwarmMessageDeliveryTable,
  SwarmMessageTable,
  SwarmTaskLeaseTable,
  SwarmTaskRunTable,
  SwarmTaskTable,
} from "./sql"

type Db = DatabaseShape

/**
 * Authoritative compact Swarm lifecycle observability.
 *
 * Every value is a bounded grouped aggregate over durable `swarm_*` rows,
 * evaluated in a fixed number of statements by the Swarm domain owner. This is
 * deliberately *not* a consumer-side reconstruction:
 *
 * - it never reads Session messages, parts, or rendered timeline rows;
 * - it never hydrates history to derive a single scalar;
 * - statement count and output cardinality are fixed, so an operator view, a
 *   Swarm panel, and a health check all read the same projection. Aggregate
 *   scan work still grows with durable row count; what is guaranteed here is
 *   that no history is hydrated and no per-row output is produced.
 *
 * It also deliberately does not decide lifecycle policy. It reports the durable
 * facts the lifecycle owner already wrote (`swarm_task.status`,
 * `swarm_task_run.status`, `failure_kind`, lease state, member lifecycle) and
 * stops there. Any threshold, escalation, or repair action stays with the
 * recovery/operator owner.
 */
export function makeObservabilityOperations(input: { readonly readDb: Db }) {
  const { readDb } = input

  const reliability = Effect.fn("Swarm.reliability")(function* (request: {
    readonly swarmID: SwarmModel.ID
    readonly now?: number
  }) {
    yield* requireSwarmRow(readDb, request.swarmID)
    const now = request.now ?? Date.now()

    const [
      taskRows,
      runRows,
      leaseRows,
      expiredLeaseRow,
      memberRows,
      unsatisfiedProfileRow,
      unownedRunRow,
      messageRow,
      deliveryRows,
      retriedDeliveryRow,
      blackboardRow,
      claimRow,
      deliverableRow,
    ] = yield* Effect.all([
      readDb
        .select({ status: SwarmTaskTable.status, count: sql<number>`count(*)` })
        .from(SwarmTaskTable)
        .where(eq(SwarmTaskTable.swarm_id, request.swarmID))
        .groupBy(SwarmTaskTable.status)
        .all()
        .pipe(Effect.orDie),
      readDb
        .select({
          status: SwarmTaskRunTable.status,
          failureKind: SwarmTaskRunTable.failure_kind,
          count: sql<number>`count(*)`,
        })
        .from(SwarmTaskRunTable)
        .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskRunTable.task_id))
        .where(eq(SwarmTaskTable.swarm_id, request.swarmID))
        .groupBy(SwarmTaskRunTable.status, SwarmTaskRunTable.failure_kind)
        .all()
        .pipe(Effect.orDie),
      readDb
        .select({ state: SwarmTaskLeaseTable.state, count: sql<number>`count(*)` })
        .from(SwarmTaskLeaseTable)
        .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
        .where(eq(SwarmTaskTable.swarm_id, request.swarmID))
        .groupBy(SwarmTaskLeaseTable.state)
        .all()
        .pipe(Effect.orDie),
      readDb
        .select({ count: sql<number>`count(*)` })
        .from(SwarmTaskLeaseTable)
        .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
        .where(
          and(
            eq(SwarmTaskTable.swarm_id, request.swarmID),
            ne(SwarmTaskLeaseTable.state, "retiring"),
            sql`${SwarmTaskLeaseTable.expires_at} <= ${now}`,
          ),
        )
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({
          kind: SwarmMemberTable.kind,
          lifecycle: SwarmMemberTable.lifecycle,
          bound: sql<number>`sum(case when ${SwarmMemberTable.session_id} is not null then 1 else 0 end)`,
          count: sql<number>`count(*)`,
        })
        .from(SwarmMemberTable)
        .where(eq(SwarmMemberTable.swarm_id, request.swarmID))
        .groupBy(SwarmMemberTable.kind, SwarmMemberTable.lifecycle)
        .all()
        .pipe(Effect.orDie),
      readDb
        .select({ count: sql<number>`count(*)` })
        .from(SwarmMemberTable)
        .where(
          and(
            eq(SwarmMemberTable.swarm_id, request.swarmID),
            eq(SwarmMemberTable.kind, "managed_worker"),
            isNotNull(SwarmMemberTable.desired_profile),
            isNull(SwarmMemberTable.session_id),
          ),
        )
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ count: sql<number>`count(*)` })
        .from(SwarmTaskRunTable)
        .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskRunTable.task_id))
        .leftJoin(
          SwarmTaskLeaseTable,
          and(
            eq(SwarmTaskLeaseTable.task_id, SwarmTaskRunTable.task_id),
            eq(SwarmTaskLeaseTable.owner_member_id, SwarmTaskRunTable.member_id),
            eq(SwarmTaskLeaseTable.owner_session_id, SwarmTaskRunTable.session_id),
            eq(SwarmTaskLeaseTable.owner_binding_generation, SwarmTaskRunTable.binding_generation),
            eq(SwarmTaskLeaseTable.generation, SwarmTaskRunTable.lease_generation),
            // A human-preempted lease still owns and fences its run, so only
            // `retiring` counts as lost ownership here.
            inArray(SwarmTaskLeaseTable.state, ["active", "human_hold"]),
          ),
        )
        .where(
          and(
            eq(SwarmTaskTable.swarm_id, request.swarmID),
            inArray(SwarmTaskRunTable.status, ["admitted", "running"]),
            isNull(SwarmTaskLeaseTable.task_id),
          ),
        )
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ count: sql<number>`count(*)` })
        .from(SwarmMessageTable)
        .where(eq(SwarmMessageTable.swarm_id, request.swarmID))
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ state: SwarmMessageDeliveryTable.state, count: sql<number>`count(*)` })
        .from(SwarmMessageDeliveryTable)
        .innerJoin(SwarmMemberTable, eq(SwarmMemberTable.id, SwarmMessageDeliveryTable.recipient_member_id))
        .where(eq(SwarmMemberTable.swarm_id, request.swarmID))
        .groupBy(SwarmMessageDeliveryTable.state)
        .all()
        .pipe(Effect.orDie),
      readDb
        .select({ count: sql<number>`count(*)` })
        .from(SwarmMessageDeliveryTable)
        .innerJoin(SwarmMemberTable, eq(SwarmMemberTable.id, SwarmMessageDeliveryTable.recipient_member_id))
        .where(
          and(eq(SwarmMemberTable.swarm_id, request.swarmID), sql`${SwarmMessageDeliveryTable.attempt_count} > 0`),
        )
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({
          entries: sql<number>`count(*)`,
          // Blackboard `version` is 1-based: the first successful put stores 1
          // and each CAS overwrite adds exactly one, so summing (version - 1)
          // counts overwrites and never underflows a malformed row.
          overwrites: sql<number>`coalesce(sum(case when ${SwarmBlackboardTable.version} > 0 then ${SwarmBlackboardTable.version} - 1 else 0 end), 0)`,
        })
        .from(SwarmBlackboardTable)
        .where(eq(SwarmBlackboardTable.swarm_id, request.swarmID))
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ count: sql<number>`count(*)` })
        .from(SwarmClaimTable)
        .where(eq(SwarmClaimTable.swarm_id, request.swarmID))
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({
          count: sql<number>`count(*)`,
          awaiting: sql<number>`coalesce(sum(case when ${SwarmDeliverableTable.verdict} is null then 1 else 0 end), 0)`,
        })
        .from(SwarmDeliverableTable)
        .where(eq(SwarmDeliverableTable.swarm_id, request.swarmID))
        .get()
        .pipe(Effect.orDie),
    ])

    const tasks = {
      total: 0,
      pending: 0,
      blocked: 0,
      ready: 0,
      working: 0,
      reviewPending: 0,
      changesRequested: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    }
    for (const row of taskRows) {
      const count = Number(row.count ?? 0)
      tasks.total += count
      switch (row.status) {
        case "pending":
          tasks.pending += count
          break
        case "blocked":
          tasks.blocked += count
          break
        case "ready":
          tasks.ready += count
          break
        case "working":
          tasks.working += count
          break
        case "review_pending":
          tasks.reviewPending += count
          break
        case "changes_requested":
          tasks.changesRequested += count
          break
        case "completed":
          tasks.completed += count
          break
        case "failed":
          tasks.failed += count
          break
        case "cancelled":
          tasks.cancelled += count
          break
      }
    }

    const runs = {
      total: 0,
      admitted: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      unsettled: 0,
      superseded: 0,
      semanticFailure: 0,
      operationalFailure: 0,
    }
    for (const row of runRows) {
      const count = Number(row.count ?? 0)
      runs.total += count
      switch (row.status) {
        case "admitted":
          runs.admitted += count
          break
        case "running":
          runs.running += count
          break
        case "completed":
          runs.completed += count
          break
        case "failed":
          runs.failed += count
          if (row.failureKind === "semantic") runs.semanticFailure += count
          else runs.operationalFailure += count
          break
        case "cancelled":
          runs.cancelled += count
          break
        case "unsettled":
          runs.unsettled += count
          break
        case "superseded":
          runs.superseded += count
          break
      }
    }

    const leases = {
      active: 0,
      humanHold: 0,
      retiring: 0,
      expired: Number(expiredLeaseRow?.count ?? 0),
    }
    for (const row of leaseRows) {
      const count = Number(row.count ?? 0)
      if (row.state === "active") leases.active += count
      else if (row.state === "human_hold") leases.humanHold += count
      else leases.retiring += count
    }

    const members = {
      total: 0,
      managedWorker: 0,
      boundManagedWorker: 0,
      unboundConfiguredManagedWorker: Number(unsatisfiedProfileRow?.count ?? 0),
      held: 0,
      stopped: 0,
    }
    for (const row of memberRows) {
      const count = Number(row.count ?? 0)
      members.total += count
      if (row.kind === "managed_worker") {
        members.managedWorker += count
        members.boundManagedWorker += Number(row.bound ?? 0)
      }
      if (row.lifecycle === "held") members.held += count
      else if (row.lifecycle === "stopping" || row.lifecycle === "stopped") members.stopped += count
    }

    const deliveries = {
      deliveries: 0,
      pendingDeliveries: 0,
      claimedDeliveries: 0,
      admittedDeliveries: 0,
      expiredDeliveries: 0,
      failedDeliveries: 0,
    }
    for (const row of deliveryRows) {
      const count = Number(row.count ?? 0)
      deliveries.deliveries += count
      if (row.state === "pending") deliveries.pendingDeliveries += count
      else if (row.state === "claimed") deliveries.claimedDeliveries += count
      else if (row.state === "admitted") deliveries.admittedDeliveries += count
      else if (row.state === "expired") deliveries.expiredDeliveries += count
      else deliveries.failedDeliveries += count
    }

    const blackboardEntries = Number(blackboardRow?.entries ?? 0)

    return SwarmModel.Reliability.make({
      tasks,
      runs: { ...runs, unowned: Number(unownedRunRow?.count ?? 0) },
      leases,
      members,
      collaboration: {
        messages: Number(messageRow?.count ?? 0),
        ...deliveries,
        retriedDeliveries: Number(retriedDeliveryRow?.count ?? 0),
        blackboardEntries,
        // Entries plus CAS overwrites is the successful Blackboard write count.
        blackboardWrites: blackboardEntries + Number(blackboardRow?.overwrites ?? 0),
        totalClaimRows: Number(claimRow?.count ?? 0),
        deliverables: Number(deliverableRow?.count ?? 0),
        deliverablesAwaitingVerdict: Number(deliverableRow?.awaiting ?? 0),
      },
    })
  })

  return { reliability }
}
