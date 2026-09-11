import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Durable physical model calls made by host-owned support agents that do not
 * naturally produce a conversation assistant message. Conversation-backed
 * maintenance such as compaction remains canonical in the message table and is
 * classified by the Usage service instead of being duplicated here.
 */
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
