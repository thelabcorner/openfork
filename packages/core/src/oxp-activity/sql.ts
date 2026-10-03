import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { OxpActivitySchema } from "./schema"

export const OxpParentActivityTable = sqliteTable(
  "oxp_parent_activity",
  {
    id: text().$type<OxpActivitySchema.ActivityID>().primaryKey(),
    title: text(),
    first_seen_at: integer().notNull(),
    last_seen_at: integer().notNull(),
    call_count: integer().notNull().default(0),
    failure_count: integer().notNull().default(0),
    augmentation_calls: integer().notNull().default(0),
    supervision_calls: integer().notNull().default(0),
    delegation_calls: integer().notNull().default(0),
    observed_epoch_count: integer().notNull().default(0),
    last_tool: text(),
    last_root_alias: text(),
    time_archived: integer(),
  },
  (table) => [index("oxp_parent_activity_last_seen_idx").on(table.time_archived, table.last_seen_at, table.id)],
)
export const OxpCorrelationRefTable = sqliteTable(
  "oxp_correlation_ref",
  {
    scheme: text().notNull(),
    digest: text().notNull(),
    activity_id: text()
      .$type<OxpActivitySchema.ActivityID>()
      .notNull()
      .references(() => OxpParentActivityTable.id, { onDelete: "cascade" }),
    scope: text().$type<OxpActivitySchema.CorrelationScope>().notNull(),
    first_seen_at: integer().notNull(),
    last_seen_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scheme, table.digest] }),
    index("oxp_correlation_ref_activity_idx").on(table.activity_id),
  ],
)

export const OxpInvocationTable = sqliteTable(
  "oxp_invocation",
  {
    id: text().$type<OxpActivitySchema.InvocationID>().primaryKey(),
    activity_id: text()
      .$type<OxpActivitySchema.ActivityID>()
      .notNull()
      .references(() => OxpParentActivityTable.id, { onDelete: "cascade" }),
    host_run_id: text().notNull(),
    observed_epoch: integer(),
    plane: text().$type<OxpActivitySchema.Plane>().notNull(),
    tool: text().notNull(),
    action: text(),
    root_id: text(),
    root_alias: text(),
    status: text().$type<OxpActivitySchema.Status>().notNull().default("running"),
    error_code: text(),
    mutation_attempted: integer({ mode: "boolean" }).notNull().default(false),
    mutation_committed: integer({ mode: "boolean" }).notNull().default(false),
    safe_summary: text({ mode: "json" }).$type<OxpActivitySchema.SafeSummary>(),
    context_request_chars: integer(),
    context_request_source: text().$type<OxpActivitySchema.ContextExactSource>(),
    context_request_schema: text().$type<OxpActivitySchema.ContextSchema>(),
    context_result_chars: integer(),
    context_result_source: text().$type<OxpActivitySchema.ContextExactSource>(),
    context_result_schema: text().$type<OxpActivitySchema.ContextSchema>(),
    time_started: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [
    index("oxp_invocation_activity_started_idx").on(table.activity_id, table.time_started, table.id),
    index("oxp_invocation_activity_status_started_idx").on(table.activity_id, table.status, table.time_started),
    index("oxp_invocation_activity_host_epoch_idx").on(table.activity_id, table.host_run_id, table.observed_epoch),
    index("oxp_invocation_status_host_idx").on(table.status, table.host_run_id),
    index("oxp_invocation_started_idx").on(table.time_started),
  ],
)

export const OxpInvocationDetailTable = sqliteTable("oxp_invocation_detail", {
  invocation_id: text()
    .$type<OxpActivitySchema.InvocationID>()
    .primaryKey()
    .references(() => OxpInvocationTable.id, { onDelete: "cascade" }),
  request: text({ mode: "json" }).$type<OxpActivitySchema.InvocationDetail>(),
  outcome: text({ mode: "json" }).$type<OxpActivitySchema.InvocationDetail>(),
})

export const OxpInvocationLinkTable = sqliteTable(
  "oxp_invocation_link",
  {
    invocation_id: text()
      .$type<OxpActivitySchema.InvocationID>()
      .notNull()
      .references(() => OxpInvocationTable.id, { onDelete: "cascade" }),
    kind: text().$type<OxpActivitySchema.LinkKind>().notNull(),
    ref: text().notNull(),
    label: text(),
    relation: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.invocation_id, table.kind, table.ref, table.relation],
    }),
    index("oxp_invocation_link_ref_idx").on(table.kind, table.ref),
    uniqueIndex("oxp_invocation_link_invocation_ref_idx").on(
      table.invocation_id,
      table.kind,
      table.ref,
      table.relation,
    ),
  ],
)
