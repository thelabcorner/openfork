import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Minimal durable trust fact for one exact saved Code executable revision.
 *
 * Source, manifests, schemas, dependencies, and arbitrary run data remain on
 * the filesystem / owning CodeRun. This table answers only: did OpenFork
 * explicitly admit this exact revision in this exact physical scope?
 */
export const SavedCodeAdmissionTable = sqliteTable(
  "saved_code_admission",
  {
    scope_kind: text().$type<"project" | "global">().notNull(),
    scope_key: text().notNull(),
    saved_id: text().notNull(),
    revision: text().notNull(),
    source_hash: text().notNull(),
    origin: text().$type<"code-save" | "operator">().notNull(),
    origin_run_id: text(),
    time_admitted: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({
      columns: [table.scope_kind, table.scope_key, table.saved_id, table.revision],
    }),
    index("saved_code_admission_saved_idx").on(table.scope_kind, table.scope_key, table.saved_id),
  ],
)
