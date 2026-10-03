import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

/**
 * Durable authority defense for `managed_worktree_binding`.
 *
 * Drizzle declarations cannot express SQLite triggers, so the trigger DDL is a
 * manual, idempotent `reconcile` supplement (the same pattern as the
 * directory-maintenance-guard and directory-activity-lease migrations) that
 * runs on every database open.
 *
 * The triggers make service-legal mutations the only possible mutations:
 *
 * - a row is never deletable while its `binding_state` is not `retired`, so a
 *   live binding cannot be erased by raw SQL; retirement is the only path that
 *   makes deletion legal, and the service itself never deletes;
 * - rows are never replaceable: with `recursive_triggers` OFF (the default),
 *   SQLite's REPLACE conflict resolution deletes the conflicting row without
 *   firing the DELETE trigger, so a BEFORE INSERT guard aborts
 *   `INSERT OR REPLACE` / duplicate upserts of the canonical directory key;
 * - raw identity is immutable after insert: `directory`, installation,
 *   repository, worktree, storage volume, project, workspace, branch ref, pin
 *   ref, and `created_at` may never change;
 * - observation evidence is write-once: `head`, `manager_revision`,
 *   `lifecycle_state`, `operation_id`, `create_operation_id`,
 *   `initialization_operation_id`, `activated_at`, `reconciled_at`,
 *   `quarantined_at`, and `retired_at` may be filled once and never rewritten;
 * - `generation` is a monotonic CAS fence: same-state writes may not bump it
 *   and every state change must strictly increase it;
 * - only the exact legal transition graph is accepted
 *   (`handoff_pending -> active | reconcile_required | quarantined | retired`,
 *   `active -> reconcile_required | quarantined | retired`,
 *   `reconcile_required -> active | quarantined | retired`,
 *   `quarantined -> retired`, terminal `retired`);
 * - entering a state requires its complete evidence: `active` carries
 *   head/revision/lifecycle/activated_at, `reconcile_required` carries
 *   `reconciled_at`, `quarantined` carries `quarantined_at`, and `retired`
 *   carries `retired_at` while every non-retired state keeps it null.
 *
 * Timestamps are audit evidence, never authority: wall-clock ordering and
 * inequality are deliberately not constrained, only durable identity
 * consistency.
 */

const triggers: ReadonlyArray<{ readonly name: string; readonly sql: string }> = [
  {
    name: "managed_worktree_binding_no_delete",
    sql: "CREATE TRIGGER managed_worktree_binding_no_delete BEFORE DELETE ON managed_worktree_binding FOR EACH ROW WHEN OLD.binding_state <> 'retired' BEGIN SELECT RAISE(ABORT, 'managed_worktree_binding rows are not deletable while non-retired'); END",
  },
  {
    name: "managed_worktree_binding_no_replace",
    sql: "CREATE TRIGGER managed_worktree_binding_no_replace BEFORE INSERT ON managed_worktree_binding WHEN EXISTS (SELECT 1 FROM managed_worktree_binding WHERE directory = NEW.directory) BEGIN SELECT RAISE(ABORT, 'managed_worktree_binding rows are never replaceable'); END",
  },
  {
    name: "managed_worktree_binding_authority_update",
    sql: `CREATE TRIGGER managed_worktree_binding_authority_update
BEFORE UPDATE ON managed_worktree_binding
FOR EACH ROW
WHEN (
  NEW.directory IS NOT OLD.directory OR
  NEW.installation_id IS NOT OLD.installation_id OR
  NEW.repository_id IS NOT OLD.repository_id OR
  NEW.worktree_id IS NOT OLD.worktree_id OR
  NEW.storage_volume_id IS NOT OLD.storage_volume_id OR
  NEW.project_id IS NOT OLD.project_id OR
  NEW.workspace_id IS NOT OLD.workspace_id OR
  NEW.branch_ref IS NOT OLD.branch_ref OR
  NEW.pin_ref IS NOT OLD.pin_ref OR
  NEW.created_at IS NOT OLD.created_at
  OR (OLD.head IS NOT NULL AND NEW.head IS NOT OLD.head)
  OR (OLD.manager_revision IS NOT NULL AND NEW.manager_revision IS NOT OLD.manager_revision)
  OR (OLD.lifecycle_state IS NOT NULL AND NEW.lifecycle_state IS NOT OLD.lifecycle_state)
  OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS NOT OLD.operation_id)
  OR (OLD.create_operation_id IS NOT NULL AND NEW.create_operation_id IS NOT OLD.create_operation_id)
  OR (OLD.initialization_operation_id IS NOT NULL AND NEW.initialization_operation_id IS NOT OLD.initialization_operation_id)
  OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at)
  OR (OLD.reconciled_at IS NOT NULL AND NEW.reconciled_at IS NOT OLD.reconciled_at)
  OR (OLD.quarantined_at IS NOT NULL AND NEW.quarantined_at IS NOT OLD.quarantined_at)
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
  OR NEW.generation < OLD.generation
  OR (NEW.binding_state IS OLD.binding_state AND NEW.generation IS NOT OLD.generation)
  OR (NEW.binding_state IS NOT OLD.binding_state AND NEW.generation <= OLD.generation)
  OR (OLD.binding_state = 'retired' AND NEW.binding_state IS NOT OLD.binding_state)
  OR (OLD.binding_state = 'quarantined' AND NEW.binding_state NOT IN ('quarantined', 'retired'))
  OR (OLD.binding_state = 'handoff_pending' AND NEW.binding_state NOT IN ('handoff_pending', 'active', 'reconcile_required', 'quarantined', 'retired'))
  OR (OLD.binding_state = 'active' AND NEW.binding_state NOT IN ('active', 'reconcile_required', 'quarantined', 'retired'))
  OR (OLD.binding_state = 'reconcile_required' AND NEW.binding_state NOT IN ('reconcile_required', 'active', 'quarantined', 'retired'))
  OR (NEW.binding_state = 'active' AND (NEW.head IS NULL OR NEW.manager_revision IS NULL OR NEW.lifecycle_state IS NULL OR NEW.activated_at IS NULL))
  OR (NEW.binding_state = 'retired' AND NEW.retired_at IS NULL)
  OR (NEW.binding_state <> 'retired' AND NEW.retired_at IS NOT NULL)
  OR (NEW.binding_state = 'quarantined' AND NEW.quarantined_at IS NULL)
  OR (NEW.binding_state = 'reconcile_required' AND NEW.reconciled_at IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'managed_worktree_binding authority identity is immutable outside service-legal transitions');
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
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'managed_worktree_binding'",
    )
    const stored = new Map(existing.map((row) => [row.name, row.sql]))
    for (const trigger of triggers) {
      if (stored.get(trigger.name) === trigger.sql) continue
      yield* tx.run(`DROP TRIGGER IF EXISTS ${trigger.name}`)
      yield* tx.run(trigger.sql)
    }
  })

export default {
  id: "20260924170000_managed_worktree_binding_triggers",
  up(tx) {
    return reconcile(tx)
  },
  reconcile,
} satisfies DatabaseMigration.Migration
