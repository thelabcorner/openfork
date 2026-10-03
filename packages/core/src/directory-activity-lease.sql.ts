import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { RuntimeOwnerTable } from "./runtime-owner.sql"

/**
 * Durable shared-writer activity authority for one existing physical directory.
 *
 * A `directory_activity_lease` row is the held-authority counterpart of a
 * non-session filesystem mutator: it proves that some writer is currently
 * operating on a directory so exclusive maintenance can refuse to start.
 * Unlike `directory_maintenance_guard` (one row per directory, exclusive),
 * several activity leases may coexist for the same directory; together they
 * all block exclusive maintenance, and none of them blocks another shared
 * lease.
 *
 * `lease_id` is the unique whole-lease identity minted internally at
 * acquisition (`directory-activity:<uuid>`). It is never caller-supplied and
 * never reused, so a stale handle can never release a newer lease: release
 * demands the exact lease_id + directory + kind + owner + generation + active
 * identity.
 *
 * `generation` is the strictly increasing per-directory sequence of lease
 * acquisitions (max existing + 1). It is durable audit/ordering evidence and
 * an additional release fence, never liveness. Heartbeat age is never
 * evidence for any transition.
 *
 * `released_at` is audit evidence, never fencing or liveness.
 */
export const DirectoryActivityLeaseTable = sqliteTable(
  "directory_activity_lease",
  {
    lease_id: text().primaryKey(),
    directory: text().notNull(),
    kind: text().notNull(),
    owner_id: text()
      .notNull()
      .references(() => RuntimeOwnerTable.id),
    generation: integer().notNull(),
    state: text().$type<"active" | "released" | "reconcile_required">().notNull(),
    acquired_at: integer().notNull(),
    released_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("directory_activity_lease_directory_idx").on(table.directory, table.state),
    index("directory_activity_lease_owner_idx").on(table.owner_id, table.state),
    check(
      "directory_activity_lease_state_check",
      sql`${table.state} in ('active', 'released', 'reconcile_required')`,
    ),
    check(
      "directory_activity_lease_release_check",
      sql`(${table.state} = 'released' and ${table.released_at} is not null) or (${table.state} <> 'released' and ${table.released_at} is null)`,
    ),
    check(
      "directory_activity_lease_identity_check",
      sql`length(${table.lease_id}) > 0 and length(${table.kind}) > 0`,
    ),
  ],
)
