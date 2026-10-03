export * as SwarmSessionProjector from "./swarm-session-projector"

import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { SessionEvent } from "./session/event"
import { SessionInputTable } from "./session/sql"
import { SessionProjector } from "./session/projector"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmSchema } from "./swarm/schema"
import {
  SwarmMemberTable,
  SwarmMessageDeliveryTable,
  SwarmMessageTable,
  SwarmTaskLeaseTable,
  SwarmTaskRunTable,
  SwarmTaskTable,
} from "./swarm/sql"

function epoch(value: DateTime.Utc) {
  return DateTime.toEpochMillis(value)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const admitAssignment = Effect.fn("SwarmSessionProjector.admitAssignment")(function* (
      event: typeof SessionEvent.SyntheticAdmitted.Type,
    ) {
      if (event.data.origin.producer !== SessionTurnProvenance.Source.SwarmAssignment) return
      const ref = event.data.origin.ref
      if (!ref) return yield* Effect.die("Swarm assignment admission is missing task-run correlation ref")
      const runID = Swarm.TaskRunID.make(ref)
      const existing = yield* db
        .select()
        .from(SwarmTaskRunTable)
        .where(eq(SwarmTaskRunTable.session_input_id, event.data.messageID))
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        if (existing.id !== runID || existing.session_id !== event.data.sessionID)
          return yield* Effect.die(`Swarm assignment correlation conflict for ${event.data.messageID}`)
        return
      }

      const leases = yield* db
        .select()
        .from(SwarmTaskLeaseTable)
        .where(eq(SwarmTaskLeaseTable.owner_session_id, event.data.sessionID))
        .limit(2)
        .all()
        .pipe(Effect.orDie)
      if (leases.length !== 1)
        return yield* Effect.die(
          `Swarm assignment ${runID} expected exactly one live task lease for Session ${event.data.sessionID}, found ${leases.length}`,
        )
      const lease = leases[0]!
      if (lease.state === "retiring")
        return yield* Effect.die(`Swarm assignment ${runID} cannot admit against a retiring task lease`)
      const [task, member] = yield* Effect.all([
        db.select().from(SwarmTaskTable).where(eq(SwarmTaskTable.id, lease.task_id)).get().pipe(Effect.orDie),
        db.select().from(SwarmMemberTable).where(eq(SwarmMemberTable.id, lease.owner_member_id)).get().pipe(Effect.orDie),
      ])
      if (!task || task.status !== "working")
        return yield* Effect.die(`Swarm assignment ${runID} does not have a working task`)
      if (
        !member ||
        member.lifecycle !== "active" ||
        member.session_id !== event.data.sessionID ||
        member.binding_generation !== lease.owner_binding_generation
      )
        return yield* Effect.die(`Swarm assignment ${runID} lost its member binding before admission`)

      const at = epoch(event.data.timestamp)
      yield* db
        .insert(SwarmTaskRunTable)
        .values({
          id: runID,
          task_id: lease.task_id,
          member_id: lease.owner_member_id,
          session_id: lease.owner_session_id,
          binding_generation: lease.owner_binding_generation,
          lease_generation: lease.generation,
          session_input_id: event.data.messageID,
          status: "admitted",
          admitted_at: at,
          time_created: at,
        })
        .run()
        .pipe(Effect.orDie)
    })

    const admitPeer = Effect.fn("SwarmSessionProjector.admitPeer")(function* (
      event: typeof SessionEvent.SyntheticAdmitted.Type,
    ) {
      if (event.data.origin.producer !== SessionTurnProvenance.Source.SwarmPeer) return
      if (event.durable === undefined) return yield* Effect.die("Durable peer admission is missing aggregate sequence")
      const ref = event.data.origin.ref
      if (!ref) return yield* Effect.die("Swarm peer admission is missing delivery correlation ref")
      const deliveryID = Swarm.DeliveryID.make(ref)
      const delivery = yield* db
        .select()
        .from(SwarmMessageDeliveryTable)
        .where(eq(SwarmMessageDeliveryTable.id, deliveryID))
        .get()
        .pipe(Effect.orDie)
      if (!delivery) return yield* Effect.die(`Swarm peer delivery not found: ${deliveryID}`)
      if (delivery.session_input_id !== event.data.messageID)
        return yield* Effect.die(`Swarm peer delivery ${deliveryID} has a different Session input identity`)
      if (delivery.state === "admitted") {
        if (
          delivery.admitted_session_id !== event.data.sessionID ||
          delivery.admitted_seq !== event.durable.seq
        )
          return yield* Effect.die(`Swarm peer delivery ${deliveryID} has conflicting admission correlation`)
        return
      }
      if (delivery.state !== "claimed")
        return yield* Effect.die(`Swarm peer delivery ${deliveryID} cannot admit from ${delivery.state}`)

      const [message, member] = yield* Effect.all([
        db.select().from(SwarmMessageTable).where(eq(SwarmMessageTable.id, delivery.message_id)).get().pipe(Effect.orDie),
        db.select().from(SwarmMemberTable).where(eq(SwarmMemberTable.id, delivery.recipient_member_id)).get().pipe(Effect.orDie),
      ])
      const at = epoch(event.data.timestamp)
      if (!message) return yield* Effect.die(`Swarm peer message not found: ${delivery.message_id}`)
      if (message.expires_at !== null && message.expires_at <= at)
        return yield* Effect.die(
          new SwarmSchema.ConflictError({
            code: "swarm.message_expired",
            reason: `Swarm peer delivery ${deliveryID} expired before admission.`,
          }),
        )
      if (!member || member.lifecycle !== "active" || member.session_id !== event.data.sessionID)
        return yield* Effect.die(`Swarm peer delivery ${deliveryID} lost its recipient binding before admission`)

      const updated = yield* db
        .update(SwarmMessageDeliveryTable)
        .set({
          state: "admitted",
          admitted_session_id: event.data.sessionID,
          admitted_seq: event.durable.seq,
          admitted_at: at,
          claim_owner: null,
          claim_expires_at: null,
          next_attempt_at: null,
          error: null,
        })
        .where(
          and(
            eq(SwarmMessageDeliveryTable.id, deliveryID),
            eq(SwarmMessageDeliveryTable.state, "claimed"),
            eq(SwarmMessageDeliveryTable.claim_generation, delivery.claim_generation),
          ),
        )
        .returning({ id: SwarmMessageDeliveryTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) return yield* Effect.die(`Swarm peer delivery ${deliveryID} changed before admission projection`)
    })

    const promoteAssignment = Effect.fn("SwarmSessionProjector.promoteAssignment")(function* (
      event: typeof SessionEvent.SyntheticPromoted.Type,
    ) {
      if (event.data.origin.producer !== SessionTurnProvenance.Source.SwarmAssignment) return
      const ref = event.data.origin.ref
      if (!ref) return yield* Effect.die("Promoted Swarm assignment is missing task-run correlation ref")
      const run = yield* db
        .select()
        .from(SwarmTaskRunTable)
        .where(eq(SwarmTaskRunTable.session_input_id, event.data.messageID))
        .get()
        .pipe(Effect.orDie)
      if (!run || run.id !== ref || run.session_id !== event.data.sessionID)
        return yield* Effect.die(`Promoted Swarm assignment has no matching admitted run: ${ref}`)
      if (run.status !== "admitted") return

      const [lease, member] = yield* Effect.all([
        db.select().from(SwarmTaskLeaseTable).where(eq(SwarmTaskLeaseTable.task_id, run.task_id)).get().pipe(Effect.orDie),
        db.select().from(SwarmMemberTable).where(eq(SwarmMemberTable.id, run.member_id)).get().pipe(Effect.orDie),
      ])
      if (
        !lease ||
        lease.generation !== run.lease_generation ||
        lease.owner_member_id !== run.member_id ||
        lease.owner_session_id !== run.session_id ||
        lease.owner_binding_generation !== run.binding_generation ||
        lease.state === "retiring"
      )
        return yield* Effect.die(`Swarm assignment run ${run.id} lost task authority before promotion`)
      if (
        !member ||
        member.lifecycle !== "active" ||
        member.session_id !== run.session_id ||
        member.binding_generation !== run.binding_generation
      )
        return yield* Effect.die(`Swarm assignment run ${run.id} lost member authority before promotion`)
      const updated = yield* db
        .update(SwarmTaskRunTable)
        .set({ status: "running", started_at: epoch(event.data.promotedAt ?? event.data.timestamp) })
        .where(and(eq(SwarmTaskRunTable.id, run.id), eq(SwarmTaskRunTable.status, "admitted")))
        .returning({ id: SwarmTaskRunTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updated) return yield* Effect.die(`Swarm assignment run ${run.id} changed before promotion projection`)
    })

    const supersedePendingRun = Effect.fn("SwarmSessionProjector.supersedePendingRun")(function* (
      sessionInputID: SessionMessage.ID,
      endedAt: number,
      reason: string,
    ) {
      const run = yield* db
        .select()
        .from(SwarmTaskRunTable)
        .where(eq(SwarmTaskRunTable.session_input_id, sessionInputID))
        .get()
        .pipe(Effect.orDie)
      if (!run || run.status !== "admitted") return

      const lease = yield* db
        .select()
        .from(SwarmTaskLeaseTable)
        .where(eq(SwarmTaskLeaseTable.task_id, run.task_id))
        .get()
        .pipe(Effect.orDie)
      const exactLease =
        lease &&
        lease.generation === run.lease_generation &&
        lease.owner_member_id === run.member_id &&
        lease.owner_session_id === run.session_id &&
        lease.owner_binding_generation === run.binding_generation

      yield* db
        .update(SwarmTaskRunTable)
        .set({ status: "superseded", ended_at: endedAt, failure_detail: reason })
        .where(and(eq(SwarmTaskRunTable.id, run.id), eq(SwarmTaskRunTable.status, "admitted")))
        .run()
        .pipe(Effect.orDie)

      // If authority already moved, the old run is merely historical. Never
      // mutate the newly-authoritative task/lease from stale Session evidence.
      if (!exactLease) return
      const updatedTask = yield* db
        .update(SwarmTaskTable)
        .set({
          status: "ready",
          lease_generation: run.lease_generation + 1,
          ready_at: endedAt,
          time_updated: endedAt,
          time_completed: null,
        })
        .where(
          and(
            eq(SwarmTaskTable.id, run.task_id),
            eq(SwarmTaskTable.status, "working"),
            eq(SwarmTaskTable.lease_generation, run.lease_generation),
          ),
        )
        .returning({ id: SwarmTaskTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!updatedTask) return yield* Effect.die(`Swarm task ${run.task_id} changed during pending assignment supersession`)
      const deleted = yield* db
        .delete(SwarmTaskLeaseTable)
        .where(
          and(
            eq(SwarmTaskLeaseTable.task_id, run.task_id),
            eq(SwarmTaskLeaseTable.generation, run.lease_generation),
            eq(SwarmTaskLeaseTable.owner_member_id, run.member_id),
            eq(SwarmTaskLeaseTable.owner_session_id, run.session_id),
            eq(SwarmTaskLeaseTable.owner_binding_generation, run.binding_generation),
          ),
        )
        .returning({ id: SwarmTaskLeaseTable.task_id })
        .get()
        .pipe(Effect.orDie)
      if (!deleted) return yield* Effect.die(`Swarm task ${run.task_id} lease changed during pending assignment supersession`)
    })

    yield* events.project(SessionEvent.SyntheticAdmitted, (event) =>
      Effect.gen(function* () {
        yield* admitAssignment(event)
        yield* admitPeer(event)
      }),
    )
    yield* events.project(SessionEvent.SyntheticPromoted, promoteAssignment)
    yield* events.project(SessionEvent.SyntheticRevoked, (event) =>
      supersedePendingRun(
        event.data.messageID,
        epoch(event.data.timestamp),
        `pending Swarm assignment revoked: ${event.data.reason}`,
      ),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable User admission is missing aggregate sequence")
        const revoked = yield* db
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              eq(SessionInputTable.revoked_seq, event.durable.seq),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        for (const row of revoked)
          yield* supersedePendingRun(
            row.id,
            epoch(event.data.timestamp),
            `pending Swarm assignment superseded by direct User input ${event.data.messageID}`,
          )
      }),
    )
  }),
)

/**
 * Cross-domain normalized projection. Session events remain the durable cause;
 * this node only maintains Swarm correlation/current-state rows in the same
 * writer transaction and never publishes a second aggregate event.
 */
export const node = makeGlobalNode({
  name: "swarm-session-projector",
  layer,
  deps: [Database.node, EventV2.node, SessionProjector.node],
})
