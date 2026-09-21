import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import type { DatabaseShape } from "../database/database"
import { SessionMetadataOwnership } from "../session/metadata-ownership"
import { SessionTable } from "../session/sql"
import { SwarmSchema } from "./schema"
import {
  SwarmDeliverableTable,
  SwarmMemberTable,
  SwarmMessageDeliveryTable,
  SwarmMessageTable,
  SwarmTable,
  SwarmTaskLeaseTable,
  SwarmTaskRunTable,
  SwarmTaskTable,
} from "./sql"

export type Db = Omit<DatabaseShape, "$client">

function required<Row>(
  effect: Effect.Effect<Row | undefined, never, never>,
  entity: SwarmSchema.Entity,
  id: string,
) {
  return effect.pipe(
    Effect.flatMap((row) =>
      row ? Effect.succeed(row) : Effect.fail(new SwarmSchema.NotFoundError({ entity, id })),
    ),
  )
}

export function requireSwarmRow(database: Db, id: Swarm.ID) {
  return required(
    database
      .select()
      .from(SwarmTable)
      .where(eq(SwarmTable.id, id))
      .get()
      .pipe(Effect.orDie),
    "swarm",
    id,
  )
}

export function requireMemberRow(database: Db, swarmID: Swarm.ID, memberID: Swarm.MemberID) {
  return required(
    database
      .select()
      .from(SwarmMemberTable)
      .where(and(eq(SwarmMemberTable.id, memberID), eq(SwarmMemberTable.swarm_id, swarmID)))
      .get()
      .pipe(Effect.orDie),
    "member",
    memberID,
  )
}

export function requireTaskRow(database: Db, swarmID: Swarm.ID, taskID: Swarm.TaskID) {
  return required(
    database
      .select()
      .from(SwarmTaskTable)
      .where(and(eq(SwarmTaskTable.id, taskID), eq(SwarmTaskTable.swarm_id, swarmID)))
      .get()
      .pipe(Effect.orDie),
    "task",
    taskID,
  )
}

export function requireLeaseRow(database: Db, taskID: Swarm.TaskID) {
  return required(
    database
      .select()
      .from(SwarmTaskLeaseTable)
      .where(eq(SwarmTaskLeaseTable.task_id, taskID))
      .get()
      .pipe(Effect.orDie),
    "task",
    taskID,
  )
}

export function requireTaskRunRow(database: Db, runID: Swarm.TaskRunID) {
  return required(
    database
      .select()
      .from(SwarmTaskRunTable)
      .where(eq(SwarmTaskRunTable.id, runID))
      .get()
      .pipe(Effect.orDie),
    "task_run",
    runID,
  )
}

export function requireMessageRow(database: Db, swarmID: Swarm.ID, messageID: Swarm.MessageID) {
  return required(
    database
      .select()
      .from(SwarmMessageTable)
      .where(and(eq(SwarmMessageTable.id, messageID), eq(SwarmMessageTable.swarm_id, swarmID)))
      .get()
      .pipe(Effect.orDie),
    "message",
    messageID,
  )
}

export function requireDeliveryRow(database: Db, deliveryID: Swarm.DeliveryID) {
  return required(
    database
      .select()
      .from(SwarmMessageDeliveryTable)
      .where(eq(SwarmMessageDeliveryTable.id, deliveryID))
      .get()
      .pipe(Effect.orDie),
    "delivery",
    deliveryID,
  )
}

export function requireDeliverableRow(database: Db, deliverableID: Swarm.DeliverableID) {
  return required(
    database
      .select()
      .from(SwarmDeliverableTable)
      .where(eq(SwarmDeliverableTable.id, deliverableID))
      .get()
      .pipe(Effect.orDie),
    "deliverable",
    deliverableID,
  )
}

export const validateSessionScope = Effect.fnUntraced(function* (
  database: Db,
  swarm: typeof SwarmTable.$inferSelect,
  sessionID: typeof SessionTable.$inferSelect.id,
) {
  const session = yield* database
    .select({
      id: SessionTable.id,
      projectID: SessionTable.project_id,
      workspaceID: SessionTable.workspace_id,
      directory: SessionTable.directory,
      parentID: SessionTable.parent_id,
      metadata: SessionTable.metadata,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!session)
    return yield* new SwarmSchema.ValidationError({ reason: `Session not found: ${sessionID}` })
  if (session.parentID !== null)
    return yield* new SwarmSchema.ValidationError({
      reason: `Swarm members must bind ordinary root Sessions; ${sessionID} is a child of ${session.parentID}.`,
    })
  if (SessionMetadataOwnership.isProducerOwned(session.metadata ?? undefined))
    return yield* new SwarmSchema.ValidationError({
      reason: `Swarm members must bind ordinary interactive Sessions; ${sessionID} is producer-owned.`,
    })
  if (session.projectID !== swarm.project_id)
    return yield* new SwarmSchema.ValidationError({
      reason: `Session ${sessionID} belongs to project ${session.projectID ?? "none"}, not Swarm project ${swarm.project_id}.`,
    })
  if (swarm.workspace_id && session.workspaceID && session.workspaceID !== swarm.workspace_id)
    return yield* new SwarmSchema.ValidationError({
      reason: `Session ${sessionID} belongs to workspace ${session.workspaceID}, not Swarm workspace ${swarm.workspace_id}.`,
    })
  return session
})
