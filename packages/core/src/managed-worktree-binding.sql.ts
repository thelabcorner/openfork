import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Durable managed-worktree binding authority.
 *
 * One row per canonical physical managed directory key (`directory`, the exact
 * `DirectoryMaintenanceGuard.existingDirectoryKey` bytes; never a raw path
 * spelling). The row binds a project (and optional workspace) to the
 * worktree-store identities of the managed directory: installation, repository,
 * worktree, storage volume, branch ref, pin ref, and — once activation has been
 * observed — the exact head, manager revision, lifecycle state, and operation
 * correlation that authorized the binding.
 *
 * `binding_state` lifecycle:
 *
 * - `handoff_pending` — creation intent recorded BEFORE the managed manager is
 *   invoked. No authority exists yet.
 * - `active` — the only state in which the directory may be exposed/loadable by
 *   integration. Reached only from an exact successful
 *   `managed-create-initialize` observation (or an exact clean `managed-status`
 *   reconciliation) that matched every durable identity.
 * - `reconcile_required` — ambiguous/incomplete/mismatched manager evidence.
 *   Blocks until an explicit exact observation proves the identities again.
 * - `quarantined` — manager-reported quarantine. Terminal for every automatic
 *   path; only an explicit operator retirement may leave it.
 * - `retired` — explicit lifecycle end. No automatic delete exists; the row is
 *   retained as audit evidence and a raw delete only becomes legal here.
 *
 * `generation` is a monotonic CAS fence: every transition must carry the exact
 * expected generation and increments it, so a stale handle can never steer a
 * newer binding.
 *
 * Identity columns (`directory`, installation/repository/worktree/storage
 * volume, project, workspace, branch ref, pin ref) are immutable after insert.
 * Observation columns (`head`, `manager_revision`, `lifecycle_state`,
 * `operation_id`, `create_operation_id`, `initialization_operation_id`,
 * `activated_at`) are write-once: they may be filled by the first exact
 * activation and never change afterwards. `state_reason`/`evidence_json` keep
 * the exact evidence and correlation that produced the current state.
 *
 * SQLite triggers (see the paired trigger migration) make raw delete, replace,
 * identity mutation, and illegal transitions impossible outside service-legal
 * transitions.
 */
export const ManagedWorktreeBindingTable = sqliteTable(
  "managed_worktree_binding",
  {
    directory: text().primaryKey(),
    binding_state: text()
      .$type<"handoff_pending" | "active" | "reconcile_required" | "quarantined" | "retired">()
      .notNull(),
    generation: integer().notNull(),
    installation_id: text().notNull(),
    repository_id: text().notNull(),
    worktree_id: text().notNull(),
    storage_volume_id: text().notNull(),
    project_id: text().notNull(),
    workspace_id: text(),
    branch_ref: text().notNull(),
    pin_ref: text(),
    head: text(),
    manager_revision: integer(),
    lifecycle_state: text(),
    operation_id: text(),
    create_operation_id: text(),
    initialization_operation_id: text(),
    state_reason: text(),
    evidence_json: text(),
    created_at: integer().notNull(),
    activated_at: integer(),
    reconciled_at: integer(),
    quarantined_at: integer(),
    retired_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("managed_worktree_binding_state_idx").on(table.binding_state),
    index("managed_worktree_binding_worktree_idx").on(
      table.installation_id,
      table.repository_id,
      table.worktree_id,
      table.binding_state,
    ),
    index("managed_worktree_binding_project_idx").on(table.project_id, table.binding_state),
    index("managed_worktree_binding_workspace_idx").on(table.workspace_id, table.binding_state),
    check(
      "managed_worktree_binding_state_check",
      sql`${table.binding_state} in ('handoff_pending', 'active', 'reconcile_required', 'quarantined', 'retired')`,
    ),
    check("managed_worktree_binding_generation_check", sql`${table.generation} > 0`),
    check(
      "managed_worktree_binding_identity_check",
      sql`length(${table.directory}) > 0 and length(${table.installation_id}) > 0 and length(${table.repository_id}) > 0 and length(${table.worktree_id}) > 0 and length(${table.storage_volume_id}) > 0 and length(${table.project_id}) > 0 and length(${table.branch_ref}) > 0`,
    ),
    check(
      "managed_worktree_binding_observation_check",
      sql`(${table.pin_ref} is null or length(${table.pin_ref}) > 0) and (${table.manager_revision} is null or ${table.manager_revision} > 0)`,
    ),
    check(
      "managed_worktree_binding_activation_check",
      sql`(${table.binding_state} <> 'active') or (${table.head} is not null and ${table.manager_revision} is not null and ${table.lifecycle_state} is not null and ${table.activated_at} is not null)`,
    ),
    check(
      "managed_worktree_binding_retirement_check",
      sql`(${table.binding_state} = 'retired' and ${table.retired_at} is not null) or (${table.binding_state} <> 'retired' and ${table.retired_at} is null)`,
    ),
  ],
)
