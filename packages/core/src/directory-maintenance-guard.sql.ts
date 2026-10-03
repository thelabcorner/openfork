import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { RuntimeOwnerTable } from "./runtime-owner.sql"

/**
 * Durable directory-scoped maintenance authority shared by every process that
 * can admit work into a directory.
 *
 * One row per canonical physical directory key. An `active` row excludes every
 * other acquisition of that directory; a `released` row is reusable only
 * through an exact guarded transition; `reconcile_required` blocks until an
 * explicit operator reconciliation and is never cleared automatically.
 * Heartbeat age is never evidence for any transition.
 *
 * `acquisition_id` is the durable whole-acquisition identity. Every row written
 * by one successful multi-directory acquisition carries the same value, so a
 * token can only ever release or probe the exact acquisition that published it;
 * the same `guard_id` + owner may hold several disjoint acquisitions at once
 * without one handle affecting another.
 *
 * `generation` is an additional released-row reuse fence. `guard_id` is
 * caller-supplied so a cross-system adapter can correlate it, which means the
 * same guard id may be acquired again by the same RuntimeOwner after a release.
 * The freshly minted `acquisition_id` is the primary whole-acquisition identity;
 * generation additionally proves which reuse generation of each directory row
 * belongs to that acquisition.
 *
 * `released_at` is audit evidence, never fencing or liveness.
 */
export const DirectoryMaintenanceGuardTable = sqliteTable(
  "directory_maintenance_guard",
  {
    directory: text().primaryKey(),
    guard_id: text().notNull(),
    owner_id: text()
      .notNull()
      .references(() => RuntimeOwnerTable.id),
    acquisition_id: text().notNull(),
    generation: integer().notNull(),
    state: text().$type<"active" | "released" | "reconcile_required">().notNull(),
    acquired_at: integer().notNull(),
    released_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("directory_maintenance_guard_guard_idx").on(table.guard_id, table.state),
    index("directory_maintenance_guard_owner_idx").on(table.owner_id, table.state),
    index("directory_maintenance_guard_acquisition_idx").on(table.acquisition_id, table.state),
    check(
      "directory_maintenance_guard_state_check",
      sql`${table.state} in ('active', 'released', 'reconcile_required')`,
    ),
    check(
      "directory_maintenance_guard_release_check",
      sql`(${table.state} = 'released' and ${table.released_at} is not null) or (${table.state} <> 'released' and ${table.released_at} is null)`,
    ),
    check("directory_maintenance_guard_acquisition_check", sql`length(${table.acquisition_id}) > 0`),
  ],
)
