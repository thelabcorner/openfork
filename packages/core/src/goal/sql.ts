import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Goal } from "@opencode-ai/schema/goal"
import { ProjectTable } from "../project/sql"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionTable } from "../session/sql"

export const GoalTable = sqliteTable(
  "goal",
  {
    id: text().$type<Goal.ID>().primaryKey(),
    project_id: text()
      .$type<typeof ProjectTable.$inferSelect.id>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text()
      .$type<typeof WorkspaceTable.$inferSelect.id>()
      .references(() => WorkspaceTable.id, { onDelete: "set null" }),
    title: text().notNull(),
    objective: text().notNull(),
    constraints: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    status: text().$type<Goal.Status>().notNull().default("draft"),
    revision: integer().notNull().default(0),
    continuation_policy: text({ mode: "json" })
      .$type<Goal.ContinuationPolicy>()
      .notNull()
      .default({ mode: "manual" }),
    auditor_policy: text({ mode: "json" }).$type<Goal.AuditorPolicy>().notNull().default({}),
    blocker: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
    time_completed: integer(),
  },
  (table) => [
    index("goal_project_status_updated_idx").on(table.project_id, table.status, table.time_updated),
    index("goal_workspace_status_updated_idx").on(table.workspace_id, table.status, table.time_updated),
  ],
)

export const GoalCriterionTable = sqliteTable(
  "goal_criterion",
  {
    id: text().$type<Goal.CriterionID>().primaryKey(),
    goal_id: text()
      .$type<Goal.ID>()
      .notNull()
      .references(() => GoalTable.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    description: text().notNull(),
    status: text().$type<Goal.CriterionStatus>().notNull().default("pending"),
  },
  (table) => [
    uniqueIndex("goal_criterion_goal_position_idx").on(table.goal_id, table.position),
    index("goal_criterion_goal_status_idx").on(table.goal_id, table.status),
  ],
)

export const GoalStepTable = sqliteTable(
  "goal_step",
  {
    id: text().$type<Goal.StepID>().primaryKey(),
    goal_id: text()
      .$type<Goal.ID>()
      .notNull()
      .references(() => GoalTable.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    status: text().$type<Goal.StepStatus>().notNull().default("pending"),
    assigned_session_id: text()
      .$type<typeof SessionTable.$inferSelect.id>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    attempts: integer().notNull().default(0),
    time_started: integer(),
    time_completed: integer(),
  },
  (table) => [
    uniqueIndex("goal_step_goal_position_idx").on(table.goal_id, table.position),
    index("goal_step_goal_status_idx").on(table.goal_id, table.status),
    index("goal_step_session_idx").on(table.assigned_session_id),
  ],
)

/** One focused Goal per Session; one Goal may be focused by many Sessions. */
export const GoalFocusTable = sqliteTable(
  "goal_focus",
  {
    session_id: text()
      .$type<typeof SessionTable.$inferSelect.id>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    goal_id: text()
      .$type<Goal.ID>()
      .notNull()
      .references(() => GoalTable.id, { onDelete: "cascade" }),
    role: text().$type<Goal.FocusRole>().notNull().default("owner"),
    focused_at: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [index("goal_focus_goal_idx").on(table.goal_id)],
)

/**
 * Durable continuation cursor for Goal Mode.
 *
 * A reservation is written after a completed provider cycle and claimed before
 * the next autonomous cycle begins. Keeping the operational cursor separate
 * from Goal specification state means a process crash cannot manufacture Goal
 * progress, and user-owned Goal revisions remain independent from runner
 * bookkeeping.
 */
export const GoalAutomationTable = sqliteTable(
  "goal_automation",
  {
    session_id: text()
      .$type<typeof SessionTable.$inferSelect.id>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    goal_id: text()
      .$type<Goal.ID>()
      .notNull()
      .references(() => GoalTable.id, { onDelete: "cascade" }),
    started_at: integer().notNull(),
    consecutive_turns: integer().notNull().default(0),
    no_progress_turns: integer().notNull().default(0),
    auditor_blocked_streak: integer().notNull().default(0),
    consumed_tokens: integer().notNull().default(0),
    last_auditor_decision: text().$type<Goal.AuditorDecision>(),
    last_auditor_rationale: text(),
    previous_revision: integer(),
    reservation_id: text(),
    reservation_owner: text(),
    reservation_created_at: integer(),
    continuation_prompt: text(),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("goal_automation_goal_idx").on(table.goal_id),
    uniqueIndex("goal_automation_reservation_idx").on(table.reservation_id),
  ],
)

/**
 * Evidence deliberately keeps external references as scalar IDs instead of
 * foreign keys. Session/checkpoint/message cleanup must not erase the fact that
 * evidence existed when the Goal was verified.
 */
export const GoalEvidenceTable = sqliteTable(
  "goal_evidence",
  {
    id: text().$type<Goal.EvidenceID>().primaryKey(),
    goal_id: text()
      .$type<Goal.ID>()
      .notNull()
      .references(() => GoalTable.id, { onDelete: "cascade" }),
    criterion_id: text().$type<Goal.CriterionID>(),
    step_id: text().$type<Goal.StepID>(),
    type: text().notNull(),
    session_id: text(),
    message_id: text(),
    checkpoint_id: text(),
    path: text(),
    commit_sha: text(),
    summary: text().notNull(),
    verdict: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("goal_evidence_goal_created_idx").on(table.goal_id, table.time_created),
    index("goal_evidence_criterion_idx").on(table.criterion_id),
    index("goal_evidence_step_idx").on(table.step_id),
  ],
)

/** Append-only Goal-domain audit history, separate from transient UI events. */
export const GoalEventTable = sqliteTable(
  "goal_event",
  {
    id: text().$type<Goal.AuditEventID>().primaryKey(),
    goal_id: text()
      .$type<Goal.ID>()
      .notNull()
      .references(() => GoalTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    type: text().$type<Goal.AuditEventType>().notNull(),
    actor: text().$type<Goal.AuditActor>().notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("goal_event_goal_seq_idx").on(table.goal_id, table.seq),
    index("goal_event_goal_created_idx").on(table.goal_id, table.time_created),
  ],
)
