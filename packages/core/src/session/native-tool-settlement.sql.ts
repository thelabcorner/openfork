import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/** Scalar-only V1 host tool completions; independent of disposable transcript rows. */
export const NativeToolSettlementTable = sqliteTable(
  "native_tool_settlement",
  {
    // The durable V1 ToolPart id is unique per invocation, including writer retries.
    id: text().primaryKey(),
    session_id: text().notNull(),
    project_id: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    tool: text().notNull(),
    status: text().$type<"success" | "error" | "abort" | "denied" | "timeout" | "unknown">().notNull(),
    started_at: integer().notNull(),
    completed_at: integer().notNull(),
    duration_ms: integer().notNull(),
  },
  (table) => [
    index("native_tool_settlement_started_idx").on(table.started_at),
    index("native_tool_settlement_completed_idx").on(table.completed_at),
    index("native_tool_settlement_provider_model_started_idx").on(table.provider_id, table.model_id, table.started_at),
    index("native_tool_settlement_provider_model_completed_idx").on(table.provider_id, table.model_id, table.completed_at),
  ],
)
