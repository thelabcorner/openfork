import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

/**
 * Durable authority defense for `directory_activity_lease`.
 *
 * Drizzle declarations cannot express SQLite triggers, so the trigger DDL is a
 * manual, idempotent `reconcile` supplement (the same pattern as the
 * directory-maintenance-guard and FTS migrations) that runs on every database
 * open. The already-journaled table migration is never edited: completed
 * migration sources are checksummed history.
 *
 * The triggers make service-legal mutations the only possible mutations:
 *
 * - rows are never deletable, not even by raw SQL;
 * - rows are never replaceable either: with `recursive_triggers` OFF (the
 *   default), SQLite's REPLACE conflict resolution deletes the conflicting row
 *   without firing the DELETE trigger, so a BEFORE INSERT guard aborts
 *   `INSERT OR REPLACE` and duplicate upserts of a lease_id. Plain INSERT of a
 *   fresh lease_id is unaffected;
 * - same-state writes may only refresh `updated_at`, preserving every
 *   authority identity column and both state timestamps;
 * - active -> released and reconcile_required -> released keep
 *   lease_id/directory/kind/owner_id/generation/acquired_at and must publish a
 *   non-null `released_at`;
 * - active -> reconcile_required keeps the same durable identity and keeps
 *   `released_at` null;
 * - every other transition aborts, including released -> active: a lease_id is
 *   minted per acquisition and is never a reusable identity.
 *
 * Timestamps are audit evidence, never authority: wall-clock ordering and
 * inequality are deliberately not constrained, only durable identity
 * consistency.
 */

const triggers: ReadonlyArray<{ readonly name: string; readonly sql: string }> = [
  {
    name: "directory_activity_lease_no_delete",
    sql: "CREATE TRIGGER directory_activity_lease_no_delete BEFORE DELETE ON directory_activity_lease FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'directory_activity_lease rows are never deletable'); END",
  },
  {
    name: "directory_activity_lease_no_replace",
    sql: "CREATE TRIGGER directory_activity_lease_no_replace BEFORE INSERT ON directory_activity_lease WHEN EXISTS (SELECT 1 FROM directory_activity_lease WHERE lease_id = NEW.lease_id) BEGIN SELECT RAISE(ABORT, 'directory_activity_lease rows are never replaceable'); END",
  },
  {
    name: "directory_activity_lease_authority_update",
    sql: `CREATE TRIGGER directory_activity_lease_authority_update
BEFORE UPDATE ON directory_activity_lease
FOR EACH ROW
WHEN (
  (NEW.state = OLD.state AND (
    NEW.lease_id IS NOT OLD.lease_id OR
    NEW.directory IS NOT OLD.directory OR
    NEW.kind IS NOT OLD.kind OR
    NEW.owner_id IS NOT OLD.owner_id OR
    NEW.generation IS NOT OLD.generation OR
    NEW.acquired_at IS NOT OLD.acquired_at OR
    NEW.released_at IS NOT OLD.released_at
  ))
  OR (OLD.state = 'active' AND NEW.state IN ('released', 'reconcile_required') AND (
    NEW.lease_id IS NOT OLD.lease_id OR
    NEW.directory IS NOT OLD.directory OR
    NEW.kind IS NOT OLD.kind OR
    NEW.owner_id IS NOT OLD.owner_id OR
    NEW.generation IS NOT OLD.generation OR
    NEW.acquired_at IS NOT OLD.acquired_at OR
    (NEW.state = 'released' AND NEW.released_at IS NULL) OR
    (NEW.state = 'reconcile_required' AND NEW.released_at IS NOT NULL)
  ))
  OR (OLD.state = 'reconcile_required' AND NEW.state = 'released' AND (
    NEW.lease_id IS NOT OLD.lease_id OR
    NEW.directory IS NOT OLD.directory OR
    NEW.kind IS NOT OLD.kind OR
    NEW.owner_id IS NOT OLD.owner_id OR
    NEW.generation IS NOT OLD.generation OR
    NEW.acquired_at IS NOT OLD.acquired_at OR
    NEW.released_at IS NULL
  ))
  OR (OLD.state = 'released' AND NEW.state <> 'released')
  OR (OLD.state = 'active' AND NEW.state NOT IN ('active', 'released', 'reconcile_required'))
  OR (OLD.state = 'reconcile_required' AND NEW.state NOT IN ('reconcile_required', 'released'))
)
BEGIN
  SELECT RAISE(ABORT, 'directory_activity_lease authority identity is immutable outside service-legal transitions');
END`,
  },
]

/**
 * Definition-aware reconcile: `CREATE TRIGGER IF NOT EXISTS` alone would
 * freeze whatever definition a database saw first, so an earlier or weakened
 * definition could never be repaired. Comparing the stored `sqlite_master`
 * source keeps healthy opens read-only (no schema rewrite churn) while
 * converging every database on the canonical definitions above.
 */
const reconcile = (tx: Transaction) =>
  Effect.gen(function* () {
    const existing = yield* tx.all<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'directory_activity_lease'",
    )
    const stored = new Map(existing.map((row) => [row.name, row.sql]))
    for (const trigger of triggers) {
      if (stored.get(trigger.name) === trigger.sql) continue
      yield* tx.run(`DROP TRIGGER IF EXISTS ${trigger.name}`)
      yield* tx.run(trigger.sql)
    }
  })

export default {
  id: "20260924160000_directory_activity_lease_triggers",
  up(tx) {
    return reconcile(tx)
  },
  reconcile,
} satisfies DatabaseMigration.Migration
