import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { Goal } from "@opencode-ai/schema/goal"
import { SessionID } from "@opencode-ai/schema/session-id"
import { ProjectTable } from "../project/sql"
import * as DatabasePath from "../database/path"

/**
 * User-owned durable schedule specification.
 *
 * Writer: the user (or a loop file). Lifetime: until deleted.
 */
export const ScheduledTaskTable = sqliteTable(
  "scheduled_task",
  {
    id: text().$type<ScheduledTask.ID>().primaryKey(),

    // Nullable: a global task ("every Monday, summarize all projects") is a
    // real use case. A project-scoped task cascades away with its project.
    project_id: text()
      .$type<typeof ProjectTable.$inferSelect.id>()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),

    // Explicit target directory. NOT NULL by construction: a task with no
    // directory must fail to fire, never fall back to process.cwd().
    target_directory: DatabasePath.absoluteColumn().notNull(),
    // Isolation mode: directory | worktree (+ baseRef/reuse). The directory
    // above is the source repo in worktree mode.
    target: text({ mode: "json" }).$type<ScheduledTask.Target>().notNull(),
    session_policy: text({ mode: "json" })
      .$type<ScheduledTask.SessionPolicy>()
      .notNull()
      .default({ kind: "new" }),

    name: text().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(false),
    revision: integer().notNull().default(0),

    schedule: text({ mode: "json" }).$type<ScheduledTask.Schedule>().notNull(),
    timezone: text(),

    action: text({ mode: "json" }).$type<ScheduledTask.Action>().notNull(),
    // Effective policy: every field is written explicitly (no hidden defaults).
    policy: text({ mode: "json" }).$type<ScheduledTask.ResolvedPolicy>().notNull(),

    // THE DUE CURSOR. Materialized so "what is due?" is an index range scan,
    // not N recurrence evaluations. NULL = not scheduled (disabled, or an
    // exhausted `once`).
    next_run_at: integer(),

    // Denormalized projection written by settlement so a list row never
    // queries the runs table.
    last_run_at: integer(),
    last_run_status: text().$type<ScheduledTask.RunStatus>(),
    last_run_id: text().$type<ScheduledTask.RunID>(),
    consecutive_failures: integer().notNull().default(0),

    // Creation provenance. source_message_id is intentionally scalar-only:
    // pruning its originating conversation must not erase schedule attribution.
    source: text().$type<"api" | "agent" | "oxp" | "loop_file">().notNull().default("api"),
    source_path: text(),
    source_message_id: text(),
    source_ref: text(),
    source_principal: text(),

    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    // THE scan index: `WHERE enabled = 1 AND next_run_at <= :now ORDER BY next_run_at`.
    index("scheduled_task_due_idx").on(table.enabled, table.next_run_at),
    index("scheduled_task_project_idx").on(table.project_id, table.name),
    uniqueIndex("scheduled_task_source_path_idx").on(table.source_path),
  ],
)

/**
 * Runner-owned reusable Session anchor.
 *
 * This is operational state, not task specification: changing/rotating an
 * anchor must never bump the user-owned task revision. session_id is
 * intentionally scalar-only so Session pruning cannot delete the task.
 */
export const ScheduledTaskSessionBindingTable = sqliteTable(
  "scheduled_task_session_binding",
  {
    task_id: text()
      .$type<ScheduledTask.ID>()
      .primaryKey()
      .references(() => ScheduledTaskTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionID>().notNull(),
    task_revision: integer().notNull(),
    user_seq_fence: integer(),
    generation: integer().notNull().default(1),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [uniqueIndex("scheduled_task_session_binding_session_idx").on(table.session_id)],
)

/**
 * Runtime claim cursor. Writer: the runner. Lifetime: one firing attempt.
 *
 * Deliberately separate from the specification row so a process crash cannot
 * manufacture progress and user-owned revisions never race runner bookkeeping.
 * The `task_id` primary key IS the mutual-exclusion primitive: one lease per
 * task, so a task can never run two instants concurrently.
 */
export const ScheduledTaskLeaseTable = sqliteTable(
  "scheduled_task_lease",
  {
    task_id: text()
      .$type<ScheduledTask.ID>()
      .primaryKey()
      .references(() => ScheduledTaskTable.id, { onDelete: "cascade" }),
    // The logical instant this lease is firing FOR — the scheduled instant,
    // not "now". Carried into the run row for catch-up/idempotency semantics.
    fire_for: integer().notNull(),
    lease_id: text().notNull(),
    // PROCESS_OWNER_ID when held; NULL when released or awaiting a retry.
    owner: text(),
    acquired_at: integer().notNull(),
    heartbeat_at: integer().notNull(),
    attempt: integer().notNull().default(1),
  },
  (table) => [
    uniqueIndex("scheduled_task_lease_id_idx").on(table.lease_id),
    index("scheduled_task_lease_heartbeat_idx").on(table.heartbeat_at),
  ],
)

/**
 * Append-only outcome history. Writer: the executor. Lifetime: retention-pruned.
 *
 * External references (session_id, goal_id, workspace_id) are scalar IDs, not
 * foreign keys: pruning an execution aggregate must not erase run history.
 */
export const ScheduledTaskRunTable = sqliteTable(
  "scheduled_task_run",
  {
    id: text().$type<ScheduledTask.RunID>().primaryKey(),
    task_id: text()
      .$type<ScheduledTask.ID>()
      .notNull()
      .references(() => ScheduledTaskTable.id, { onDelete: "cascade" }),

    // The logical scheduled instant. With the unique index below this is the
    // idempotency key: the database itself refuses a second run for the same
    // instant even if every layer above it has a bug.
    fire_for: integer().notNull(),
    trigger: text().$type<ScheduledTask.Trigger>().notNull(),

    status: text().$type<ScheduledTask.RunStatus>().notNull(),

    session_id: text(),
    goal_id: text().$type<Goal.ID>(),
    workspace_id: text(),
    directory: text(),

    skip_reason: text().$type<ScheduledTask.SkipReason>(),
    error_kind: text().$type<ScheduledTask.ErrorKind>(),
    error_message: text(),
    attempt: integer().notNull().default(1),

    // Inbox read state, owned server-side so it converges across clients.
    acknowledged_at: integer(),

    started_at: integer().notNull(),
    finished_at: integer(),
  },
  (table) => [
    // IDEMPOTENCY. The single most important constraint in the feature.
    uniqueIndex("scheduled_task_run_logical_idx").on(table.task_id, table.fire_for),
    uniqueIndex("scheduled_task_run_goal_idx").on(table.goal_id),
    index("scheduled_task_run_task_started_idx").on(table.task_id, table.started_at),
    // Global newest-first inbox scan (no acknowledged_at predicate).
    index("scheduled_task_run_started_idx").on(table.started_at, table.id),
    // Inbox query: unacknowledged runs, newest first.
    index("scheduled_task_run_inbox_idx").on(table.acknowledged_at, table.started_at),
  ],
)

/**
 * Singleton global scheduling control (kill switch). Durable so it converges
 * across every client and process that shares the database.
 */
export const ScheduledTaskControlTable = sqliteTable("scheduled_task_control", {
  id: text().$type<"global">().primaryKey(),
  paused: integer({ mode: "boolean" }).notNull().default(false),
  // Monotonic cross-process invalidation epoch. SQLite triggers advance this
  // atomically with scheduler mutations; it is internal coordination state,
  // not part of the public Control projection.
  generation: integer().notNull().default(0),
  time_updated: integer()
    .notNull()
    .$default(() => Date.now()),
})
