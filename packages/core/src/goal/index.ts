export * as Goal from "./index"

import { and, asc, desc, eq, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { Goal as GoalModel } from "@opencode-ai/schema/goal"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { ProjectTable } from "../project/sql"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionTable } from "../session/sql"
import { GoalSchema } from "./schema"
import { GoalStateMachine } from "./state-machine"
import {
  GoalCriterionTable,
  GoalEvidenceTable,
  GoalEventTable,
  GoalFocusTable,
  GoalStepTable,
  GoalTable,
} from "./sql"

export const ID = GoalModel.ID
export type ID = GoalModel.ID
export const Info = GoalModel.Info
export type Info = GoalModel.Info
export const Detail = GoalModel.Detail
export type Detail = GoalModel.Detail
export const Focus = GoalModel.Focus
export type Focus = GoalModel.Focus
export const Event = GoalModel.Event

export { GoalSchema, GoalStateMachine }

export interface CreateInput {
  readonly projectID: typeof ProjectTable.$inferSelect.id
  readonly workspaceID?: typeof WorkspaceTable.$inferSelect.id
  readonly title: string
  readonly objective: string
  readonly constraints?: ReadonlyArray<string>
  readonly criteria?: ReadonlyArray<string>
  readonly steps?: ReadonlyArray<{ readonly title: string; readonly description?: string }>
  readonly continuationPolicy?: GoalModel.ContinuationPolicy
  readonly auditorPolicy?: GoalModel.AuditorPolicy
  readonly actor?: GoalModel.AuditActor
}

export interface UpdateInput {
  readonly id: ID
  readonly expectedRevision: number
  readonly title?: string
  readonly objective?: string
  readonly constraints?: ReadonlyArray<string>
  readonly criteria?: ReadonlyArray<string>
  readonly steps?: ReadonlyArray<{ readonly title: string; readonly description?: string }>
  readonly continuationPolicy?: GoalModel.ContinuationPolicy
  readonly auditorPolicy?: GoalModel.AuditorPolicy
  readonly actor?: GoalModel.AuditActor
}

export interface CriterionUpdateInput {
  readonly goalID: ID
  readonly criterionID: GoalModel.CriterionID
  readonly expectedRevision: number
  readonly status: GoalModel.CriterionStatus
  readonly actor?: GoalModel.AuditActor
}

export interface StepUpdateInput {
  readonly goalID: ID
  readonly stepID: GoalModel.StepID
  readonly expectedRevision: number
  readonly status?: GoalModel.StepStatus
  readonly assignedSessionID?: typeof SessionTable.$inferSelect.id | null
  readonly actor?: GoalModel.AuditActor
}

export interface StepClaimInput {
  readonly goalID: ID
  readonly stepID: GoalModel.StepID
  readonly sessionID: typeof SessionTable.$inferSelect.id
  readonly expectedRevision: number
  readonly actor?: GoalModel.AuditActor
}

export interface EvidenceInput {
  readonly goalID: ID
  readonly expectedRevision: number
  readonly criterionID?: GoalModel.CriterionID
  readonly stepID?: GoalModel.StepID
  readonly type: string
  readonly sessionID?: typeof SessionTable.$inferSelect.id
  readonly messageID?: string
  readonly checkpointID?: string
  readonly path?: string
  readonly commitSHA?: string
  readonly summary: string
  readonly verdict?: string
  readonly actor?: GoalModel.AuditActor
}

export interface TransitionInput {
  readonly id: ID
  readonly expectedRevision: number
  readonly action: GoalStateMachine.Action
  readonly blocker?: string
  readonly actor?: GoalModel.AuditActor
}

export interface FocusInput {
  readonly goalID: ID
  readonly sessionID: typeof SessionTable.$inferSelect.id
  readonly role?: GoalModel.FocusRole
  readonly actor?: GoalModel.AuditActor
}

export type Error = GoalSchema.Error

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Detail, GoalSchema.ValidationError>
  readonly get: (id: ID) => Effect.Effect<Detail, GoalSchema.NotFoundError>
  readonly list: (input: {
    projectID: typeof ProjectTable.$inferSelect.id
    workspaceID?: typeof WorkspaceTable.$inferSelect.id
  }) => Effect.Effect<ReadonlyArray<Info>>
  readonly update: (
    input: UpdateInput,
  ) => Effect.Effect<Detail, GoalSchema.NotFoundError | GoalSchema.StaleRevisionError | GoalSchema.ValidationError>
  readonly transition: (
    input: TransitionInput,
  ) => Effect.Effect<Detail, GoalSchema.Error>
  readonly updateCriterion: (input: CriterionUpdateInput) => Effect.Effect<Detail, GoalSchema.Error>
  readonly updateStep: (input: StepUpdateInput) => Effect.Effect<Detail, GoalSchema.Error>
  readonly claimStep: (input: StepClaimInput) => Effect.Effect<Detail, GoalSchema.Error>
  readonly releaseStep: (input: StepClaimInput) => Effect.Effect<Detail, GoalSchema.Error>
  readonly addEvidence: (input: EvidenceInput) => Effect.Effect<GoalModel.Evidence, GoalSchema.Error>
  readonly evidence: (goalID: ID) => Effect.Effect<ReadonlyArray<GoalModel.Evidence>, GoalSchema.NotFoundError>
  readonly focus: (
    input: FocusInput,
  ) => Effect.Effect<Focus, GoalSchema.NotFoundError | GoalSchema.ValidationError>
  readonly unfocus: (input: {
    sessionID: typeof SessionTable.$inferSelect.id
    actor?: GoalModel.AuditActor
  }) => Effect.Effect<void>
  readonly focused: (
    sessionID: typeof SessionTable.$inferSelect.id,
  ) => Effect.Effect<{ focus: Focus; detail: Detail } | undefined>
  readonly focuses: (goalID: ID) => Effect.Effect<ReadonlyArray<Focus>>
  readonly audit: (goalID: ID) => Effect.Effect<ReadonlyArray<GoalModel.AuditEvent>, GoalSchema.NotFoundError>
  readonly recordAuditorVerdict: (input: {
    goalID: ID
    verdict: GoalModel.AuditorVerdict
    model?: import("../model").ModelV2.Ref
  }) => Effect.Effect<void, GoalSchema.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Goal") {}

