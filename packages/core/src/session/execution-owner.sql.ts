import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { RuntimeOwnerTable } from "../runtime-owner.sql"
import { SessionTable } from "./sql"

/**
 * Durable cross-process execution authority for one Session.
 *
 * An idle row is retained with owner_id=NULL so generation remains monotonic.
 * Runtime phase/tool/model/task facts deliberately do not belong here.
 */
export const SessionExecutionOwnerTable = sqliteTable(
  "session_execution_owner",
  {
    session_id: text()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    owner_id: text().references(() => RuntimeOwnerTable.id),
    acquired_at: integer(),
    interrupt_generation: integer(),
    interrupt_reason: text(),
    interrupt_requested_at: integer(),
    recovery_owner_id: text().references(() => RuntimeOwnerTable.id),
    recovery_started_at: integer(),
  },
  (table) => [
    index("session_execution_owner_owner_idx").on(table.owner_id),
    index("session_execution_owner_recovery_owner_idx").on(table.recovery_owner_id),
  ],
)
