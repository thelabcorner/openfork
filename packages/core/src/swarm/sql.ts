import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { ProjectTable } from "../project/sql"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionTable } from "../session/sql"
import * as DatabasePath from "../database/path"

/**
 * Durable Swarm specification. This row owns collaboration intent, never live
 * Session busy/model state.
 */
export const SwarmTable = sqliteTable(
  "swarm",
  {
    id: text().$type<Swarm.ID>().primaryKey(),
    project_id: text()
      .$type<typeof ProjectTable.$inferSelect.id>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: DatabasePath.absoluteColumn().notNull(),
    workspace_id: text()
      .$type<typeof WorkspaceTable.$inferSelect.id>()
      .references(() => WorkspaceTable.id, { onDelete: "set null" }),
    name: text().notNull(),
    status: text().$type<Swarm.Status>().notNull().default("creating"),
    // Logical member identity. Deliberately not a Session pointer.
    coordinator_member_id: text().$type<Swarm.MemberID>(),
    policy: text({ mode: "json" }).$type<Swarm.Policy>().notNull().default({}),
    revision: integer().notNull().default(0),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
    time_completed: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("swarm_project_status_updated_idx").on(table.project_id, table.status, table.time_updated),
    index("swarm_workspace_idx").on(table.workspace_id, table.status, table.time_updated),
  ],
)

/**
 * Stable logical roster identity. Session bindings are nullable/rebindable and
 * generation-fenced; deleting a Session never deletes the member.
 */