type DatabaseExecutor = Omit<Database.DatabaseShape, "$client">

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const events = yield* EventV2.Service

    const detailTx = Effect.fnUntraced(function* (database: DatabaseExecutor, id: ID) {
      const row = yield* database
        .select()
        .from(GoalTable)
        .where(eq(GoalTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new GoalSchema.NotFoundError({ goalID: id })

      const [criteria, steps] = yield* Effect.all([
        database
          .select()
          .from(GoalCriterionTable)
          .where(eq(GoalCriterionTable.goal_id, id))
          .orderBy(asc(GoalCriterionTable.position))
          .all()
          .pipe(Effect.orDie),
        database
          .select()
          .from(GoalStepTable)
          .where(eq(GoalStepTable.goal_id, id))
          .orderBy(asc(GoalStepTable.position))
          .all()
          .pipe(Effect.orDie),
      ])
      return hydrateDetail(row, criteria, steps)
    })

    const appendAudit = Effect.fnUntraced(function* (
      database: DatabaseExecutor,
      input: {
        goalID: ID
        type: GoalModel.AuditEventType
        actor: GoalModel.AuditActor
        payload?: Record<string, unknown>
        now: number
      },
    ) {
      const current = yield* database
        .select({ seq: sql<number>`coalesce(max(${GoalEventTable.seq}), -1) + 1` })
        .from(GoalEventTable)
        .where(eq(GoalEventTable.goal_id, input.goalID))
        .get()
        .pipe(Effect.orDie)
      yield* database
        .insert(GoalEventTable)
        .values({
          id: GoalModel.AuditEventID.create(),
          goal_id: input.goalID,
          seq: current?.seq ?? 0,
          type: input.type,
          actor: input.actor,
          payload: input.payload ?? {},
          time_created: input.now,
        })
        .run()
        .pipe(Effect.orDie)
    })

    const create = Effect.fn("Goal.create")(function* (input: CreateInput) {
      const title = requiredText(input.title, "title")
      const objective = requiredText(input.objective, "objective")
      if (!title.ok) return yield* new GoalSchema.ValidationError({ reason: title.reason })
      if (!objective.ok) return yield* new GoalSchema.ValidationError({ reason: objective.reason })
      const constraints = normalizeStrings(input.constraints ?? [])
      if (!constraints.ok) return yield* new GoalSchema.ValidationError({ reason: constraints.reason })
      const criteria = normalizeStrings(input.criteria ?? [])
      if (!criteria.ok) return yield* new GoalSchema.ValidationError({ reason: criteria.reason })
      const steps = normalizeSteps(input.steps ?? [])
      if (!steps.ok) return yield* new GoalSchema.ValidationError({ reason: steps.reason })
      const policy = input.continuationPolicy ?? { mode: "manual" as const }
      const auditorPolicy = normalizeAuditorPolicy(input.auditorPolicy ?? {})
      if (!auditorPolicy.ok) return yield* new GoalSchema.ValidationError({ reason: auditorPolicy.reason })
      const id = GoalModel.ID.create()
      const now = Date.now()

      const detail = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const project = yield* tx
              .select({ id: ProjectTable.id })
              .from(ProjectTable)
              .where(eq(ProjectTable.id, input.projectID))
              .get()
              .pipe(Effect.orDie)
            if (!project) {
              return yield* new GoalSchema.ValidationError({ reason: `project does not exist: ${input.projectID}` })
            }
            if (input.workspaceID) {
              const workspace = yield* tx
                .select({ projectID: WorkspaceTable.project_id })
                .from(WorkspaceTable)
                .where(eq(WorkspaceTable.id, input.workspaceID))
                .get()
                .pipe(Effect.orDie)
              if (!workspace) {
                return yield* new GoalSchema.ValidationError({ reason: `workspace does not exist: ${input.workspaceID}` })
              }
              if (workspace.projectID !== input.projectID) {
                return yield* new GoalSchema.ValidationError({
                  reason: `workspace ${input.workspaceID} does not belong to project ${input.projectID}`,
                })
              }
            }

            yield* tx
              .insert(GoalTable)
              .values({
                id,
                project_id: input.projectID,
                workspace_id: input.workspaceID ?? null,
                title: title.value,
                objective: objective.value,
                constraints: constraints.value,
                continuation_policy: policy,
                auditor_policy: auditorPolicy.value,
                time_created: now,
                time_updated: now,
              })
              .run()
              .pipe(Effect.orDie)
            if (criteria.value.length > 0) {
              yield* tx
                .insert(GoalCriterionTable)
                .values(
                  criteria.value.map((description, position) => ({
                    id: GoalModel.CriterionID.create(),
                    goal_id: id,
                    position,
                    description,
                  })),
                )
                .run()
                .pipe(Effect.orDie)
            }
            if (steps.value.length > 0) {
              yield* tx
                .insert(GoalStepTable)
                .values(
                  steps.value.map((step, position) => ({
                    id: GoalModel.StepID.create(),
                    goal_id: id,
                    position,
                    title: step.title,
                    description: step.description,
                  })),
                )
                .run()
                .pipe(Effect.orDie)
            }
            yield* appendAudit(tx, {
              goalID: id,
              type: "created",
              actor: input.actor ?? "user",
              payload: { revision: 0 },
              now,
            })
            return yield* detailTx(tx, id).pipe(Effect.catchTag("Goal.NotFoundError", Effect.die))
          }),
        ).pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish(Event.Created, { goalID: id, info: detail.goal })
      return detail
    })

    const get = Effect.fn("Goal.get")(function* (id: ID) {
      return yield* detailTx(readDb, id)
    })

    const list = Effect.fn("Goal.list")(function* (input: {
      projectID: typeof ProjectTable.$inferSelect.id
      workspaceID?: typeof WorkspaceTable.$inferSelect.id
    }) {
      const where = input.workspaceID
        ? and(eq(GoalTable.project_id, input.projectID), eq(GoalTable.workspace_id, input.workspaceID))
        : eq(GoalTable.project_id, input.projectID)
      const rows = yield* readDb
        .select()
        .from(GoalTable)
        .where(where)
        .orderBy(desc(GoalTable.time_updated), desc(GoalTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(hydrateInfo)
    })

    const update = Effect.fn("Goal.update")(function* (input: UpdateInput) {
      if (
        input.title === undefined &&
        input.objective === undefined &&
        input.constraints === undefined &&
        input.criteria === undefined &&
        input.steps === undefined &&
        input.continuationPolicy === undefined &&
        input.auditorPolicy === undefined
      ) {
        return yield* new GoalSchema.ValidationError({ reason: "no Goal fields were supplied to update" })
      }
      const title = input.title === undefined ? undefined : requiredText(input.title, "title")
      if (title && !title.ok) return yield* new GoalSchema.ValidationError({ reason: title.reason })
      const objective = input.objective === undefined ? undefined : requiredText(input.objective, "objective")
      if (objective && !objective.ok) return yield* new GoalSchema.ValidationError({ reason: objective.reason })
      const constraints = input.constraints === undefined ? undefined : normalizeStrings(input.constraints)
      if (constraints && !constraints.ok) return yield* new GoalSchema.ValidationError({ reason: constraints.reason })
      const criteria = input.criteria === undefined ? undefined : normalizeStrings(input.criteria)
      if (criteria && !criteria.ok) return yield* new GoalSchema.ValidationError({ reason: criteria.reason })
      const steps = input.steps === undefined ? undefined : normalizeSteps(input.steps)
      if (steps && !steps.ok) return yield* new GoalSchema.ValidationError({ reason: steps.reason })
      const auditorPolicy = input.auditorPolicy === undefined ? undefined : normalizeAuditorPolicy(input.auditorPolicy)
      if (auditorPolicy && !auditorPolicy.ok) return yield* new GoalSchema.ValidationError({ reason: auditorPolicy.reason })
      const now = Date.now()

      const detail = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
          const current = yield* requireRow(tx, input.id)
          yield* requireRevision(input.id, current.revision, input.expectedRevision)
          if (GoalStateMachine.isTerminal(current.status) || current.status === "verifying") {
            return yield* new GoalSchema.ValidationError({
              reason: `specification cannot change while Goal is ${current.status}`,
            })
          }
          if ((criteria !== undefined || steps !== undefined) && current.status !== "draft") {
            return yield* new GoalSchema.ValidationError({
              reason: "acceptance criteria and execution steps can only be replaced while a Goal is draft",
            })
          }

          const updated = yield* tx
            .update(GoalTable)
            .set({
              ...(title?.ok ? { title: title.value } : {}),
              ...(objective?.ok ? { objective: objective.value } : {}),
              ...(constraints?.ok ? { constraints: constraints.value } : {}),
              ...(input.continuationPolicy ? { continuation_policy: input.continuationPolicy } : {}),
              ...(auditorPolicy?.ok ? { auditor_policy: auditorPolicy.value } : {}),
              revision: sql`${GoalTable.revision} + 1`,
              time_updated: now,
            })
            .where(and(eq(GoalTable.id, input.id), eq(GoalTable.revision, input.expectedRevision)))
            .returning({ revision: GoalTable.revision })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return yield* staleAfterCas(tx, input.id, input.expectedRevision)
          if (criteria?.ok) {
            yield* tx.delete(GoalCriterionTable).where(eq(GoalCriterionTable.goal_id, input.id)).run().pipe(Effect.orDie)
            if (criteria.value.length > 0) {
              yield* tx
                .insert(GoalCriterionTable)
                .values(
                  criteria.value.map((description, position) => ({
                    id: GoalModel.CriterionID.create(),
                    goal_id: input.id,
                    position,
                    description,
                  })),
                )
                .run()
                .pipe(Effect.orDie)
            }
          }
          if (steps?.ok) {
            yield* tx.delete(GoalStepTable).where(eq(GoalStepTable.goal_id, input.id)).run().pipe(Effect.orDie)
            if (steps.value.length > 0) {
              yield* tx
                .insert(GoalStepTable)
                .values(
                  steps.value.map((step, position) => ({
                    id: GoalModel.StepID.create(),
                    goal_id: input.id,
                    position,
                    title: step.title,
                    description: step.description,
                  })),
                )
                .run()
                .pipe(Effect.orDie)
            }
          }
          yield* appendAudit(tx, {
            goalID: input.id,
            type: "specification_updated",
            actor: input.actor ?? "user",
            payload: { revision: updated.revision },
            now,
          })
          return yield* detailTx(tx, input.id)
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish(Event.Updated, { goalID: input.id, info: detail.goal })
      return detail
    })

    const transition = Effect.fn("Goal.transition")(function* (input: TransitionInput) {
      const now = Date.now()
      const detail = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
          const current = yield* requireRow(tx, input.id)
          yield* requireRevision(input.id, current.revision, input.expectedRevision)
          const next = GoalStateMachine.next(current.status, input.action)
          if (!next) {
            return yield* new GoalSchema.InvalidTransitionError({
              goalID: input.id,
              status: current.status,
              action: input.action,
            })
          }

          if (input.action === "start") {
            const criterion = yield* tx
              .select({ id: GoalCriterionTable.id })
              .from(GoalCriterionTable)
              .where(eq(GoalCriterionTable.goal_id, input.id))
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            if (!criterion) {
              return yield* new GoalSchema.ValidationError({
                reason: "a Goal needs at least one acceptance criterion before it can start",
              })
            }
          }
          if (input.action === "block" && !input.blocker?.trim()) {
            return yield* new GoalSchema.ValidationError({ reason: "blocking a Goal requires a blocker reason" })
          }
          if (input.action === "verification_pass") {
            const incomplete = yield* tx
              .select({ id: GoalCriterionTable.id })
              .from(GoalCriterionTable)
              .where(and(eq(GoalCriterionTable.goal_id, input.id), sql`${GoalCriterionTable.status} != 'passed'`))
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            if (incomplete) {
              return yield* new GoalSchema.ValidationError({
                reason: "verification cannot complete until every acceptance criterion has passed",
              })
            }
            const criteria = yield* tx
              .select({ id: GoalCriterionTable.id })
              .from(GoalCriterionTable)
              .where(eq(GoalCriterionTable.goal_id, input.id))
              .all()
              .pipe(Effect.orDie)
            const evidenceRows = yield* tx
              .select({ criterionID: GoalEvidenceTable.criterion_id })
              .from(GoalEvidenceTable)
              .where(eq(GoalEvidenceTable.goal_id, input.id))
              .all()
              .pipe(Effect.orDie)
            const evidenced = new Set(evidenceRows.flatMap((row) => (row.criterionID ? [row.criterionID] : [])))
            const missingEvidence = criteria.find((criterion) => !evidenced.has(criterion.id))
            if (missingEvidence) {
              return yield* new GoalSchema.ValidationError({
                reason: "verification cannot complete until every acceptance criterion has supporting evidence",
              })
            }
          }

          const updated = yield* tx
            .update(GoalTable)
            .set({
              status: next,
              blocker: input.action === "block" ? input.blocker!.trim() : next === "active" ? null : current.blocker,
              revision: sql`${GoalTable.revision} + 1`,
              time_updated: now,
              time_completed: next === "completed" ? now : current.time_completed,
            })
            .where(and(eq(GoalTable.id, input.id), eq(GoalTable.revision, input.expectedRevision)))
            .returning({ revision: GoalTable.revision })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return yield* staleAfterCas(tx, input.id, input.expectedRevision)
          yield* appendAudit(tx, {
            goalID: input.id,
            type: "transitioned",
            actor: input.actor ?? "user",
            payload: { from: current.status, to: next, action: input.action, revision: updated.revision },
            now,
          })
          return yield* detailTx(tx, input.id)
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish(Event.Updated, { goalID: input.id, info: detail.goal })
      return detail
    })

    const updateCriterion = Effect.fn("Goal.updateCriterion")(function* (input: CriterionUpdateInput) {
      const now = Date.now()
      const detail = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* requireRow(tx, input.goalID)
            yield* requireRevision(input.goalID, current.revision, input.expectedRevision)
            if (GoalStateMachine.isTerminal(current.status)) {
              return yield* new GoalSchema.InvalidTransitionError({
                goalID: input.goalID,
                status: current.status,
                action: "update criterion",
              })
            }
            const criterion = yield* tx
              .select()
              .from(GoalCriterionTable)
              .where(and(eq(GoalCriterionTable.id, input.criterionID), eq(GoalCriterionTable.goal_id, input.goalID)))
              .get()
              .pipe(Effect.orDie)
            if (!criterion) return yield* new GoalSchema.ValidationError({ reason: `criterion does not belong to Goal: ${input.criterionID}` })
            yield* tx
              .update(GoalCriterionTable)
              .set({ status: input.status })
              .where(eq(GoalCriterionTable.id, input.criterionID))
              .run()
              .pipe(Effect.orDie)
            const updated = yield* bumpRevision(tx, input.goalID, input.expectedRevision, now)
            yield* appendAudit(tx, {
              goalID: input.goalID,
              type: "criterion_updated",
              actor: input.actor ?? "agent",
              payload: { criterionID: input.criterionID, from: criterion.status, to: input.status, revision: updated },
              now,
            })
            return yield* detailTx(tx, input.goalID)
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish(Event.Updated, { goalID: input.goalID, info: detail.goal })
      return detail
    })

    const updateStep = Effect.fn("Goal.updateStep")(function* (input: StepUpdateInput) {
      if (input.status === undefined && input.assignedSessionID === undefined) {
        return yield* new GoalSchema.ValidationError({ reason: "step update requires status and/or assignedSessionID" })
      }
      const now = Date.now()
      const detail = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* requireRow(tx, input.goalID)
            yield* requireRevision(input.goalID, current.revision, input.expectedRevision)
            if (GoalStateMachine.isTerminal(current.status)) {
              return yield* new GoalSchema.InvalidTransitionError({
                goalID: input.goalID,
                status: current.status,
                action: "update step",
              })
            }
            const step = yield* tx
              .select()
              .from(GoalStepTable)
              .where(and(eq(GoalStepTable.id, input.stepID), eq(GoalStepTable.goal_id, input.goalID)))
              .get()
              .pipe(Effect.orDie)
            if (!step) return yield* new GoalSchema.ValidationError({ reason: `step does not belong to Goal: ${input.stepID}` })
            if (input.assignedSessionID) {
              const session = yield* tx
                .select({ projectID: SessionTable.project_id, workspaceID: SessionTable.workspace_id })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.assignedSessionID))
                .get()
                .pipe(Effect.orDie)
              if (!session) return yield* new GoalSchema.ValidationError({ reason: `session does not exist: ${input.assignedSessionID}` })
              if (session.projectID !== current.project_id || (current.workspace_id && session.workspaceID !== current.workspace_id)) {
                return yield* new GoalSchema.ValidationError({ reason: "step assignment must stay inside the Goal scope" })
              }
            }
            const nextStatus = input.status ?? step.status
            yield* tx
              .update(GoalStepTable)
              .set({
                ...(input.status ? { status: input.status } : {}),
                ...(input.assignedSessionID !== undefined ? { assigned_session_id: input.assignedSessionID } : {}),
                time_started: nextStatus === "active" && step.time_started === null ? now : step.time_started,
                time_completed: nextStatus === "completed" ? now : nextStatus === "cancelled" ? now : null,
                attempts: nextStatus === "active" && step.status !== "active" ? step.attempts + 1 : step.attempts,
              })
              .where(eq(GoalStepTable.id, input.stepID))
              .run()
              .pipe(Effect.orDie)
            const updated = yield* bumpRevision(tx, input.goalID, input.expectedRevision, now)
            yield* appendAudit(tx, {
              goalID: input.goalID,
              type: "step_updated",
              actor: input.actor ?? "agent",
              payload: {
                stepID: input.stepID,
                from: step.status,
                to: nextStatus,
                assignedSessionID: input.assignedSessionID === undefined ? step.assigned_session_id : input.assignedSessionID,
                revision: updated,
              },
              now,
            })
            return yield* detailTx(tx, input.goalID)
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish(Event.Updated, { goalID: input.goalID, info: detail.goal })
      return detail
    })

    const claimStep = Effect.fn("Goal.claimStep")(function* (input: StepClaimInput) {
      const now = Date.now()
      const detail = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* requireRow(tx, input.goalID)
            yield* requireRevision(input.goalID, current.revision, input.expectedRevision)
            if (current.status !== "active") {
              return yield* new GoalSchema.ValidationError({ reason: `steps can only be claimed while Goal is active` })
            }
            const session = yield* tx
              .select({ projectID: SessionTable.project_id, workspaceID: SessionTable.workspace_id })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!session) return yield* new GoalSchema.ValidationError({ reason: `session does not exist: ${input.sessionID}` })
            if (session.projectID !== current.project_id || (current.workspace_id && session.workspaceID !== current.workspace_id)) {
              return yield* new GoalSchema.ValidationError({ reason: "step claim must stay inside the Goal scope" })
            }
            const step = yield* tx
              .select()
              .from(GoalStepTable)
              .where(and(eq(GoalStepTable.id, input.stepID), eq(GoalStepTable.goal_id, input.goalID)))
              .get()
              .pipe(Effect.orDie)
            if (!step) return yield* new GoalSchema.ValidationError({ reason: `step does not belong to Goal: ${input.stepID}` })
            if (step.status === "completed" || step.status === "cancelled") {
              return yield* new GoalSchema.ValidationError({ reason: `cannot claim a ${step.status} step` })
            }
            if (step.assigned_session_id && step.assigned_session_id !== input.sessionID) {
              return yield* new GoalSchema.ValidationError({
                reason: `step is already claimed by session ${step.assigned_session_id}`,
              })
            }
            if (step.assigned_session_id === input.sessionID && step.status === "active") return yield* detailTx(tx, input.goalID)
            yield* tx
              .update(GoalStepTable)
              .set({
                assigned_session_id: input.sessionID,
                status: "active",
                time_started: step.time_started ?? now,
                time_completed: null,
                attempts: step.status === "active" ? step.attempts : step.attempts + 1,
              })
              .where(eq(GoalStepTable.id, input.stepID))
              .run()
              .pipe(Effect.orDie)
            const revision = yield* bumpRevision(tx, input.goalID, input.expectedRevision, now)
            yield* appendAudit(tx, {
              goalID: input.goalID,
              type: "step_updated",
              actor: input.actor ?? "agent",
              payload: {
                stepID: input.stepID,
                from: step.status,
                to: "active",
                assignedSessionID: input.sessionID,
                claim: true,
                revision,
              },
              now,
            })
            return yield* detailTx(tx, input.goalID)
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish(Event.Updated, { goalID: input.goalID, info: detail.goal })
      return detail
    })

    const releaseStep = Effect.fn("Goal.releaseStep")(function* (input: StepClaimInput) {
      const now = Date.now()
      const detail = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* requireRow(tx, input.goalID)
            yield* requireRevision(input.goalID, current.revision, input.expectedRevision)
            const step = yield* tx
              .select()
              .from(GoalStepTable)
              .where(and(eq(GoalStepTable.id, input.stepID), eq(GoalStepTable.goal_id, input.goalID)))
              .get()
              .pipe(Effect.orDie)
            if (!step) return yield* new GoalSchema.ValidationError({ reason: `step does not belong to Goal: ${input.stepID}` })
            if (step.assigned_session_id !== input.sessionID) {
              return yield* new GoalSchema.ValidationError({ reason: "a worker may only release its own step claim" })
            }
            if (step.status === "completed" || step.status === "cancelled") {
              return yield* new GoalSchema.ValidationError({ reason: `cannot release a ${step.status} step` })
            }
            yield* tx
              .update(GoalStepTable)
              .set({ assigned_session_id: null, status: "pending", time_completed: null })
              .where(eq(GoalStepTable.id, input.stepID))
              .run()
              .pipe(Effect.orDie)
            const revision = yield* bumpRevision(tx, input.goalID, input.expectedRevision, now)
            yield* appendAudit(tx, {
              goalID: input.goalID,
              type: "step_updated",
              actor: input.actor ?? "agent",
              payload: {
                stepID: input.stepID,
                from: step.status,
                to: "pending",
                assignedSessionID: null,
                release: true,
                revision,
              },
              now,
            })
            return yield* detailTx(tx, input.goalID)
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish(Event.Updated, { goalID: input.goalID, info: detail.goal })
      return detail
    })

    const addEvidence = Effect.fn("Goal.addEvidence")(function* (input: EvidenceInput) {
      const type = requiredText(input.type, "evidence type")
      const summary = requiredText(input.summary, "evidence summary")
      if (!type.ok) return yield* new GoalSchema.ValidationError({ reason: type.reason })
      if (!summary.ok) return yield* new GoalSchema.ValidationError({ reason: summary.reason })
      if (!input.criterionID && !input.stepID) {
        return yield* new GoalSchema.ValidationError({ reason: "evidence must reference a criterion and/or step" })
      }
      const now = Date.now()
      const evidence = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* requireRow(tx, input.goalID)
            yield* requireRevision(input.goalID, current.revision, input.expectedRevision)
            if (input.criterionID) {
              const criterion = yield* tx
                .select({ id: GoalCriterionTable.id })
                .from(GoalCriterionTable)
                .where(and(eq(GoalCriterionTable.id, input.criterionID), eq(GoalCriterionTable.goal_id, input.goalID)))
                .get()
                .pipe(Effect.orDie)
              if (!criterion) return yield* new GoalSchema.ValidationError({ reason: `criterion does not belong to Goal: ${input.criterionID}` })
            }
            if (input.stepID) {
              const step = yield* tx
                .select({ id: GoalStepTable.id })
                .from(GoalStepTable)
                .where(and(eq(GoalStepTable.id, input.stepID), eq(GoalStepTable.goal_id, input.goalID)))
                .get()
                .pipe(Effect.orDie)
              if (!step) return yield* new GoalSchema.ValidationError({ reason: `step does not belong to Goal: ${input.stepID}` })
            }
            const id = GoalModel.EvidenceID.create()
            yield* tx
              .insert(GoalEvidenceTable)
              .values({
                id,
                goal_id: input.goalID,
                criterion_id: input.criterionID ?? null,
                step_id: input.stepID ?? null,
                type: type.value,
                session_id: input.sessionID ?? null,
                message_id: input.messageID ?? null,
                checkpoint_id: input.checkpointID ?? null,
                path: input.path ?? null,
                commit_sha: input.commitSHA ?? null,
                summary: summary.value,
                verdict: input.verdict?.trim() || null,
                time_created: now,
              })
              .run()
              .pipe(Effect.orDie)
            const revision = yield* bumpRevision(tx, input.goalID, input.expectedRevision, now)
            yield* appendAudit(tx, {
              goalID: input.goalID,
              type: "evidence_added",
              actor: input.actor ?? "agent",
              payload: { evidenceID: id, criterionID: input.criterionID, stepID: input.stepID, revision },
              now,
            })
            return hydrateEvidence({
              id,
              goal_id: input.goalID,
              criterion_id: input.criterionID ?? null,
              step_id: input.stepID ?? null,
              type: type.value,
              session_id: input.sessionID ?? null,
              message_id: input.messageID ?? null,
              checkpoint_id: input.checkpointID ?? null,
              path: input.path ?? null,
              commit_sha: input.commitSHA ?? null,
              summary: summary.value,
              verdict: input.verdict?.trim() || null,
              time_created: now,
            })
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      const current = yield* detailTx(db, input.goalID).pipe(Effect.catchTag("Goal.NotFoundError", Effect.die))
      yield* events.publish(Event.Updated, { goalID: input.goalID, info: current.goal })
      return evidence
    })

    const evidence = Effect.fn("Goal.evidence")(function* (goalID: ID) {
      yield* requireRow(db, goalID)
      const rows = yield* db
        .select()
        .from(GoalEvidenceTable)
        .where(eq(GoalEvidenceTable.goal_id, goalID))
        .orderBy(asc(GoalEvidenceTable.time_created), asc(GoalEvidenceTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(hydrateEvidence)
    })

    const focus = Effect.fn("Goal.focus")(function* (input: FocusInput) {
      const now = Date.now()
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
          const goal = yield* requireRow(tx, input.goalID)
          if (GoalStateMachine.isTerminal(goal.status)) {
            return yield* new GoalSchema.ValidationError({ reason: `cannot focus a ${goal.status} Goal` })
          }
          const session = yield* tx
            .select({ projectID: SessionTable.project_id, workspaceID: SessionTable.workspace_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!session) return yield* new GoalSchema.ValidationError({ reason: `session does not exist: ${input.sessionID}` })
          if (session.projectID !== goal.project_id) {
            return yield* new GoalSchema.ValidationError({ reason: "Goal and Session belong to different projects" })
          }
          if (goal.workspace_id && session.workspaceID !== goal.workspace_id) {
            return yield* new GoalSchema.ValidationError({ reason: "workspace-scoped Goal cannot focus a Session in another workspace" })
          }

          const existing = yield* tx
            .select()
            .from(GoalFocusTable)
            .where(eq(GoalFocusTable.session_id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          const role = input.role ?? "owner"
          if (existing?.goal_id === input.goalID && existing.role === role) {
            return { focus: hydrateFocus(existing), previousGoalID: undefined as ID | undefined, changed: false }
          }

          if (existing && existing.goal_id !== input.goalID) {
            yield* appendAudit(tx, {
              goalID: existing.goal_id,
              type: "unfocused",
              actor: input.actor ?? "user",
              payload: { sessionID: input.sessionID },
              now,
            })
          }
          yield* tx
            .insert(GoalFocusTable)
            .values({ session_id: input.sessionID, goal_id: input.goalID, role, focused_at: now })
            .onConflictDoUpdate({
              target: GoalFocusTable.session_id,
              set: { goal_id: input.goalID, role, focused_at: now },
            })
            .run()
            .pipe(Effect.orDie)
          yield* appendAudit(tx, {
            goalID: input.goalID,
            type: "focused",
            actor: input.actor ?? "user",
            payload: { sessionID: input.sessionID, role },
            now,
          })
          return {
            focus: hydrateFocus({ session_id: input.sessionID, goal_id: input.goalID, role, focused_at: now }),
            previousGoalID: existing?.goal_id,
            changed: true,
          }
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      if (result.changed) {
        if (result.previousGoalID && result.previousGoalID !== input.goalID) {
          yield* events.publish(Event.Unfocused, { goalID: result.previousGoalID, sessionID: input.sessionID })
        }
        yield* events.publish(Event.Focused, { goalID: input.goalID, sessionID: input.sessionID, role: result.focus.role })
      }
      return result.focus
    })

    const unfocus = Effect.fn("Goal.unfocus")(function* (input: {
      sessionID: typeof SessionTable.$inferSelect.id
      actor?: GoalModel.AuditActor
    }) {
      const now = Date.now()
      const previous = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(GoalFocusTable)
            .where(eq(GoalFocusTable.session_id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!existing) return undefined
          yield* tx.delete(GoalFocusTable).where(eq(GoalFocusTable.session_id, input.sessionID)).run().pipe(Effect.orDie)
          yield* appendAudit(tx, {
            goalID: existing.goal_id,
            type: "unfocused",
            actor: input.actor ?? "user",
            payload: { sessionID: input.sessionID },
            now,
          })
          return existing.goal_id
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      if (previous) yield* events.publish(Event.Unfocused, { goalID: previous, sessionID: input.sessionID })
    })

    const focused = Effect.fn("Goal.focused")(function* (sessionID: typeof SessionTable.$inferSelect.id) {
      const row = yield* readDb
        .select()
        .from(GoalFocusTable)
        .where(eq(GoalFocusTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      const detail = yield* detailTx(readDb, row.goal_id).pipe(Effect.catchTag("Goal.NotFoundError", Effect.die))
      return { focus: hydrateFocus(row), detail }
    })

    const focuses = Effect.fn("Goal.focuses")(function* (goalID: ID) {
      const rows = yield* readDb
        .select()
        .from(GoalFocusTable)
        .where(eq(GoalFocusTable.goal_id, goalID))
        .orderBy(asc(GoalFocusTable.focused_at), asc(GoalFocusTable.session_id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(hydrateFocus)
    })

    const audit = Effect.fn("Goal.audit")(function* (goalID: ID) {
      yield* requireRow(readDb, goalID)
      const rows = yield* readDb
        .select()
        .from(GoalEventTable)
        .where(eq(GoalEventTable.goal_id, goalID))
        .orderBy(asc(GoalEventTable.seq))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        goalID: row.goal_id,
        seq: row.seq,
        type: row.type,
        actor: row.actor,
        payload: row.payload,
        createdAt: DateTime.makeUnsafe(row.time_created),
      }))
    })

    const recordAuditorVerdict = Effect.fn("Goal.recordAuditorVerdict")(function* (input: {
      goalID: ID
      verdict: GoalModel.AuditorVerdict
      model?: import("../model").ModelV2.Ref
    }) {
      yield* requireRow(db, input.goalID)
      yield* db
        .transaction((tx) =>
          appendAudit(tx, {
            goalID: input.goalID,
            type: "audited",
            actor: "auditor",
            payload: {
              decision: input.verdict.decision,
              rationale: input.verdict.rationale,
              progressMade: input.verdict.progressMade,
              ...(input.verdict.confidence === undefined ? {} : { confidence: input.verdict.confidence }),
              ...(input.verdict.decision === "blocked" ? { blocker: input.verdict.blocker } : {}),
              ...(input.verdict.decision === "continue" || input.verdict.decision === "blocked"
                ? { continuationPrompt: input.verdict.continuationPrompt }
                : {}),
              ...(input.model
                ? { model: { providerID: input.model.providerID, id: input.model.id, variant: input.model.variant } }
                : {}),
            },
            now: Date.now(),
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({
      create,
      get,
      list,
      update,
      transition,
      updateCriterion,
      updateStep,
      claimStep,
      releaseStep,
      addEvidence,
      evidence,
      focus,
      unfocus,
      focused,
      focuses,
      audit,
      recordAuditorVerdict,
    })
  }),
)

function requireRow(database: DatabaseExecutor, id: ID) {
  return database
    .select()
    .from(GoalTable)
    .where(eq(GoalTable.id, id))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(new GoalSchema.NotFoundError({ goalID: id })))),
    )
}

function requireRevision(id: ID, actual: number, expected: number) {
  return actual === expected
    ? Effect.void
    : Effect.fail(new GoalSchema.StaleRevisionError({ goalID: id, expectedRevision: expected, actualRevision: actual }))
}

function staleAfterCas(
  database: DatabaseExecutor,
  id: ID,
  expectedRevision: number,
): Effect.Effect<never, GoalSchema.NotFoundError | GoalSchema.StaleRevisionError> {
  return Effect.gen(function* () {
    const row = yield* database
      .select({ revision: GoalTable.revision })
      .from(GoalTable)
      .where(eq(GoalTable.id, id))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new GoalSchema.NotFoundError({ goalID: id })
    return yield* new GoalSchema.StaleRevisionError({
      goalID: id,
      expectedRevision,
      actualRevision: row.revision,
    })
  })
}

function bumpRevision(database: DatabaseExecutor, id: ID, expectedRevision: number, now: number) {
  return database
    .update(GoalTable)
    .set({ revision: sql`${GoalTable.revision} + 1`, time_updated: now })
    .where(and(eq(GoalTable.id, id), eq(GoalTable.revision, expectedRevision)))
    .returning({ revision: GoalTable.revision })
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row ? Effect.succeed(row.revision) : staleAfterCas(database, id, expectedRevision))),
    )
}

function hydrateInfo(row: typeof GoalTable.$inferSelect): Info {
  return {
    id: row.id,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    title: row.title,
    objective: row.objective,
    constraints: row.constraints,
    status: row.status,
    revision: row.revision,
    continuationPolicy: row.continuation_policy,
    auditorPolicy: row.auditor_policy,
    blocker: row.blocker ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
    },
  }
}

function hydrateDetail(
  row: typeof GoalTable.$inferSelect,
  criteria: ReadonlyArray<typeof GoalCriterionTable.$inferSelect>,
  steps: ReadonlyArray<typeof GoalStepTable.$inferSelect>,
): Detail {
  return {
    goal: hydrateInfo(row),
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      position: criterion.position,
      description: criterion.description,
      status: criterion.status,
    })),
    steps: steps.map((step) => ({
      id: step.id,
      position: step.position,
      title: step.title,
      description: step.description,
      status: step.status,
      assignedSessionID: step.assigned_session_id ?? undefined,
      attempts: step.attempts,
      time: {
        started: step.time_started === null ? undefined : DateTime.makeUnsafe(step.time_started),
        completed: step.time_completed === null ? undefined : DateTime.makeUnsafe(step.time_completed),
      },
    })),
  }
}

