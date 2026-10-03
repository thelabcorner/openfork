import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

/**
 * Durable authority defense for `directory_maintenance_guard`.
 *
 * Drizzle declarations cannot express SQLite triggers, so the trigger DDL is a
 * manual, idempotent `reconcile` supplement (the same pattern as the FTS and
 * scheduled-task trigger migrations) that runs on every database open. The
 * already-journaled table migration is never edited: completed migration
 * sources are checksummed history.
 *
 * The triggers make service-legal mutations the only possible mutations:
 *
 * - rows are never deletable, not even by raw SQL;
 * - rows are never replaceable either: with `recursive_triggers` OFF (the
 *   default), SQLite's REPLACE conflict resolution deletes the conflicting row
 *   without firing the DELETE trigger, so a BEFORE INSERT guard aborts
 *   `INSERT OR REPLACE` and duplicate upserts against an existing directory.
 *   Plain INSERT of an absent row and the service's UPDATE-based released-row
 *   reuse are unaffected;
 * - same-state writes may only refresh `updated_at`, preserving every
 *   authority identity column and both state timestamps;
 * - active -> released and reconcile_required -> released keep
 *   directory/guard_id/owner_id/acquisition_id/generation/acquired_at and must
 *   publish a non-null `released_at`;
 * - active -> reconcile_required keeps the same durable identity and keeps
 *   `released_at` null;
 * - released -> active is only legal as a reuse that mints a new acquisition:
 *   directory unchanged, a strictly newer `generation`, a changed
 *   `acquisition_id`, and `released_at` back to null. The acquisition-wide
 *   generation is max(existing) + 1, so a row whose previous generation lagged
 *   the set maximum may jump by more than one; only strict increase is
 *   guaranteed. `guard_id`, `owner_id`, and `acquired_at` are not reuse fences
 *   and may change;
 * - every other transition, including terminal reconcile_required -> active,
 *   aborts.
 *
 * Timestamps are audit evidence, never authority: wall-clock ordering and
 * inequality are deliberately not constrained, only durable identity
 * consistency.
 */

const triggers: ReadonlyArray<{ readonly name: string; readonly sql: string }> = [
  {
    name: "directory_maintenance_guard_no_delete",
    sql: "CREATE TRIGGER directory_maintenance_guard_no_delete BEFORE DELETE ON directory_maintenance_guard FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'directory_maintenance_guard rows are never deletable'); END",
  },
  {
    name: "directory_maintenance_guard_no_replace",
    sql: "CREATE TRIGGER directory_maintenance_guard_no_replace BEFORE INSERT ON directory_maintenance_guard WHEN EXISTS (SELECT 1 FROM directory_maintenance_guard WHERE directory = NEW.directory) BEGIN SELECT RAISE(ABORT, 'directory_maintenance_guard rows are never replaceable'); END",
  },
  {
    name: "directory_maintenance_guard_authority_update",
    sql: `CREATE TRIGGER directory_maintenance_guard_authority_update
BEFORE UPDATE ON directory_maintenance_guard
FOR EACH ROW
WHEN (
  (NEW.state = OLD.state AND (
    NEW.directory IS NOT OLD.directory OR
    NEW.guard_id IS NOT OLD.guard_id OR
    NEW.owner_id IS NOT OLD.owner_id OR
    NEW.acquisition_id IS NOT OLD.acquisition_id OR
    NEW.generation IS NOT OLD.generation OR
    NEW.acquired_at IS NOT OLD.acquired_at OR
    NEW.released_at IS NOT OLD.released_at
  ))
  OR (OLD.state = 'active' AND NEW.state IN ('released', 'reconcile_required') AND (
    NEW.directory IS NOT OLD.directory OR
    NEW.guard_id IS NOT OLD.guard_id OR
    NEW.owner_id IS NOT OLD.owner_id OR
    NEW.acquisition_id IS NOT OLD.acquisition_id OR
    NEW.generation IS NOT OLD.generation OR
    NEW.acquired_at IS NOT OLD.acquired_at OR
    (NEW.state = 'released' AND NEW.released_at IS NULL) OR
    (NEW.state = 'reconcile_required' AND NEW.released_at IS NOT NULL)
  ))
  OR (OLD.state = 'reconcile_required' AND NEW.state = 'released' AND (
    NEW.directory IS NOT OLD.directory OR
    NEW.guard_id IS NOT OLD.guard_id OR
    NEW.owner_id IS NOT OLD.owner_id OR
    NEW.acquisition_id IS NOT OLD.acquisition_id OR
    NEW.generation IS NOT OLD.generation OR
    NEW.acquired_at IS NOT OLD.acquired_at OR
    NEW.released_at IS NULL
  ))
  OR (OLD.state = 'released' AND NEW.state = 'active' AND (
    NEW.directory IS NOT OLD.directory OR
    NEW.generation <= OLD.generation OR
    NEW.acquisition_id IS OLD.acquisition_id OR
    NEW.released_at IS NOT NULL
  ))
  OR (OLD.state = 'active' AND NEW.state NOT IN ('active', 'released', 'reconcile_required'))
  OR (OLD.state = 'reconcile_required' AND NEW.state NOT IN ('reconcile_required', 'released'))
  OR (OLD.state = 'released' AND NEW.state NOT IN ('released', 'active'))
)
BEGIN
  SELECT RAISE(ABORT, 'directory_maintenance_guard authority identity is immutable outside service-legal transitions');
END`,
  },
]

/**
 * Definition-aware reconcile: `CREATE TRIGGER IF NOT EXISTS` alone would
 * freeze whatever definition a database saw first, so an earlier or weakened
 * definition could never be repaired. Comparing the stored `sqlite_master`
 * source keeps healthy opens read-only (no schema rewrite churn) while
 * converging every database on the canonical definitions above. This migration
 * is not yet journaled history and is revised in place; once it ships, further
 * definition changes require a replacement migration.
 */
const reconcile = (tx: Transaction) =>
  Effect.gen(function* () {
    const existing = yield* tx.all<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'directory_maintenance_guard'",
    )
    const stored = new Map(existing.map((row) => [row.name, row.sql]))
    for (const trigger of triggers) {
      if (stored.get(trigger.name) === trigger.sql) continue
      yield* tx.run(`DROP TRIGGER IF EXISTS ${trigger.name}`)
      yield* tx.run(trigger.sql)
    }
  })

export default {
  id: "20260924060000_directory_maintenance_guard_triggers",
  up(tx) {
    return reconcile(tx)
  },
  reconcile,
} satisfies DatabaseMigration.Migration
