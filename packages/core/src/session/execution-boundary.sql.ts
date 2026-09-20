import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Permission } from "@opencode-ai/schema/permission"
import { SessionTable } from "./sql"

/**
 * Current hard execution ceiling for one Session. This is intentionally a
 * separate projection rather than a Session.Info field: navigation/list reads
 * do not need to hydrate permission policy.
 */
export const SessionExecutionBoundaryTable = sqliteTable("session_execution_boundary", {
  session_id: text()
    .$type<typeof SessionTable.$inferSelect.id>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  boundary: text({ mode: "json" }).$type<Permission.Boundary>().notNull(),
  time_updated: integer().notNull(),
})
