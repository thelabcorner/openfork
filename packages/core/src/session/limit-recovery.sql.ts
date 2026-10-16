import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"

export const SessionLimitRecoveryTable = sqliteTable(
  "session_limit_recovery",
  {
    session_id: text()
      .$type<typeof SessionTable.$inferSelect.id>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    source_assistant_message_id: text().notNull(),
    source_user_message_id: text(),
    provider_id: text().notNull(),
    account_id: text(),
    model_id: text().notNull(),
    failure_class: text().notNull(),
    failure_code: text(),
    reset_at: integer(),
    reset_source: text(),
    reset_observed_at: integer(),
    expected_latest_user_seq: integer(),
    generation: integer().notNull(),
    auto_resume: integer({ mode: "boolean" }).notNull().default(false),
    manual_resume: integer({ mode: "boolean" }).notNull().default(false),
    snooze_until: integer(),
    continuation_id: text().notNull(),
    claim_owner: text(),
    claim_expires_at: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("session_limit_recovery_due_idx").on(table.auto_resume, table.reset_at, table.session_id),
    index("session_limit_recovery_manual_idx").on(table.manual_resume, table.claim_expires_at, table.session_id),
    index("session_limit_recovery_claim_idx").on(table.auto_resume, table.claim_expires_at, table.session_id),
  ],
)


/**
 * Monotonic per-Session recovery generation high-watermark.
 *
 * The operational cursor is intentionally deleted on settlement/cancel. Keep
 * the generation fence in a separate durable row so a later recovery cursor
 * can never reuse a generation previously observed by a stale client.
 */
export const SessionLimitRecoveryEpochTable = sqliteTable("session_limit_recovery_epoch", {
  session_id: text()
    .$type<typeof SessionTable.$inferSelect.id>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  generation: integer().notNull().default(0),
})