export const SwarmMemberTable = sqliteTable(
  "swarm_member",
  {
    id: text().$type<Swarm.MemberID>().primaryKey(),
    swarm_id: text()
      .$type<Swarm.ID>()
      .notNull()
      .references(() => SwarmTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    kind: text().$type<Swarm.MemberKind>().notNull(),
    role: text().notNull(),
    lifecycle: text().$type<Swarm.MemberLifecycle>().notNull().default("active"),
    session_id: text()
      .$type<typeof SessionTable.$inferSelect.id>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    binding_generation: integer().notNull().default(0),
    desired_profile: text({ mode: "json" }).$type<Swarm.MemberExecutionProfile>(),
    workspace_policy: text({ mode: "json" }).$type<Swarm.WorkspacePolicy>().notNull(),
    capabilities: text({ mode: "json" }).$type<Swarm.MemberCapabilities>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
    time_stopped: integer(),
  },
  (table) => [
    uniqueIndex("swarm_member_name_idx").on(table.swarm_id, table.name),
    uniqueIndex("swarm_member_bound_session_idx")
      .on(table.swarm_id, table.session_id)
      .where(sql`${table.session_id} IS NOT NULL`),
    index("swarm_member_session_idx").on(table.session_id),
    index("swarm_member_roster_idx").on(table.swarm_id, table.lifecycle, table.kind, table.time_created, table.id),
  ],
)

/** Task specification/readiness projection. Current ownership lives in its lease. */
export const SwarmTaskTable = sqliteTable(
  "swarm_task",
  {
    id: text().$type<Swarm.TaskID>().primaryKey(),
    swarm_id: text()
      .$type<Swarm.ID>()
      .notNull()
      .references(() => SwarmTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text(),
    status: text().$type<Swarm.TaskStatus>().notNull().default("pending"),
    priority: integer().notNull().default(0),
    created_by_member_id: text().$type<Swarm.MemberID>(),
    reserved_member_id: text().$type<Swarm.MemberID>(),
    reserved_until: integer(),
    reservation_revision: integer().notNull().default(0),
    lease_generation: integer().notNull().default(0),
    semantic_retry_count: integer().notNull().default(0),
    acceptance: text({ mode: "json" }).$type<Swarm.TaskAcceptance>().notNull().default({ criteria: [] }),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    ready_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
    time_completed: integer(),
  },
  (table) => [
    index("swarm_task_ready_idx").on(
      table.swarm_id,
      table.status,
      sql`${table.priority} DESC`,
      table.ready_at,
      table.time_created,
      table.id,
    ),
    index("swarm_task_dispatch_ready_idx")
      .on(sql`${table.priority} DESC`, table.ready_at, table.time_created, table.id, table.swarm_id)
      .where(sql`${table.status} = 'ready'`),
    index("swarm_task_reserved_member_idx").on(table.reserved_member_id, table.status, table.reserved_until),
    index("swarm_task_reservation_due_idx")
      .on(table.reserved_until, table.id)
      .where(sql`${table.status} = 'ready' AND ${table.reserved_until} IS NOT NULL`),
  ],
)

export const SwarmTaskDependencyTable = sqliteTable(
  "swarm_task_dependency",
  {
    task_id: text()
      .$type<Swarm.TaskID>()
      .notNull()
      .references(() => SwarmTaskTable.id, { onDelete: "cascade" }),
    depends_on_task_id: text()
      .$type<Swarm.TaskID>()
      .notNull()
      .references(() => SwarmTaskTable.id, { onDelete: "cascade" }),
    requirement: text().$type<Swarm.DependencyRequirement>().notNull().default("require_success"),
  },
  (table) => [
    primaryKey({ columns: [table.task_id, table.depends_on_task_id] }),
    check("swarm_task_dependency_no_self_check", sql`${table.task_id} != ${table.depends_on_task_id}`),
    index("swarm_task_dependency_reverse_idx").on(table.depends_on_task_id, table.task_id),
  ],
)

/**
 * One current task owner. Expiry is liveness; generation is stale-writer safety.
 * A retiring lease remains authoritative until shared Session execution reaches
 * the quiescence barrier.
 */
export const SwarmTaskLeaseTable = sqliteTable(
  "swarm_task_lease",
  {
    task_id: text()
      .$type<Swarm.TaskID>()
      .primaryKey()
      .references(() => SwarmTaskTable.id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    owner_member_id: text()
      .$type<Swarm.MemberID>()
      .notNull()
      .references(() => SwarmMemberTable.id),
    // Binding snapshot: preserve it even if the Session later disappears.
    owner_session_id: text().$type<typeof SessionTable.$inferSelect.id>().notNull(),
    owner_binding_generation: integer().notNull(),
    lease_owner_process: text().notNull(),
    state: text().$type<Swarm.LeaseState>().notNull().default("active"),
    hold_user_seq: integer(),
    hold_started_at: integer(),
    hold_deadline: integer(),
    retire_reason: text(),
    retire_requested_at: integer(),
    acquired_at: integer().notNull(),
    expires_at: integer().notNull(),
    renewed_at: integer(),
  },
  (table) => [
    index("swarm_task_lease_due_idx").on(table.expires_at, table.task_id),
    index("swarm_task_lease_process_due_idx").on(table.lease_owner_process, table.expires_at, table.task_id),
    index("swarm_task_lease_state_owner_idx").on(table.state, table.lease_owner_process, table.task_id),
    index("swarm_task_lease_hold_due_idx")
      .on(table.hold_deadline, table.task_id)
      .where(sql`${table.state} = 'human_hold' AND ${table.hold_deadline} IS NOT NULL`),
    index("swarm_task_lease_state_retire_idx").on(table.state, table.retire_requested_at, table.task_id),
    index("swarm_task_lease_member_idx").on(table.owner_member_id, table.task_id),
  ],
)

/** Append-only task execution attempt trace. */
export const SwarmTaskRunTable = sqliteTable(
  "swarm_task_run",
  {
    id: text().$type<Swarm.TaskRunID>().primaryKey(),
    task_id: text()
      .$type<Swarm.TaskID>()
      .notNull()
      .references(() => SwarmTaskTable.id, { onDelete: "cascade" }),
    member_id: text()
      .$type<Swarm.MemberID>()
      .notNull()
      .references(() => SwarmMemberTable.id),
    session_id: text().$type<typeof SessionTable.$inferSelect.id>().notNull(),
    binding_generation: integer().notNull(),
    lease_generation: integer().notNull(),
   session_input_id: text().$type<SessionMessage.ID>().notNull(),
   status: text().$type<Swarm.TaskRunStatus>().notNull(),
    failure_kind: text().$type<Swarm.TaskFailureKind>(),
    failure_detail: text(),
    /** Bounded worker-authored result from a successful exact task run. */
    result_summary: text(),
    admitted_at: integer(),
    started_at: integer(),
    ended_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("swarm_task_run_input_idx").on(table.session_input_id),
    index("swarm_task_run_task_created_idx").on(table.task_id, table.time_created, table.id),
    index("swarm_task_run_member_created_idx").on(table.member_id, table.time_created, table.id),
  ],
)

/** Immutable logical message body. Recipient transport state is normalized out. */
export const SwarmMessageTable = sqliteTable(
  "swarm_message",
  {
    id: text().$type<Swarm.MessageID>().primaryKey(),
    swarm_id: text()
      .$type<Swarm.ID>()
      .notNull()
      .references(() => SwarmTable.id, { onDelete: "cascade" }),
    sender_member_id: text()
      .$type<Swarm.MemberID>()
      .notNull()
      .references(() => SwarmMemberTable.id),
    // Immutable causal provenance. Intentionally no Session FK: deleting or
    // rebinding a Session must not rewrite historical message authorship.
    sender_session_id: text().$type<typeof SessionTable.$inferSelect.id>().notNull(),
    sender_binding_generation: integer().notNull(),
    kind: text().$type<Swarm.MessageKind>().notNull(),
    body: text().notNull(),
    task_id: text().$type<Swarm.TaskID>(),
    correlation_id: text(),
    response_to: text().$type<Swarm.MessageID>(),
    priority: text().$type<Swarm.MessagePriority>().notNull().default("normal"),
    reply_expected: integer({ mode: "boolean" }).notNull().default(true),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    expires_at: integer(),
  },
  (table) => [
    index("swarm_message_stream_idx").on(table.swarm_id, table.time_created, table.id),
    index("swarm_message_correlation_idx").on(table.swarm_id, table.correlation_id),
    index("swarm_message_expiry_idx")
      .on(table.expires_at, table.id)
      .where(sql`${table.expires_at} IS NOT NULL`),
  ],
)

/** One idempotent transport receipt per logical message recipient. */
export const SwarmMessageDeliveryTable = sqliteTable(
  "swarm_message_delivery",
  {
    id: text().$type<Swarm.DeliveryID>().primaryKey(),
    message_id: text()
      .$type<Swarm.MessageID>()
      .notNull()
      .references(() => SwarmMessageTable.id, { onDelete: "cascade" }),
    recipient_member_id: text()
      .$type<Swarm.MemberID>()
      .notNull()
      .references(() => SwarmMemberTable.id),
    state: text().$type<Swarm.DeliveryState>().notNull().default("pending"),
    session_input_id: text().$type<SessionMessage.ID>().notNull(),
    claim_generation: integer().notNull().default(0),
    claim_owner: text(),
    claim_expires_at: integer(),
    next_attempt_at: integer(),
    attempt_count: integer().notNull().default(0),
    admitted_session_id: text().$type<typeof SessionTable.$inferSelect.id>(),
    admitted_seq: integer(),
    admitted_at: integer(),
    error: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("swarm_message_delivery_recipient_idx").on(table.message_id, table.recipient_member_id),
    uniqueIndex("swarm_message_delivery_input_idx").on(table.session_input_id),
    index("swarm_message_delivery_recipient_pending_idx")
      .on(table.recipient_member_id, table.time_created, table.id)
      .where(sql`${table.state} = 'pending'`),
    index("swarm_message_delivery_due_idx")
      .on(table.next_attempt_at, table.id)
      .where(sql`${table.state} = 'pending'`),
    index("swarm_message_delivery_claim_expiry_idx")
      .on(table.claim_expires_at, table.id)
      .where(sql`${table.state} = 'claimed'`),
  ],
)

export const SwarmBlackboardTable = sqliteTable(
  "swarm_blackboard",
  {
    swarm_id: text()
      .$type<Swarm.ID>()
      .notNull()
      .references(() => SwarmTable.id, { onDelete: "cascade" }),
    key: text().notNull(),
    value: text({ mode: "json" }).$type<unknown>().notNull(),
    content_type: text().notNull(),
    version: integer().notNull().default(0),
    author_member_id: text()
      .$type<Swarm.MemberID>()
      .notNull()
      .references(() => SwarmMemberTable.id),
    task_id: text().$type<Swarm.TaskID>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.swarm_id, table.key] }),
    index("swarm_blackboard_task_idx").on(table.swarm_id, table.task_id),
  ],
)

