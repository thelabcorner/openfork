import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"

export const SessionShareTable = sqliteTable("session_share", {
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  id: text().notNull(),
  secret: text().notNull(),
  url: text().notNull(),
  delete_base_url: text(),
  delete_api_family: text(),
  delete_account_id: text(),
  delete_org_id: text(),
  ...Timestamps,
})

/**
 * Remote share removals survive the Session FK cascade and process shutdown.
 * `share_id` is the idempotency key; this table intentionally has no Session FK.
 */
export const ShareCleanupTable = sqliteTable("share_cleanup", {
  share_id: text().primaryKey(),
  session_id: text().notNull(),
  secret: text().notNull(),
  base_url: text(),
  api_family: text(),
  account_id: text(),
  org_id: text(),
  ready: integer().notNull().default(0),
  attempts: integer().notNull().default(0),
  last_error: text(),
  ...Timestamps,
})
