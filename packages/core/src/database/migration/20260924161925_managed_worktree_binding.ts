import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924161925_managed_worktree_binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`managed_worktree_binding\` (
          \`directory\` text PRIMARY KEY,
          \`binding_state\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`installation_id\` text NOT NULL,
          \`repository_id\` text NOT NULL,
          \`worktree_id\` text NOT NULL,
          \`storage_volume_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`branch_ref\` text NOT NULL,
          \`pin_ref\` text,
          \`head\` text,
          \`manager_revision\` integer,
          \`lifecycle_state\` text,
          \`operation_id\` text,
          \`create_operation_id\` text,
          \`initialization_operation_id\` text,
          \`state_reason\` text,
          \`evidence_json\` text,
          \`created_at\` integer NOT NULL,
          \`activated_at\` integer,
          \`reconciled_at\` integer,
          \`quarantined_at\` integer,
          \`retired_at\` integer,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT "managed_worktree_binding_state_check" CHECK("binding_state" in ('handoff_pending', 'active', 'reconcile_required', 'quarantined', 'retired')),
          CONSTRAINT "managed_worktree_binding_generation_check" CHECK("generation" > 0),
          CONSTRAINT "managed_worktree_binding_identity_check" CHECK(length("directory") > 0 and length("installation_id") > 0 and length("repository_id") > 0 and length("worktree_id") > 0 and length("storage_volume_id") > 0 and length("project_id") > 0 and length("branch_ref") > 0),
          CONSTRAINT "managed_worktree_binding_observation_check" CHECK(("pin_ref" is null or length("pin_ref") > 0) and ("manager_revision" is null or "manager_revision" > 0)),
          CONSTRAINT "managed_worktree_binding_activation_check" CHECK(("binding_state" <> 'active') or ("head" is not null and "manager_revision" is not null and "lifecycle_state" is not null and "activated_at" is not null)),
          CONSTRAINT "managed_worktree_binding_retirement_check" CHECK(("binding_state" = 'retired' and "retired_at" is not null) or ("binding_state" <> 'retired' and "retired_at" is null))
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`managed_worktree_binding_state_idx\` ON \`managed_worktree_binding\` (\`binding_state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`managed_worktree_binding_worktree_idx\` ON \`managed_worktree_binding\` (\`installation_id\`,\`repository_id\`,\`worktree_id\`,\`binding_state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`managed_worktree_binding_project_idx\` ON \`managed_worktree_binding\` (\`project_id\`,\`binding_state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`managed_worktree_binding_workspace_idx\` ON \`managed_worktree_binding\` (\`workspace_id\`,\`binding_state\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
