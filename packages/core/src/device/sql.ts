import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const DeviceTable = sqliteTable("device", {
  id: text().primaryKey(),
  name: text().notNull(),
  token_hash: text().notNull().unique(),
  token_prefix: text().notNull(),
  created_at: integer().notNull(),
  last_seen_at: integer(),
  revoked_at: integer(),
})
