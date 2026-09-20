import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * One durable process-incarnation identity shared by runtime domains.
 *
 * Heartbeat is process liveness evidence only. It is deliberately not a lease:
 * staleness never transfers authority by itself.
 */
export const RuntimeOwnerTable = sqliteTable("runtime_owner", {
  id: text().primaryKey(),
  pid: integer().notNull(),
  started_at: integer().notNull(),
  heartbeat_at: integer().notNull(),
  control_epoch: integer().notNull().default(0),
})