export const SwarmClaimTable = sqliteTable(
  "swarm_claim",
  {
    swarm_id: text()
      .$type<Swarm.ID>()
      .notNull()
      .references(() => SwarmTable.id, { onDelete: "cascade" }),
    member_id: text()
      .$type<Swarm.MemberID>()
      .notNull()
      .references(() => SwarmMemberTable.id),
    scope: text().notNull(),
    generation: integer().notNull().default(0),
    expires_at: integer(),
    released_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.swarm_id, table.member_id, table.scope] }),
    index("swarm_claim_expiry_idx")
      .on(table.expires_at, table.swarm_id, table.member_id)
      .where(sql`${table.released_at} IS NULL AND ${table.expires_at} IS NOT NULL`),
  ],
)

/** Durable artifact/handoff receipt ledger. Verdicts are final once written. */
export const SwarmDeliverableTable = sqliteTable(
  "swarm_deliverable",
  {
    id: text().$type<Swarm.DeliverableID>().primaryKey(),
    swarm_id: text()
      .$type<Swarm.ID>()
      .notNull()
      .references(() => SwarmTable.id, { onDelete: "cascade" }),
    member_id: text()
      .$type<Swarm.MemberID>()
      .notNull()
      .references(() => SwarmMemberTable.id),
    task_run_id: text()
      .$type<Swarm.TaskRunID>()
      .references(() => SwarmTaskRunTable.id),
    summary: text().notNull(),
    refs: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    files: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    verdict: text().$type<Swarm.DeliverableVerdict>(),
    verdict_by_member_id: text().$type<Swarm.MemberID>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    verdict_at: integer(),
  },
  (table) => [
    index("swarm_deliverable_stream_idx").on(table.swarm_id, table.time_created, table.id),
    index("swarm_deliverable_member_idx").on(table.swarm_id, table.member_id, table.time_created),
    index("swarm_deliverable_task_run_idx").on(table.task_run_id),
    index("swarm_deliverable_open_idx")
      .on(table.swarm_id, table.time_created, table.id)
      .where(sql`${table.verdict} IS NULL`),
  ],
)