function hydrateFocus(row: typeof GoalFocusTable.$inferSelect): Focus {
  return {
    sessionID: row.session_id,
    goalID: row.goal_id,
    role: row.role,
    focusedAt: DateTime.makeUnsafe(row.focused_at),
  }
}

function hydrateEvidence(row: typeof GoalEvidenceTable.$inferSelect): GoalModel.Evidence {
  return {
    id: row.id,
    goalID: row.goal_id,
    criterionID: row.criterion_id ?? undefined,
    stepID: row.step_id ?? undefined,
    type: row.type,
    sessionID: row.session_id ? GoalModel.Focus.fields.sessionID.make(row.session_id) : undefined,
    messageID: row.message_id ?? undefined,
    checkpointID: row.checkpoint_id ?? undefined,
    path: row.path ?? undefined,
    commitSHA: row.commit_sha ?? undefined,
    summary: row.summary,
    verdict: row.verdict ?? undefined,
    createdAt: DateTime.makeUnsafe(row.time_created),
  }
}

type Normalized<T> = { ok: true; value: T } | { ok: false; reason: string }

function requiredText(value: string, field: string): Normalized<string> {
  const text = value.trim()
  return text ? { ok: true, value: text } : { ok: false, reason: `${field} is required` }
}

function normalizeStrings(values: ReadonlyArray<string>): Normalized<string[]> {
  const result: string[] = []
  for (const value of values) {
    const text = value.trim()
    if (!text) return { ok: false, reason: "Goal list values cannot be empty" }
    result.push(text)
  }
  return { ok: true, value: result }
}

