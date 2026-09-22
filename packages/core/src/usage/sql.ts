import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "../session/schema"
import type { YieldStatisticState } from "./yield-statistics"

/**
 * Durable, scalar-only record of one settled user-facing model generation.
 *
 * This is historical analytics state owned by Usage, not live SessionTelemetry.
 * Producers write it once at settlement so summaries/model-ranking never need
 * to decode assistant message JSON or hydrate conversation history.
 */
export const UsageRecordTable = sqliteTable(
  "usage_record",
  {
    message_id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    /** Account-suffix-free model identity used by statistical projections. */
    base_model_id: text(),
    /** Physical/provider account that served the generation when known. */
    account_id: text(),
    variant: text(),
    agent: text(),
    mode: text(),
    created_at: integer(),
    request_sent_at: integer(),
    first_token_at: integer(),
    streamed_at: integer(),
    completed_at: integer().notNull(),
    cost_usd: real(),
    input_tokens: integer().notNull().default(0),
    cache_read_tokens: integer().notNull().default(0),
    cache_write_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    reasoning_tokens: integer().notNull().default(0),
  },
  (table) => [
    index("usage_record_completed_idx").on(table.completed_at),
    index("usage_record_session_completed_idx").on(table.session_id, table.completed_at),
    index("usage_record_model_completed_idx").on(table.provider_id, table.model_id, table.completed_at),
    index("usage_record_base_model_completed_idx").on(table.provider_id, table.base_model_id, table.completed_at),
    index("usage_record_account_model_completed_idx").on(
      table.provider_id,
      table.base_model_id,
      table.account_id,
      table.completed_at,
    ),
  ],
)

/**
 * Durable physical model calls made by host-owned support agents that do not
 * naturally produce a conversation assistant message. Conversation-backed
 * maintenance such as compaction remains canonical in the message table and is
 * classified by the Usage service instead of being duplicated here.
 */
export const UsageYieldStatTable = sqliteTable(
  "usage_yield_stat",
  {
    stat_key: text().primaryKey(),
    provider_id: text().notNull(),
    base_model_id: text().notNull(),
    account_id: text(),
    state: text({ mode: "json" }).$type<YieldStatisticState>().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("usage_yield_stat_model_idx").on(table.provider_id, table.base_model_id),
    index("usage_yield_stat_account_idx").on(table.provider_id, table.base_model_id, table.account_id),
  ],
)

export const UsageYieldMetaTable = sqliteTable("usage_yield_meta", {
  id: text().$type<"global">().primaryKey(),
  version: integer().notNull(),
  rebuilt_at: integer().notNull(),
  source_rows: integer().notNull(),
})

export const MaintenanceUsageTable = sqliteTable(
  "maintenance_usage",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    agent: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    session_id: text(),
    project_id: text(),
    requests: integer().notNull().default(1),
    cost_usd: real(),
    cost_estimated: integer({ mode: "boolean" }).notNull().default(false),
    input_tokens: integer().notNull().default(0),
    cache_read_tokens: integer().notNull().default(0),
    cache_write_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    reasoning_tokens: integer().notNull().default(0),
    total_tokens: integer().notNull().default(0),
    time_started: integer().notNull(),
    time_completed: integer().notNull(),
  },
  (table) => [
    index("maintenance_usage_completed_idx").on(table.time_completed),
    index("maintenance_usage_project_completed_idx").on(table.project_id, table.time_completed),
    index("maintenance_usage_agent_completed_idx").on(table.agent, table.time_completed),
  ],
)
