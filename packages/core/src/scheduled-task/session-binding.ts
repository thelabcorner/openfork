export * as ScheduledTaskSessionBinding from "./session-binding"

import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { SessionID } from "@opencode-ai/schema/session-id"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionInput } from "../session/input"
import { SessionMetadataOwnership } from "../session/metadata-ownership"
import { SessionTable } from "../session/sql"
import { ScheduledTaskSchema } from "./schema"
import { ScheduledTaskSessionBindingTable, ScheduledTaskTable } from "./sql"

export const Binding = ScheduledTask.SessionBinding
export type Binding = ScheduledTask.SessionBinding

export interface AutoInspection {
  readonly binding: Binding
  readonly latestUserSeq?: number
  readonly userChanged: boolean
}

export interface Interface {
  readonly get: (taskID: ScheduledTask.ID) => Effect.Effect<Binding | undefined>
  readonly ownerOf: (sessionID: SessionID) => Effect.Effect<ScheduledTask.ID | undefined>
  readonly inspectAuto: (taskID: ScheduledTask.ID) => Effect.Effect<AutoInspection | undefined>
  /**
   * Bounded, history-free picker projection for user-drivable root Sessions.
   * Producer-owned roots are filtered here so presentation never reimplements
   * aggregate ownership policy.
   */
  readonly candidates: (input: {
    readonly targetDirectory: string
    readonly projectID?: ProjectID
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<ScheduledTask.SessionCandidate>>
  /**
   * Installs/replaces one task-owned anchor under both task-revision and
   * binding-generation CAS. expectedGeneration=undefined means "there must be
   * no current binding".
   */
  readonly install: (input: {
    readonly taskID: ScheduledTask.ID
    readonly taskRevision: number
    readonly sessionID: SessionID
    readonly expectedGeneration: number | undefined
    readonly now?: number
  }) => Effect.Effect<Binding | undefined, ScheduledTaskSchema.ValidationError>
  /** User/operator reset. When expectedGeneration is supplied it is CAS-fenced. */
  readonly clear: (input: {
    readonly taskID: ScheduledTask.ID
    readonly expectedGeneration?: number
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ScheduledTaskSessionBinding") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const events = yield* EventV2.Service

    const get = Effect.fn("ScheduledTaskSessionBinding.get")(function* (taskID: ScheduledTask.ID) {
      const row = yield* readDb
        .select()
        .from(ScheduledTaskSessionBindingTable)
        .where(eq(ScheduledTaskSessionBindingTable.task_id, taskID))
        .get()
        .pipe(Effect.orDie)
      return row ? hydrate(row) : undefined
    })

    const ownerOf = Effect.fn("ScheduledTaskSessionBinding.ownerOf")(function* (sessionID: SessionID) {
      const row = yield* readDb
        .select({ taskID: ScheduledTaskSessionBindingTable.task_id })
        .from(ScheduledTaskSessionBindingTable)
        .where(eq(ScheduledTaskSessionBindingTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row?.taskID
    })

    const inspectAuto = Effect.fn("ScheduledTaskSessionBinding.inspectAuto")(function* (taskID: ScheduledTask.ID) {
      const binding = yield* get(taskID)
      if (!binding) return undefined
      const latestUserSeq = yield* SessionInput.latestUserSeq(db, binding.sessionID)
      return {
        binding,
        ...(latestUserSeq === undefined ? {} : { latestUserSeq }),
        userChanged: latestUserSeq !== binding.userSeqFence,
      } satisfies AutoInspection
    })

    const candidates = Effect.fn("ScheduledTaskSessionBinding.candidates")(function* (input: {
      readonly targetDirectory: string
      readonly projectID?: ProjectID
      readonly limit?: number
    }) {
      const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 250)
      const predicates = [
        eq(SessionTable.directory, input.targetDirectory as never),
        isNull(SessionTable.parent_id),
        isNull(SessionTable.time_archived),
        // Presence itself is ownership for Scheduled/delegated roots. Special
        // agent ownership requires a string classifier. Mirror Core's canonical
        // ownership semantics in SQL, then re-check decoded metadata below.
        sql`json_type(${SessionTable.metadata}, '$.scheduledTaskID') IS NULL`,
        sql`json_type(${SessionTable.metadata}, '$.scheduledTaskRunID') IS NULL`,
        sql`json_type(${SessionTable.metadata}, '$.workerDelegation') IS NULL`,
        sql`(json_type(${SessionTable.metadata}, '$.specialAgent') IS NULL OR json_type(${SessionTable.metadata}, '$.specialAgent') <> 'text')`,
      ]
      if (input.projectID) predicates.push(eq(SessionTable.project_id, input.projectID))
      const rows = yield* readDb
        .select({
          id: SessionTable.id,
          projectID: SessionTable.project_id,
          directory: SessionTable.directory,
          title: SessionTable.title,
          metadata: SessionTable.metadata,
          timeUpdated: SessionTable.time_updated,
        })
        .from(SessionTable)
        .where(and(...predicates))
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows
        .filter((row) => !SessionMetadataOwnership.isProducerOwned(row.metadata ?? undefined))
        .map((row) => ({
          id: row.id,
          projectID: row.projectID,
          directory: row.directory,
          title: row.title,
          timeUpdated: DateTime.makeUnsafe(row.timeUpdated),
        }))
    })

    const install = Effect.fn("ScheduledTaskSessionBinding.install")(function* (input: {
      readonly taskID: ScheduledTask.ID
      readonly taskRevision: number
      readonly sessionID: SessionID
      readonly expectedGeneration: number | undefined
      readonly now?: number
    }) {
      const now = input.now ?? Date.now()
      // Capturing before BEGIN IMMEDIATE is deliberately conservative: a User
      // racing this read can only make the fence older, causing Auto to rotate
      // on the next inspection. Final scheduled admission has its own exact
      // expectedLatestUserSeq fence.
      const userSeqFence = yield* SessionInput.latestUserSeq(db, input.sessionID)

      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const task = yield* tx
                .select()
                .from(ScheduledTaskTable)
                .where(eq(ScheduledTaskTable.id, input.taskID))
                .get()
                .pipe(Effect.orDie)
              if (!task || task.revision !== input.taskRevision) return undefined
              if (task.session_policy.kind !== "reuse" && task.session_policy.kind !== "auto") {
                return yield* new ScheduledTaskSchema.ValidationError({
                  reason: `session bindings require sessionPolicy=reuse|auto, got ${task.session_policy.kind}`,
                })
              }
              if (task.target.kind === "worktree" && !task.target.reuse) {
                return yield* new ScheduledTaskSchema.ValidationError({
                  reason: "reusable Session binding requires a stable execution directory",
                })
              }

              const session = yield* tx
                .select({
                  id: SessionTable.id,
                  projectID: SessionTable.project_id,
                  parentID: SessionTable.parent_id,
                  directory: SessionTable.directory,
                  metadata: SessionTable.metadata,
                })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!session) {
                return yield* new ScheduledTaskSchema.ValidationError({
                  reason: `session does not exist: ${input.sessionID}`,
                })
              }
              if (session.parentID !== null) {
                return yield* new ScheduledTaskSchema.ValidationError({ reason: "scheduled task anchor must be a root Session" })
              }
              if (task.project_id !== null && session.projectID !== task.project_id) {
                return yield* new ScheduledTaskSchema.ValidationError({
                  reason: `Session project does not match scheduled task project: ${session.projectID} != ${task.project_id}`,
                })
              }
              if (task.target.kind === "directory" && session.directory !== task.target_directory) {
                return yield* new ScheduledTaskSchema.ValidationError({
                  reason: `Session directory does not match scheduled task target: ${session.directory} != ${task.target_directory}`,
                })
              }
              if (
                SessionMetadataOwnership.isSpecialAgent(session.metadata ?? undefined) ||
                SessionMetadataOwnership.hasWorkerDelegationOrigin(session.metadata ?? undefined)
              ) {
                return yield* new ScheduledTaskSchema.ValidationError({
                  reason: "special-agent/delegated Sessions cannot be Scheduled Task anchors",
                })
              }
              if (SessionMetadataOwnership.hasScheduledTaskOrigin(session.metadata ?? undefined)) {
                const metadataTaskID = session.metadata?.[SessionMetadataOwnership.Keys.scheduledTaskID]
                if (metadataTaskID !== input.taskID) {
                  return yield* new ScheduledTaskSchema.ValidationError({
                    reason: "Session is owned by another Scheduled Task or has malformed Scheduled ownership metadata",
                  })
                }
              }

              const current = yield* tx
                .select()
                .from(ScheduledTaskSessionBindingTable)
                .where(eq(ScheduledTaskSessionBindingTable.task_id, input.taskID))
                .get()
                .pipe(Effect.orDie)
              if (current ? current.generation !== input.expectedGeneration : input.expectedGeneration !== undefined) {
                return undefined
              }
              const otherOwner = yield* tx
                .select({ taskID: ScheduledTaskSessionBindingTable.task_id })
                .from(ScheduledTaskSessionBindingTable)
                .where(eq(ScheduledTaskSessionBindingTable.session_id, input.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (otherOwner && otherOwner.taskID !== input.taskID) {
                return yield* new ScheduledTaskSchema.ValidationError({
                  reason: `Session is already bound to Scheduled Task ${otherOwner.taskID}`,
                })
              }

              if (!current) {
                const inserted = yield* tx
                  .insert(ScheduledTaskSessionBindingTable)
                  .values({
                    task_id: input.taskID,
                    session_id: input.sessionID,
                    task_revision: input.taskRevision,
                    user_seq_fence: userSeqFence ?? null,
                    generation: 1,
                    time_updated: now,
                  })
                  .onConflictDoNothing()
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
                return inserted
              }

              return yield* tx
                .update(ScheduledTaskSessionBindingTable)
                .set({
                  session_id: input.sessionID,
                  task_revision: input.taskRevision,
                  user_seq_fence: userSeqFence ?? null,
                  generation: current.generation + 1,
                  time_updated: now,
                })
                .where(
                  and(
                    eq(ScheduledTaskSessionBindingTable.task_id, input.taskID),
                    eq(ScheduledTaskSessionBindingTable.generation, current.generation),
                  ),
                )
                .returning()
                .get()
                .pipe(Effect.orDie)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))

      if (!row) return undefined
      const binding = hydrate(row)
      yield* events.publish(ScheduledTask.Event.SessionBindingChanged, {
        taskID: binding.taskID,
        binding: project(binding),
      })
      return binding
    })

    const clear = Effect.fn("ScheduledTaskSessionBinding.clear")(function* (input: {
      readonly taskID: ScheduledTask.ID
      readonly expectedGeneration?: number
    }) {
      const where =
        input.expectedGeneration === undefined
          ? eq(ScheduledTaskSessionBindingTable.task_id, input.taskID)
          : and(
              eq(ScheduledTaskSessionBindingTable.task_id, input.taskID),
              eq(ScheduledTaskSessionBindingTable.generation, input.expectedGeneration),
            )
      const deleted = yield* db
        .delete(ScheduledTaskSessionBindingTable)
        .where(where)
        .returning({ taskID: ScheduledTaskSessionBindingTable.task_id })
        .get()
        .pipe(Effect.orDie)
      if (deleted) {
        yield* events.publish(ScheduledTask.Event.SessionBindingChanged, {
          taskID: input.taskID,
          binding: null,
        })
      }
      return deleted !== undefined
    })

    return Service.of({ get, ownerOf, inspectAuto, candidates, install, clear })
  }),
)

function hydrate(row: typeof ScheduledTaskSessionBindingTable.$inferSelect): Binding {
  return {
    taskID: row.task_id,
    sessionID: row.session_id,
    taskRevision: row.task_revision,
    ...(row.user_seq_fence === null ? {} : { userSeqFence: row.user_seq_fence }),
    generation: row.generation,
    timeUpdated: DateTime.makeUnsafe(row.time_updated),
  }
}

function project(binding: Binding): ScheduledTask.SessionBindingProjection {
  return {
    taskID: binding.taskID,
    sessionID: binding.sessionID,
    generation: binding.generation,
    timeUpdated: binding.timeUpdated,
  }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