function normalizeSteps(
  values: ReadonlyArray<{ readonly title: string; readonly description?: string }>,
): Normalized<Array<{ title: string; description: string }>> {
  const result: Array<{ title: string; description: string }> = []
  for (const value of values) {
    const title = value.title.trim()
    if (!title) return { ok: false, reason: "Goal step title cannot be empty" }
    result.push({ title, description: value.description?.trim() ?? "" })
  }
  return { ok: true, value: result }
}

function normalizeAuditorPolicy(value: GoalModel.AuditorPolicy): Normalized<GoalModel.AuditorPolicy> {
  const blockedThreshold = value.blockedThreshold
  if (blockedThreshold !== undefined && (!Number.isFinite(blockedThreshold) || blockedThreshold < 1 || blockedThreshold > 16)) {
    return { ok: false, reason: "auditor blockedThreshold must be between 1 and 16" }
  }
  const maxAttempts = value.maxAttempts
  if (maxAttempts !== undefined && (!Number.isFinite(maxAttempts) || maxAttempts < 1 || maxAttempts > 8)) {
    return { ok: false, reason: "auditor maxAttempts must be between 1 and 8" }
  }
  return {
    ok: true,
    value: {
      ...(value.model ? { model: value.model } : {}),
      ...(blockedThreshold === undefined ? {} : { blockedThreshold: Math.floor(blockedThreshold) }),
      ...(maxAttempts === undefined ? {} : { maxAttempts: Math.floor(maxAttempts) }),
    },
  }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
