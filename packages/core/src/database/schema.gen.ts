import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`directory_activity_lease\` (
          \`lease_id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`acquired_at\` integer NOT NULL,
          \`released_at\` integer,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_directory_activity_lease_owner_id_runtime_owner_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`runtime_owner\`(\`id\`),
          CONSTRAINT "directory_activity_lease_state_check" CHECK("state" in ('active', 'released', 'reconcile_required')),
          CONSTRAINT "directory_activity_lease_release_check" CHECK(("state" = 'released' and "released_at" is not null) or ("state" <> 'released' and "released_at" is null)),
          CONSTRAINT "directory_activity_lease_identity_check" CHECK(length("lease_id") > 0 and length("kind") > 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`directory_maintenance_guard\` (
          \`directory\` text PRIMARY KEY,
          \`guard_id\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`acquisition_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`acquired_at\` integer NOT NULL,
          \`released_at\` integer,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_directory_maintenance_guard_owner_id_runtime_owner_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`runtime_owner\`(\`id\`),
          CONSTRAINT "directory_maintenance_guard_state_check" CHECK("state" in ('active', 'released', 'reconcile_required')),
          CONSTRAINT "directory_maintenance_guard_release_check" CHECK(("state" = 'released' and "released_at" is not null) or ("state" <> 'released' and "released_at" is null)),
          CONSTRAINT "directory_maintenance_guard_acquisition_check" CHECK(length("acquisition_id") > 0)
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`provider_account_route_health\` (
          \`provider_id\` text NOT NULL,
          \`account_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`credential_revision\` integer,
          \`expires_at\` integer,
          \`observed_at\` integer NOT NULL,
          CONSTRAINT \`provider_account_route_health_pk\` PRIMARY KEY(\`provider_id\`, \`account_id\`, \`model_id\`),
          CONSTRAINT "provider_account_route_health_provider_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_account_route_health_account_check" CHECK(length("account_id") > 0),
          CONSTRAINT "provider_account_route_health_model_check" CHECK(length("model_id") > 0),
          CONSTRAINT "provider_account_route_health_state_check" CHECK("state" in ('auth-invalid', 'cooling-down', 'quota-exhausted')),
          CONSTRAINT "provider_account_route_health_observed_check" CHECK("observed_at" >= 0 and "observed_at" <= 9007199254740991),
          CONSTRAINT "provider_account_route_health_shape_check" CHECK((
                "state" = 'auth-invalid'
                and "credential_revision" is not null
                and "credential_revision" > 0
                and "credential_revision" <= 9007199254740991
                and "expires_at" is null
              ) or (
                "state" in ('cooling-down', 'quota-exhausted')
                and "credential_revision" is null
                and "expires_at" is not null
                and "expires_at" > "observed_at"
                and "expires_at" <= 9007199254740991
              ))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`provider_public_route_health\` (
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`observed_at\` integer NOT NULL,
          CONSTRAINT \`provider_public_route_health_pk\` PRIMARY KEY(\`provider_id\`, \`model_id\`),
          CONSTRAINT "provider_public_route_health_provider_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_public_route_health_model_check" CHECK(length("model_id") > 0),
          CONSTRAINT "provider_public_route_health_state_check" CHECK("state" in ('cooling-down', 'quota-exhausted')),
          CONSTRAINT "provider_public_route_health_time_check" CHECK("observed_at" >= 0
                and "observed_at" <= 9007199254740991
                and "expires_at" > "observed_at"
                and "expires_at" <= 9007199254740991)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`provider_route_account_stats\` (
          \`provider_id\` text NOT NULL,
          \`affinity_domain\` text NOT NULL,
          \`account_id\` text NOT NULL,
          \`assignment_count\` integer DEFAULT 0 NOT NULL,
          \`last_assigned_at\` integer,
          CONSTRAINT \`provider_route_account_stats_pk\` PRIMARY KEY(\`provider_id\`, \`affinity_domain\`, \`account_id\`),
          CONSTRAINT "provider_route_account_stats_provider_id_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_route_account_stats_affinity_domain_check" CHECK(length("affinity_domain") > 0),
          CONSTRAINT "provider_route_account_stats_account_id_check" CHECK(length("account_id") > 0),
          CONSTRAINT "provider_route_account_stats_count_check" CHECK("assignment_count" >= 0 and "assignment_count" <= 9007199254740991),
          CONSTRAINT "provider_route_account_stats_last_assigned_at_check" CHECK("last_assigned_at" is null or ("last_assigned_at" >= 0 and "last_assigned_at" <= 9007199254740991))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`provider_route_binding\` (
          \`session_id\` text NOT NULL,
          \`affinity_domain\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`route_kind\` text NOT NULL,
          \`account_id\` text,
          \`credential_handle\` text,
          \`mode\` text,
          \`pin\` text,
          \`route_revision\` integer DEFAULT 1 NOT NULL,
          \`assigned_at\` integer NOT NULL,
          \`assignment_epoch\` integer NOT NULL,
          \`reason\` text NOT NULL,
          CONSTRAINT \`provider_route_binding_pk\` PRIMARY KEY(\`session_id\`, \`affinity_domain\`),
          CONSTRAINT \`fk_provider_route_binding_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "provider_route_binding_affinity_domain_check" CHECK(length("affinity_domain") > 0),
          CONSTRAINT "provider_route_binding_provider_id_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_route_binding_route_kind_check" CHECK("route_kind" in ('public', 'account')),
          CONSTRAINT "provider_route_binding_mode_check" CHECK("mode" is null or "mode" in ('concentrate', 'session-round-robin')),
          CONSTRAINT "provider_route_binding_pin_check" CHECK("pin" is null or "pin" in ('hard', 'soft')),
          CONSTRAINT "provider_route_binding_reason_check" CHECK("reason" in ('explicit', 'initial', 'failover', 'model-selection')),
          CONSTRAINT "provider_route_binding_revision_check" CHECK("route_revision" > 0),
          CONSTRAINT "provider_route_binding_assignment_epoch_check" CHECK("assignment_epoch" > 0),
          CONSTRAINT "provider_route_binding_assigned_at_check" CHECK("assigned_at" >= 0),
          CONSTRAINT "provider_route_binding_identity_check" CHECK((
                "route_kind" = 'public'
                and "account_id" is null
                and "credential_handle" is null
                and "mode" is null
                and "pin" is null
              ) or (
                "route_kind" = 'account'
                and "account_id" is not null
                and length("account_id") > 0
                and "credential_handle" is not null
                and length("credential_handle") > 0
              ))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`provider_route_policy_cursor\` (
          \`provider_id\` text NOT NULL,
          \`affinity_domain\` text NOT NULL,
          \`epoch\` integer DEFAULT 0 NOT NULL,
          \`last_assigned_handle\` text,
          CONSTRAINT \`provider_route_policy_cursor_pk\` PRIMARY KEY(\`provider_id\`, \`affinity_domain\`),
          CONSTRAINT "provider_route_policy_cursor_provider_id_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_route_policy_cursor_affinity_domain_check" CHECK(length("affinity_domain") > 0),
          CONSTRAINT "provider_route_policy_cursor_epoch_check" CHECK("epoch" >= 0 and "epoch" <= 9007199254740991),
          CONSTRAINT "provider_route_policy_cursor_last_handle_check" CHECK("last_assigned_handle" is null or length("last_assigned_handle") > 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`revision_draft_claim\` (
          \`target_kind\` text NOT NULL,
          \`target_key\` text NOT NULL,
          \`claim_id\` text NOT NULL,
          \`source_fingerprint\` text NOT NULL,
          \`time_claimed\` integer NOT NULL,
          CONSTRAINT \`revision_draft_claim_pk\` PRIMARY KEY(\`target_kind\`, \`target_key\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`revision_draft\` (
          \`id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`target_kind\` text NOT NULL,
          \`target_key\` text NOT NULL,
          \`purpose\` text NOT NULL,
          \`source_fingerprint\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`references\` text DEFAULT '[]' NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`runtime_owner\` (
          \`id\` text PRIMARY KEY,
          \`pid\` integer NOT NULL,
          \`started_at\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`control_epoch\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_execution_boundary\` (
          \`session_id\` text PRIMARY KEY,
          \`boundary\` text NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_execution_boundary_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_execution_owner\` (
          \`session_id\` text PRIMARY KEY,
          \`generation\` integer NOT NULL,
          \`owner_id\` text,
          \`acquired_at\` integer,
          \`interrupt_generation\` integer,
          \`interrupt_reason\` text,
          \`interrupt_requested_at\` integer,
          \`recovery_owner_id\` text,
          \`recovery_started_at\` integer,
          CONSTRAINT \`fk_session_execution_owner_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_execution_owner_owner_id_runtime_owner_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`runtime_owner\`(\`id\`),
          CONSTRAINT \`fk_session_execution_owner_recovery_owner_id_runtime_owner_id_fk\` FOREIGN KEY (\`recovery_owner_id\`) REFERENCES \`runtime_owner\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`device\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`token_hash\` text NOT NULL UNIQUE,
          \`token_prefix\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`last_seen_at\` integer,
          \`revoked_at\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_payload_chunk\` (
          \`payload_id\` text NOT NULL,
          \`chunk_index\` integer NOT NULL,
          \`text\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`event_payload_chunk_pk\` PRIMARY KEY(\`payload_id\`, \`chunk_index\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_payload_meta\` (
          \`payload_id\` text PRIMARY KEY,
          \`chunk_count\` integer NOT NULL,
          \`refs\` integer DEFAULT 0 NOT NULL,
          \`time_touched\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_value\` (
          \`aggregate_id\` text NOT NULL,
          \`value_id\` text NOT NULL,
          \`sha256\` text NOT NULL,
          \`raw_len\` integer NOT NULL,
          \`bytes\` blob NOT NULL,
          \`refs\` integer DEFAULT 1 NOT NULL,
          \`time_promoted\` integer NOT NULL,
          CONSTRAINT \`event_value_pk\` PRIMARY KEY(\`aggregate_id\`, \`value_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_auditor_session\` (
          \`parent_session_id\` text NOT NULL,
          \`goal_id\` text NOT NULL,
          \`auditor_session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`goal_auditor_session_pk\` PRIMARY KEY(\`parent_session_id\`, \`goal_id\`),
          CONSTRAINT \`fk_goal_auditor_session_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_auditor_session_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_auditor_session_auditor_session_id_session_id_fk\` FOREIGN KEY (\`auditor_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_automation\` (
          \`session_id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`audit_requested_at\` integer,
          \`auditing_at\` integer,
          \`auditor_session_id\` text,
          \`runtime_error\` text,
          \`reservation_id\` text,
          \`reservation_owner\` text,
          \`reservation_created_at\` integer,
          \`continuation_source_message_id\` text,
          \`continuation_expected_user_seq\` integer,
          \`continuation_prompt\` text,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_goal_automation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_automation_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_criterion\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`description\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          CONSTRAINT \`fk_goal_criterion_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_event\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`payload\` text DEFAULT '{}' NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_goal_event_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_evidence\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`criterion_id\` text,
          \`step_id\` text,
          \`type\` text NOT NULL,
          \`session_id\` text,
          \`message_id\` text,
          \`checkpoint_id\` text,
          \`path\` text,
          \`commit_sha\` text,
          \`summary\` text NOT NULL,
          \`verdict\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_goal_evidence_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_focus\` (
          \`session_id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`role\` text DEFAULT 'owner' NOT NULL,
          \`focused_at\` integer NOT NULL,
          CONSTRAINT \`fk_goal_focus_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_focus_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal_step\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`assigned_session_id\` text,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          CONSTRAINT \`fk_goal_step_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_step_assigned_session_id_session_id_fk\` FOREIGN KEY (\`assigned_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`goal\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`title\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`constraints\` text DEFAULT '[]' NOT NULL,
          \`status\` text DEFAULT 'draft' NOT NULL,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`auditor_runs\` integer DEFAULT 0 NOT NULL,
          \`auditor_policy\` text DEFAULT '{}' NOT NULL,
          \`blocker\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_goal_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_workspace_id_workspace_id_fk\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspace\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_anchor\` (
          \`id\` text PRIMARY KEY,
          \`memory_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`value\` text NOT NULL,
          \`normalized\` text NOT NULL,
          CONSTRAINT \`fk_memory_anchor_memory_id_memory_entry_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory_entry\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_entry\` (
          \`id\` text PRIMARY KEY,
          \`topic_id\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`project_id\` text,
          \`workspace_id\` text,
          \`kind\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`stable_key\` text,
          \`title\` text NOT NULL,
          \`content\` text NOT NULL,
          \`search_text\` text DEFAULT '' NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`valid_from\` integer NOT NULL,
          \`valid_to\` integer,
          \`supersedes_id\` text,
          \`superseded_by_id\` text,
          \`content_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_last_used\` integer,
          \`use_count\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_memory_entry_topic_id_memory_topic_id_fk\` FOREIGN KEY (\`topic_id\`) REFERENCES \`memory_topic\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_evidence\` (
          \`id\` text PRIMARY KEY,
          \`memory_id\` text NOT NULL,
          \`source_type\` text NOT NULL,
          \`session_id\` text,
          \`message_id\` text,
          \`part_id\` text,
          \`commit_sha\` text,
          \`path\` text,
          \`line_start\` integer,
          \`line_end\` integer,
          \`source_hash\` text,
          \`observed_at\` integer NOT NULL,
          \`excerpt\` text,
          CONSTRAINT \`fk_memory_evidence_memory_id_memory_entry_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory_entry\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_ingest\` (
          \`session_id\` text PRIMARY KEY,
          \`last_ingested_seq\` integer DEFAULT 0 NOT NULL,
          \`target_seq\` integer,
          \`status\` text NOT NULL,
          \`retries\` integer DEFAULT 0 NOT NULL,
          \`last_error\` text,
          \`time_started\` integer,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_suppression\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`project_id\` text,
          \`workspace_id\` text,
          \`content_hash\` text,
          \`memory_id\` text,
          \`reason\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_topic\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`project_id\` text,
          \`workspace_id\` text,
          \`key\` text NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text NOT NULL,
          \`projection\` text,
          \`projection_version\` integer DEFAULT 0 NOT NULL,
          \`projection_dirty\` integer DEFAULT 1 NOT NULL,
          \`pinned\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`ofxp_invocation_receipt\` (
          \`invocation_id\` text PRIMARY KEY,
          \`source_peer_id\` text NOT NULL,
          \`operation\` text NOT NULL,
          \`commit_class\` text NOT NULL,
          \`request_digest\` text NOT NULL,
          \`state\` text NOT NULL,
          \`target_ref\` text,
          \`result_digest\` text,
          \`created_at\` integer NOT NULL,
          \`settled_at\` integer,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_ofxp_invocation_receipt_source_peer_id_ofxp_peer_id_fk\` FOREIGN KEY (\`source_peer_id\`) REFERENCES \`ofxp_peer\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "ofxp_invocation_operation_len" CHECK(length("operation") BETWEEN 1 AND 128)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`ofxp_peer_grant\` (
          \`peer_id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`grant\` text NOT NULL,
          \`expires_at\` integer,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_ofxp_peer_grant_peer_id_ofxp_peer_id_fk\` FOREIGN KEY (\`peer_id\`) REFERENCES \`ofxp_peer\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "ofxp_peer_grant_revision_positive" CHECK("revision" >= 1)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`ofxp_peer_root\` (
          \`peer_id\` text NOT NULL,
          \`root_id\` text NOT NULL,
          \`alias\` text NOT NULL,
          \`canonical_path\` text NOT NULL,
          \`identity_fingerprint\` text,
          \`source\` text DEFAULT 'manual' NOT NULL,
          \`approved_at\` integer NOT NULL,
          CONSTRAINT \`ofxp_peer_root_pk\` PRIMARY KEY(\`peer_id\`, \`root_id\`),
          CONSTRAINT \`fk_ofxp_peer_root_peer_id_ofxp_peer_id_fk\` FOREIGN KEY (\`peer_id\`) REFERENCES \`ofxp_peer\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`ofxp_peer\` (
          \`id\` text PRIMARY KEY,
          \`realm_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`public_key_spki\` text NOT NULL,
          \`public_key_fingerprint\` text NOT NULL,
          \`rekey_state\` text DEFAULT 'stable' NOT NULL,
          \`paired_at\` integer NOT NULL,
          \`last_seen_at\` integer,
          \`revoked_at\` integer,
          \`authority_epoch\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`oxp_correlation_ref\` (
          \`scheme\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`activity_id\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`first_seen_at\` integer NOT NULL,
          \`last_seen_at\` integer NOT NULL,
          CONSTRAINT \`oxp_correlation_ref_pk\` PRIMARY KEY(\`scheme\`, \`digest\`),
          CONSTRAINT \`fk_oxp_correlation_ref_activity_id_oxp_parent_activity_id_fk\` FOREIGN KEY (\`activity_id\`) REFERENCES \`oxp_parent_activity\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`oxp_invocation_detail\` (
          \`invocation_id\` text PRIMARY KEY,
          \`request\` text,
          \`outcome\` text,
          CONSTRAINT \`fk_oxp_invocation_detail_invocation_id_oxp_invocation_id_fk\` FOREIGN KEY (\`invocation_id\`) REFERENCES \`oxp_invocation\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`oxp_invocation_link\` (
          \`invocation_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`ref\` text NOT NULL,
          \`label\` text,
          \`relation\` text NOT NULL,
          CONSTRAINT \`oxp_invocation_link_pk\` PRIMARY KEY(\`invocation_id\`, \`kind\`, \`ref\`, \`relation\`),
          CONSTRAINT \`fk_oxp_invocation_link_invocation_id_oxp_invocation_id_fk\` FOREIGN KEY (\`invocation_id\`) REFERENCES \`oxp_invocation\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`oxp_invocation\` (
          \`id\` text PRIMARY KEY,
          \`activity_id\` text NOT NULL,
          \`host_run_id\` text NOT NULL,
          \`observed_epoch\` integer,
          \`plane\` text NOT NULL,
          \`tool\` text NOT NULL,
          \`action\` text,
          \`root_id\` text,
          \`root_alias\` text,
          \`status\` text DEFAULT 'running' NOT NULL,
          \`error_code\` text,
          \`mutation_attempted\` integer DEFAULT false NOT NULL,
          \`mutation_committed\` integer DEFAULT false NOT NULL,
          \`safe_summary\` text,
          \`context_request_chars\` integer,
          \`context_request_source\` text,
          \`context_request_schema\` text,
          \`context_result_chars\` integer,
          \`context_result_source\` text,
          \`context_result_schema\` text,
          \`time_started\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_oxp_invocation_activity_id_oxp_parent_activity_id_fk\` FOREIGN KEY (\`activity_id\`) REFERENCES \`oxp_parent_activity\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`oxp_parent_activity\` (
          \`id\` text PRIMARY KEY,
          \`title\` text,
          \`first_seen_at\` integer NOT NULL,
          \`last_seen_at\` integer NOT NULL,
          \`call_count\` integer DEFAULT 0 NOT NULL,
          \`failure_count\` integer DEFAULT 0 NOT NULL,
          \`augmentation_calls\` integer DEFAULT 0 NOT NULL,
          \`supervision_calls\` integer DEFAULT 0 NOT NULL,
          \`delegation_calls\` integer DEFAULT 0 NOT NULL,
          \`observed_epoch_count\` integer DEFAULT 0 NOT NULL,
          \`last_tool\` text,
          \`last_root_alias\` text,
          \`time_archived\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`push_subscription\` (
          \`id\` text PRIMARY KEY,
          \`endpoint\` text NOT NULL UNIQUE,
          \`p256dh\` text NOT NULL,
          \`auth\` text NOT NULL,
          \`expiration_time\` integer,
          \`user_agent_hint\` text,
          \`created_at\` integer NOT NULL,
          \`last_seen_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`push_vapid_key\` (
          \`id\` text PRIMARY KEY,
          \`public_key\` text NOT NULL,
          \`private_key\` text NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task_control\` (
          \`id\` text PRIMARY KEY,
          \`paused\` integer DEFAULT false NOT NULL,
          \`generation\` integer DEFAULT 0 NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task_lease\` (
          \`task_id\` text PRIMARY KEY,
          \`fire_for\` integer NOT NULL,
          \`lease_id\` text NOT NULL,
          \`owner\` text,
          \`acquired_at\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`attempt\` integer DEFAULT 1 NOT NULL,
          CONSTRAINT \`fk_scheduled_task_lease_task_id_scheduled_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`scheduled_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task_run\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`fire_for\` integer NOT NULL,
          \`trigger\` text NOT NULL,
          \`status\` text NOT NULL,
          \`session_id\` text,
          \`goal_id\` text,
          \`workspace_id\` text,
          \`directory\` text,
          \`skip_reason\` text,
          \`error_kind\` text,
          \`error_message\` text,
          \`attempt\` integer DEFAULT 1 NOT NULL,
          \`acknowledged_at\` integer,
          \`started_at\` integer NOT NULL,
          \`finished_at\` integer,
          CONSTRAINT \`fk_scheduled_task_run_task_id_scheduled_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`scheduled_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task_session_binding\` (
          \`task_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`task_revision\` integer NOT NULL,
          \`user_seq_fence\` integer,
          \`generation\` integer DEFAULT 1 NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_scheduled_task_session_binding_task_id_scheduled_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`scheduled_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text,
          \`target_directory\` text NOT NULL,
          \`target\` text NOT NULL,
          \`session_policy\` text DEFAULT '{"kind":"new"}' NOT NULL,
          \`name\` text NOT NULL,
          \`enabled\` integer DEFAULT false NOT NULL,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`schedule\` text NOT NULL,
          \`timezone\` text,
          \`action\` text NOT NULL,
          \`policy\` text NOT NULL,
          \`next_run_at\` integer,
          \`last_run_at\` integer,
          \`last_run_status\` text,
          \`last_run_id\` text,
          \`consecutive_failures\` integer DEFAULT 0 NOT NULL,
          \`source\` text DEFAULT 'api' NOT NULL,
          \`source_path\` text,
          \`source_message_id\` text,
          \`source_ref\` text,
          \`source_principal\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_scheduled_task_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part_search_backfill\` (
          \`id\` integer PRIMARY KEY,
          \`watermark_rowid\` integer DEFAULT -1 NOT NULL,
          \`done\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          \`search_text\` text DEFAULT '' NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`search_backfill\` (
          \`id\` integer PRIMARY KEY,
          \`watermark_rowid\` integer DEFAULT -1 NOT NULL,
          \`done\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_checkpoint_search\` (
          \`checkpoint_id\` text PRIMARY KEY NOT NULL,
          \`paths\` text DEFAULT '' NOT NULL,
          CONSTRAINT \`fk_session_checkpoint_search_checkpoint_id_session_checkpoint_id_fk\` FOREIGN KEY (\`checkpoint_id\`) REFERENCES \`session_checkpoint\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_checkpoint\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`status\` text NOT NULL,
          \`before_snapshot\` text,
          \`after_snapshot\` text,
          \`user_message_id\` text,
          \`assistant_message_id\` text,
          \`diff\` text,
          \`additions\` integer DEFAULT 0 NOT NULL,
          \`deletions\` integer DEFAULT 0 NOT NULL,
          \`files\` integer DEFAULT 0 NOT NULL,
          \`excluded\` text,
          \`error\` text,
          \`epoch\` text NOT NULL,
          \`epoch_mismatch\` integer DEFAULT 0 NOT NULL,
          \`created_at\` integer NOT NULL,
          \`finalized_at\` integer,
          CONSTRAINT \`fk_session_checkpoint_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_ops\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL,
          \`batch_id\` text NOT NULL,
          \`operations\` text NOT NULL,
          \`timestamp\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_ops_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_state\` (
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`excluded\` integer DEFAULT false NOT NULL,
          \`pinned\` integer DEFAULT false NOT NULL,
          \`override_data\` text,
          \`override_search_text\` text,
          \`modified_seq\` integer,
          \`modified_at\` integer NOT NULL,
          CONSTRAINT \`session_context_state_pk\` PRIMARY KEY(\`session_id\`, \`message_id\`),
          CONSTRAINT \`fk_session_context_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_fork_origin\` (
          \`session_id\` text PRIMARY KEY NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`source_message_id\` text,
          \`source_seq\` integer,
          \`edge\` text,
          \`kind\` text NOT NULL,
          \`workspace_mode\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_fork_origin_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_group_member\` (
          \`group_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`locked\` integer DEFAULT false NOT NULL,
          \`origin\` text DEFAULT 'user' NOT NULL,
          \`origin_plugin\` text,
          \`origin_ref\` text,
          \`position\` integer DEFAULT 0 NOT NULL,
          \`time_added\` integer NOT NULL,
          CONSTRAINT \`session_group_member_pk\` PRIMARY KEY(\`group_id\`, \`session_id\`),
          CONSTRAINT \`fk_session_group_member_group_id_session_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`session_group\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_group_member_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_group\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`kind\` text DEFAULT 'user' NOT NULL,
          \`owner_plugin\` text,
          \`owner_ref\` text,
          \`anchor_session_id\` text,
          \`policy\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_archived\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`kind\` text DEFAULT 'user' NOT NULL,
          \`admission_class\` text DEFAULT 'user' NOT NULL,
          \`user_preemptible\` integer DEFAULT false NOT NULL,
          \`input\` text,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`provenance\` text,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`revoked_seq\` integer,
          \`revoked_reason\` text,
          \`completed_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message_lifecycle\` (
          \`message_id\` text PRIMARY KEY,
          \`streamed_at\` integer,
          \`settlement\` text,
          CONSTRAINT \`fk_session_message_lifecycle_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          \`search_text\` text DEFAULT '' NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message_tool_overlay\` (
          \`message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`progress_event_id\` text,
          \`settlement_event_id\` text,
          CONSTRAINT \`session_message_tool_overlay_pk\` PRIMARY KEY(\`message_id\`, \`call_id\`),
          CONSTRAINT \`fk_session_message_tool_overlay_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          \`paused_at\` integer,
          \`group_id\` text,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_telemetry\` (
          \`session_id\` text PRIMARY KEY,
          \`assistant_message_id\` text,
          \`provider_id\` text,
          \`model_id\` text,
          \`model_name\` text,
          \`variant\` text,
          \`context_limit\` integer,
          \`request_sent_at\` integer,
          \`first_token_at\` integer,
          \`streamed_at\` integer,
          \`completed_at\` integer,
          \`cost_usd\` real,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`generated_ms\` integer DEFAULT 0 NOT NULL,
          \`tool_ms\` integer DEFAULT 0 NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_telemetry_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_blackboard\` (
          \`swarm_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text NOT NULL,
          \`content_type\` text NOT NULL,
          \`version\` integer DEFAULT 0 NOT NULL,
          \`author_member_id\` text NOT NULL,
          \`task_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`swarm_blackboard_pk\` PRIMARY KEY(\`swarm_id\`, \`key\`),
          CONSTRAINT \`fk_swarm_blackboard_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_blackboard_author_member_id_swarm_member_id_fk\` FOREIGN KEY (\`author_member_id\`) REFERENCES \`swarm_member\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_claim\` (
          \`swarm_id\` text NOT NULL,
          \`member_id\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`generation\` integer DEFAULT 0 NOT NULL,
          \`expires_at\` integer,
          \`released_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`swarm_claim_pk\` PRIMARY KEY(\`swarm_id\`, \`member_id\`, \`scope\`),
          CONSTRAINT \`fk_swarm_claim_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_claim_member_id_swarm_member_id_fk\` FOREIGN KEY (\`member_id\`) REFERENCES \`swarm_member\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_deliverable\` (
          \`id\` text PRIMARY KEY,
          \`swarm_id\` text NOT NULL,
          \`member_id\` text NOT NULL,
          \`task_run_id\` text,
          \`summary\` text NOT NULL,
          \`refs\` text DEFAULT '[]' NOT NULL,
          \`files\` text DEFAULT '[]' NOT NULL,
          \`verdict\` text,
          \`verdict_by_member_id\` text,
          \`time_created\` integer NOT NULL,
          \`verdict_at\` integer,
          CONSTRAINT \`fk_swarm_deliverable_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_deliverable_member_id_swarm_member_id_fk\` FOREIGN KEY (\`member_id\`) REFERENCES \`swarm_member\`(\`id\`),
          CONSTRAINT \`fk_swarm_deliverable_task_run_id_swarm_task_run_id_fk\` FOREIGN KEY (\`task_run_id\`) REFERENCES \`swarm_task_run\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_member\` (
          \`id\` text PRIMARY KEY,
          \`swarm_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`role\` text NOT NULL,
          \`lifecycle\` text DEFAULT 'active' NOT NULL,
          \`session_id\` text,
          \`binding_generation\` integer DEFAULT 0 NOT NULL,
          \`desired_profile\` text,
          \`workspace_policy\` text NOT NULL,
          \`capabilities\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_stopped\` integer,
          CONSTRAINT \`fk_swarm_member_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_member_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_message_delivery\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`recipient_member_id\` text NOT NULL,
          \`state\` text DEFAULT 'pending' NOT NULL,
          \`session_input_id\` text NOT NULL,
          \`claim_generation\` integer DEFAULT 0 NOT NULL,
          \`claim_owner\` text,
          \`claim_expires_at\` integer,
          \`next_attempt_at\` integer,
          \`attempt_count\` integer DEFAULT 0 NOT NULL,
          \`admitted_session_id\` text,
          \`admitted_seq\` integer,
          \`admitted_at\` integer,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_swarm_message_delivery_message_id_swarm_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`swarm_message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_message_delivery_recipient_member_id_swarm_member_id_fk\` FOREIGN KEY (\`recipient_member_id\`) REFERENCES \`swarm_member\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_message\` (
          \`id\` text PRIMARY KEY,
          \`swarm_id\` text NOT NULL,
          \`sender_member_id\` text NOT NULL,
          \`sender_session_id\` text NOT NULL,
          \`sender_binding_generation\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`body\` text NOT NULL,
          \`task_id\` text,
          \`correlation_id\` text,
          \`response_to\` text,
          \`priority\` text DEFAULT 'normal' NOT NULL,
          \`reply_expected\` integer DEFAULT true NOT NULL,
          \`time_created\` integer NOT NULL,
          \`expires_at\` integer,
          CONSTRAINT \`fk_swarm_message_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_message_sender_member_id_swarm_member_id_fk\` FOREIGN KEY (\`sender_member_id\`) REFERENCES \`swarm_member\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`name\` text NOT NULL,
          \`status\` text DEFAULT 'creating' NOT NULL,
          \`coordinator_member_id\` text,
          \`policy\` text DEFAULT '{}' NOT NULL,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_swarm_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_workspace_id_workspace_id_fk\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspace\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_task_dependency\` (
          \`task_id\` text NOT NULL,
          \`depends_on_task_id\` text NOT NULL,
          \`requirement\` text DEFAULT 'require_success' NOT NULL,
          CONSTRAINT \`swarm_task_dependency_pk\` PRIMARY KEY(\`task_id\`, \`depends_on_task_id\`),
          CONSTRAINT \`fk_swarm_task_dependency_task_id_swarm_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`swarm_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_task_dependency_depends_on_task_id_swarm_task_id_fk\` FOREIGN KEY (\`depends_on_task_id\`) REFERENCES \`swarm_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "swarm_task_dependency_no_self_check" CHECK("task_id" != "depends_on_task_id")
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_task_lease\` (
          \`task_id\` text PRIMARY KEY,
          \`generation\` integer NOT NULL,
          \`owner_member_id\` text NOT NULL,
          \`owner_session_id\` text NOT NULL,
          \`owner_binding_generation\` integer NOT NULL,
          \`lease_owner_process\` text NOT NULL,
          \`state\` text DEFAULT 'active' NOT NULL,
          \`hold_user_seq\` integer,
          \`hold_started_at\` integer,
          \`hold_deadline\` integer,
          \`retire_reason\` text,
          \`retire_requested_at\` integer,
          \`acquired_at\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`renewed_at\` integer,
          CONSTRAINT \`fk_swarm_task_lease_task_id_swarm_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`swarm_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_task_lease_owner_member_id_swarm_member_id_fk\` FOREIGN KEY (\`owner_member_id\`) REFERENCES \`swarm_member\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_task_run\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`member_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`binding_generation\` integer NOT NULL,
          \`lease_generation\` integer NOT NULL,
          \`session_input_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`failure_kind\` text,
          \`failure_detail\` text,
          \`result_summary\` text,
          \`admitted_at\` integer,
          \`started_at\` integer,
          \`ended_at\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_swarm_task_run_task_id_swarm_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`swarm_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_swarm_task_run_member_id_swarm_member_id_fk\` FOREIGN KEY (\`member_id\`) REFERENCES \`swarm_member\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`swarm_task\` (
          \`id\` text PRIMARY KEY,
          \`swarm_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`priority\` integer DEFAULT 0 NOT NULL,
          \`created_by_member_id\` text,
          \`reserved_member_id\` text,
          \`reserved_until\` integer,
          \`reservation_revision\` integer DEFAULT 0 NOT NULL,
          \`lease_generation\` integer DEFAULT 0 NOT NULL,
          \`semantic_retry_count\` integer DEFAULT 0 NOT NULL,
          \`acceptance\` text DEFAULT '{"criteria":[]}' NOT NULL,
          \`metadata\` text DEFAULT '{}' NOT NULL,
          \`ready_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_swarm_task_swarm_id_swarm_id_fk\` FOREIGN KEY (\`swarm_id\`) REFERENCES \`swarm\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`maintenance_usage\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`agent\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`route_kind\` text,
          \`account_id\` text,
          \`variant\` text,
          \`session_id\` text,
          \`project_id\` text,
          \`requests\` integer DEFAULT 1 NOT NULL,
          \`cost_usd\` real,
          \`cost_estimated\` integer DEFAULT false NOT NULL,
          \`input_tokens\` integer DEFAULT 0 NOT NULL,
          \`cache_read_tokens\` integer DEFAULT 0 NOT NULL,
          \`cache_write_tokens\` integer DEFAULT 0 NOT NULL,
          \`output_tokens\` integer DEFAULT 0 NOT NULL,
          \`reasoning_tokens\` integer DEFAULT 0 NOT NULL,
          \`total_tokens\` integer DEFAULT 0 NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_record\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`base_model_id\` text,
          \`route_kind\` text,
          \`account_id\` text,
          \`variant\` text,
          \`agent\` text,
          \`mode\` text,
          \`created_at\` integer,
          \`request_sent_at\` integer,
          \`first_token_at\` integer,
          \`streamed_at\` integer,
          \`completed_at\` integer NOT NULL,
          \`cost_usd\` real,
          \`input_tokens\` integer DEFAULT 0 NOT NULL,
          \`cache_read_tokens\` integer DEFAULT 0 NOT NULL,
          \`cache_write_tokens\` integer DEFAULT 0 NOT NULL,
          \`output_tokens\` integer DEFAULT 0 NOT NULL,
          \`reasoning_tokens\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_session\` (
          \`session_id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`title\` text NOT NULL,
          \`project_name\` text,
          \`session_created_at\` integer NOT NULL,
          \`session_updated_at\` integer NOT NULL,
          \`last_usage_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_yield_meta\` (
          \`id\` text PRIMARY KEY,
          \`version\` integer NOT NULL,
          \`rebuilt_at\` integer NOT NULL,
          \`source_rows\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_yield_stat\` (
          \`stat_key\` text PRIMARY KEY,
          \`provider_id\` text NOT NULL,
          \`base_model_id\` text NOT NULL,
          \`account_id\` text,
          \`state\` text NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`directory_activity_lease_directory_idx\` ON \`directory_activity_lease\` (\`directory\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`directory_activity_lease_owner_idx\` ON \`directory_activity_lease\` (\`owner_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`directory_maintenance_guard_guard_idx\` ON \`directory_maintenance_guard\` (\`guard_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`directory_maintenance_guard_owner_idx\` ON \`directory_maintenance_guard\` (\`owner_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`directory_maintenance_guard_acquisition_idx\` ON \`directory_maintenance_guard\` (\`acquisition_id\`,\`state\`);`,
      )
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
      yield* tx.run(
        `CREATE INDEX \`provider_account_route_health_expiry_idx\` ON \`provider_account_route_health\` (\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`provider_public_route_health_expiry_idx\` ON \`provider_public_route_health\` (\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`provider_route_binding_provider_kind_idx\` ON \`provider_route_binding\` (\`provider_id\`,\`route_kind\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`provider_route_binding_account_idx\` ON \`provider_route_binding\` (\`provider_id\`,\`account_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`provider_route_binding_credential_idx\` ON \`provider_route_binding\` (\`provider_id\`,\`credential_handle\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`revision_draft_target_idx\` ON \`revision_draft\` (\`target_kind\`,\`target_key\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_execution_owner_owner_idx\` ON \`session_execution_owner\` (\`owner_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_execution_owner_recovery_owner_idx\` ON \`session_execution_owner\` (\`recovery_owner_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`event_payload_chunk_time_created_idx\` ON \`event_payload_chunk\` (\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`event_payload_meta_orphan_idx\` ON \`event_payload_meta\` (\`refs\`,\`time_touched\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_value_agg_sha_idx\` ON \`event_value\` (\`aggregate_id\`,\`sha256\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`goal_auditor_session_session_idx\` ON \`goal_auditor_session\` (\`auditor_session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`goal_auditor_session_goal_idx\` ON \`goal_auditor_session\` (\`goal_id\`);`)
      yield* tx.run(`CREATE INDEX \`goal_automation_goal_idx\` ON \`goal_automation\` (\`goal_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`goal_automation_reservation_idx\` ON \`goal_automation\` (\`reservation_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`goal_criterion_goal_position_idx\` ON \`goal_criterion\` (\`goal_id\`,\`position\`);`,
      )
      yield* tx.run(`CREATE INDEX \`goal_criterion_goal_status_idx\` ON \`goal_criterion\` (\`goal_id\`,\`status\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`goal_event_goal_seq_idx\` ON \`goal_event\` (\`goal_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`goal_event_goal_created_idx\` ON \`goal_event\` (\`goal_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`goal_evidence_goal_created_idx\` ON \`goal_evidence\` (\`goal_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`goal_evidence_criterion_idx\` ON \`goal_evidence\` (\`criterion_id\`);`)
      yield* tx.run(`CREATE INDEX \`goal_evidence_step_idx\` ON \`goal_evidence\` (\`step_id\`);`)
      yield* tx.run(`CREATE INDEX \`goal_focus_goal_idx\` ON \`goal_focus\` (\`goal_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`goal_step_goal_position_idx\` ON \`goal_step\` (\`goal_id\`,\`position\`);`)
      yield* tx.run(`CREATE INDEX \`goal_step_goal_status_idx\` ON \`goal_step\` (\`goal_id\`,\`status\`);`)
      yield* tx.run(`CREATE INDEX \`goal_step_session_idx\` ON \`goal_step\` (\`assigned_session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`goal_project_status_updated_idx\` ON \`goal\` (\`project_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`goal_workspace_status_updated_idx\` ON \`goal\` (\`workspace_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_anchor_normalized_idx\` ON \`memory_anchor\` (\`normalized\`);`)
      yield* tx.run(`CREATE INDEX \`memory_anchor_kind_value_idx\` ON \`memory_anchor\` (\`kind\`,\`value\`);`)
      yield* tx.run(`CREATE INDEX \`memory_anchor_memory_idx\` ON \`memory_anchor\` (\`memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_entry_topic_idx\` ON \`memory_entry\` (\`topic_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_entry_scope_idx\` ON \`memory_entry\` (\`scope\`,\`project_id\`,\`workspace_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_entry_status_idx\` ON \`memory_entry\` (\`status\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_entry_stable_key_idx\` ON \`memory_entry\` (\`scope\`,\`project_id\`,\`stable_key\`,\`status\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_entry_content_hash_idx\` ON \`memory_entry\` (\`scope\`,\`content_hash\`);`)
      yield* tx.run(`CREATE INDEX \`memory_entry_time_updated_idx\` ON \`memory_entry\` (\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_evidence_memory_idx\` ON \`memory_evidence\` (\`memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_evidence_session_idx\` ON \`memory_evidence\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_ingest_status_idx\` ON \`memory_ingest\` (\`status\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_suppression_hash_idx\` ON \`memory_suppression\` (\`scope\`,\`content_hash\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_suppression_memory_idx\` ON \`memory_suppression\` (\`memory_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_topic_scope_key_idx\` ON \`memory_topic\` (\`scope\`,\`project_id\`,\`workspace_id\`,\`key\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_topic_project_idx\` ON \`memory_topic\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_topic_workspace_idx\` ON \`memory_topic\` (\`workspace_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`ofxp_invocation_peer_created_idx\` ON \`ofxp_invocation_receipt\` (\`source_peer_id\`,\`created_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`ofxp_invocation_state_created_idx\` ON \`ofxp_invocation_receipt\` (\`state\`,\`created_at\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`ofxp_peer_root_alias_idx\` ON \`ofxp_peer_root\` (\`peer_id\`,\`alias\`);`)
      yield* tx.run(`CREATE INDEX \`ofxp_peer_root_path_idx\` ON \`ofxp_peer_root\` (\`peer_id\`,\`canonical_path\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`ofxp_peer_fingerprint_idx\` ON \`ofxp_peer\` (\`public_key_fingerprint\`);`)
      yield* tx.run(
        `CREATE INDEX \`ofxp_peer_active_seen_idx\` ON \`ofxp_peer\` (\`revoked_at\`,\`last_seen_at\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`oxp_correlation_ref_activity_idx\` ON \`oxp_correlation_ref\` (\`activity_id\`);`)
      yield* tx.run(`CREATE INDEX \`oxp_invocation_link_ref_idx\` ON \`oxp_invocation_link\` (\`kind\`,\`ref\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`oxp_invocation_link_invocation_ref_idx\` ON \`oxp_invocation_link\` (\`invocation_id\`,\`kind\`,\`ref\`,\`relation\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`oxp_invocation_activity_started_idx\` ON \`oxp_invocation\` (\`activity_id\`,\`time_started\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`oxp_invocation_activity_status_started_idx\` ON \`oxp_invocation\` (\`activity_id\`,\`status\`,\`time_started\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`oxp_invocation_activity_host_epoch_idx\` ON \`oxp_invocation\` (\`activity_id\`,\`host_run_id\`,\`observed_epoch\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`oxp_invocation_status_host_idx\` ON \`oxp_invocation\` (\`status\`,\`host_run_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`oxp_invocation_started_idx\` ON \`oxp_invocation\` (\`time_started\`);`)
      yield* tx.run(
        `CREATE INDEX \`oxp_parent_activity_last_seen_idx\` ON \`oxp_parent_activity\` (\`time_archived\`,\`last_seen_at\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`scheduled_task_lease_id_idx\` ON \`scheduled_task_lease\` (\`lease_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_lease_heartbeat_idx\` ON \`scheduled_task_lease\` (\`heartbeat_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_task_run_logical_idx\` ON \`scheduled_task_run\` (\`task_id\`,\`fire_for\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`scheduled_task_run_goal_idx\` ON \`scheduled_task_run\` (\`goal_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_run_task_started_idx\` ON \`scheduled_task_run\` (\`task_id\`,\`started_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_run_started_idx\` ON \`scheduled_task_run\` (\`started_at\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_run_inbox_idx\` ON \`scheduled_task_run\` (\`acknowledged_at\`,\`started_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_task_session_binding_session_idx\` ON \`scheduled_task_session_binding\` (\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`scheduled_task_due_idx\` ON \`scheduled_task\` (\`enabled\`,\`next_run_at\`);`)
      yield* tx.run(`CREATE INDEX \`scheduled_task_project_idx\` ON \`scheduled_task\` (\`project_id\`,\`name\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`scheduled_task_source_path_idx\` ON \`scheduled_task\` (\`source_path\`);`)
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_checkpoint_session_id_idx\` ON \`session_checkpoint\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_checkpoint_session_ordinal_idx\` ON \`session_checkpoint\` (\`session_id\`,\`ordinal\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_checkpoint_session_user_message_idx\` ON \`session_checkpoint\` (\`session_id\`,\`user_message_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_checkpoint_epoch_created_idx\` ON \`session_checkpoint\` (\`epoch\`,\`created_at\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_context_ops_session_idx\` ON \`session_context_ops\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_context_ops_session_time_idx\` ON \`session_context_ops\` (\`session_id\`,\`timestamp\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_context_state_session_idx\` ON \`session_context_state\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_fork_origin_parent_idx\` ON \`session_fork_origin\` (\`parent_session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_group_member_session_idx\` ON \`session_group_member\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_group_member_position_idx\` ON \`session_group_member\` (\`group_id\`,\`position\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_group_subagent_anchor_idx\` ON \`session_group\` (\`kind\`,\`anchor_session_id\`) WHERE "session_group"."kind" = 'subagent' AND "session_group"."anchor_session_id" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_group_plugin_owner_ref_idx\` ON \`session_group\` (\`kind\`,\`owner_plugin\`,\`owner_ref\`) WHERE "session_group"."kind" = 'plugin' AND "session_group"."owner_plugin" IS NOT NULL AND "session_group"."owner_ref" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_class_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`admission_class\`,\`delivery\`,\`admitted_seq\`) WHERE "session_input"."promoted_seq" IS NULL AND "session_input"."revoked_seq" IS NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_session_latest_user_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`) WHERE "session_input"."kind" = 'user' AND "session_input"."admission_class" = 'user';`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_session_preemptible_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`) WHERE "session_input"."user_preemptible" = 1 AND "session_input"."promoted_seq" IS NULL AND "session_input"."revoked_seq" IS NULL;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_message_tool_overlay_message_idx\` ON \`session_message_tool_overlay\` (\`message_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_tool_overlay_unsettled_idx\` ON \`session_message_tool_overlay\` (\`message_id\`,\`call_id\`) WHERE ("session_message_tool_overlay"."settlement_event_id" is null);`,
      )
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_project_directory_root_updated_idx\` ON \`session\` (\`project_id\`,\`directory\`,\`time_updated\`) WHERE ("session"."parent_id" is null);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_project_root_updated_id_idx\` ON \`session\` (\`project_id\`,\`time_updated\`,\`id\`) WHERE ("session"."parent_id" is null);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_directory_root_created_id_idx\` ON \`session\` (\`directory\`,\`time_created\`,\`id\`) WHERE ("session"."parent_id" is null);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_directory_root_updated_id_idx\` ON \`session\` (\`directory\`,\`time_updated\`,\`id\`) WHERE "session"."parent_id" IS NULL AND "session"."time_archived" IS NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_directory_root_archived_id_idx\` ON \`session\` (\`directory\`,\`time_archived\`,\`id\`) WHERE "session"."parent_id" IS NULL AND "session"."time_archived" IS NOT NULL;`,
      )
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_group_idx\` ON \`session\` (\`group_id\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`swarm_blackboard_task_idx\` ON \`swarm_blackboard\` (\`swarm_id\`,\`task_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_claim_expiry_idx\` ON \`swarm_claim\` (\`expires_at\`,\`swarm_id\`,\`member_id\`) WHERE "swarm_claim"."released_at" IS NULL AND "swarm_claim"."expires_at" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_deliverable_stream_idx\` ON \`swarm_deliverable\` (\`swarm_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_deliverable_member_idx\` ON \`swarm_deliverable\` (\`swarm_id\`,\`member_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`swarm_deliverable_task_run_idx\` ON \`swarm_deliverable\` (\`task_run_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_deliverable_open_idx\` ON \`swarm_deliverable\` (\`swarm_id\`,\`time_created\`,\`id\`) WHERE "swarm_deliverable"."verdict" IS NULL;`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`swarm_member_name_idx\` ON \`swarm_member\` (\`swarm_id\`,\`name\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`swarm_member_bound_session_idx\` ON \`swarm_member\` (\`swarm_id\`,\`session_id\`) WHERE "swarm_member"."session_id" IS NOT NULL;`,
      )
      yield* tx.run(`CREATE INDEX \`swarm_member_session_idx\` ON \`swarm_member\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_member_roster_idx\` ON \`swarm_member\` (\`swarm_id\`,\`lifecycle\`,\`kind\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`swarm_message_delivery_recipient_idx\` ON \`swarm_message_delivery\` (\`message_id\`,\`recipient_member_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`swarm_message_delivery_input_idx\` ON \`swarm_message_delivery\` (\`session_input_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_delivery_recipient_pending_idx\` ON \`swarm_message_delivery\` (\`recipient_member_id\`,\`time_created\`,\`id\`) WHERE "swarm_message_delivery"."state" = 'pending';`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_delivery_due_idx\` ON \`swarm_message_delivery\` (\`next_attempt_at\`,\`id\`) WHERE "swarm_message_delivery"."state" = 'pending';`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_delivery_claim_expiry_idx\` ON \`swarm_message_delivery\` (\`claim_expires_at\`,\`id\`) WHERE "swarm_message_delivery"."state" = 'claimed';`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_stream_idx\` ON \`swarm_message\` (\`swarm_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_correlation_idx\` ON \`swarm_message\` (\`swarm_id\`,\`correlation_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_message_expiry_idx\` ON \`swarm_message\` (\`expires_at\`,\`id\`) WHERE "swarm_message"."expires_at" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_project_status_updated_idx\` ON \`swarm\` (\`project_id\`,\`status\`,\`time_updated\`);`,
      )
      yield* tx.run(`CREATE INDEX \`swarm_workspace_idx\` ON \`swarm\` (\`workspace_id\`,\`status\`,\`time_updated\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_task_dependency_reverse_idx\` ON \`swarm_task_dependency\` (\`depends_on_task_id\`,\`task_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`swarm_task_lease_due_idx\` ON \`swarm_task_lease\` (\`expires_at\`,\`task_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_process_due_idx\` ON \`swarm_task_lease\` (\`lease_owner_process\`,\`expires_at\`,\`task_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_state_owner_idx\` ON \`swarm_task_lease\` (\`state\`,\`lease_owner_process\`,\`task_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_hold_due_idx\` ON \`swarm_task_lease\` (\`hold_deadline\`,\`task_id\`) WHERE "swarm_task_lease"."state" = 'human_hold' AND "swarm_task_lease"."hold_deadline" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_state_retire_idx\` ON \`swarm_task_lease\` (\`state\`,\`retire_requested_at\`,\`task_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_member_idx\` ON \`swarm_task_lease\` (\`owner_member_id\`,\`task_id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`swarm_task_run_input_idx\` ON \`swarm_task_run\` (\`session_input_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`swarm_task_run_task_created_idx\` ON \`swarm_task_run\` (\`task_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_run_member_created_idx\` ON \`swarm_task_run\` (\`member_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_ready_idx\` ON \`swarm_task\` (\`swarm_id\`,\`status\`,"priority" DESC,\`ready_at\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_dispatch_ready_idx\` ON \`swarm_task\` ("priority" DESC,\`ready_at\`,\`time_created\`,\`id\`,\`swarm_id\`) WHERE "swarm_task"."status" = 'ready';`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_reserved_member_idx\` ON \`swarm_task\` (\`reserved_member_id\`,\`status\`,\`reserved_until\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_reservation_due_idx\` ON \`swarm_task\` (\`reserved_until\`,\`id\`) WHERE "swarm_task"."status" = 'ready' AND "swarm_task"."reserved_until" IS NOT NULL;`,
      )
      yield* tx.run(`CREATE INDEX \`maintenance_usage_completed_idx\` ON \`maintenance_usage\` (\`time_completed\`);`)
      yield* tx.run(
        `CREATE INDEX \`maintenance_usage_project_completed_idx\` ON \`maintenance_usage\` (\`project_id\`,\`time_completed\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`maintenance_usage_agent_completed_idx\` ON \`maintenance_usage\` (\`agent\`,\`time_completed\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`maintenance_usage_account_completed_idx\` ON \`maintenance_usage\` (\`provider_id\`,\`account_id\`,\`time_completed\`);`,
      )
      yield* tx.run(`CREATE INDEX \`usage_record_completed_idx\` ON \`usage_record\` (\`completed_at\`);`)
      yield* tx.run(
        `CREATE INDEX \`usage_record_session_completed_idx\` ON \`usage_record\` (\`session_id\`,\`completed_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_record_model_completed_idx\` ON \`usage_record\` (\`provider_id\`,\`model_id\`,\`completed_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_record_base_model_completed_idx\` ON \`usage_record\` (\`provider_id\`,\`base_model_id\`,\`completed_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_record_account_model_completed_idx\` ON \`usage_record\` (\`provider_id\`,\`base_model_id\`,\`account_id\`,\`completed_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_session_project_last_usage_idx\` ON \`usage_session\` (\`project_id\`,\`last_usage_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_yield_stat_model_idx\` ON \`usage_yield_stat\` (\`provider_id\`,\`base_model_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_yield_stat_account_idx\` ON \`usage_yield_stat\` (\`provider_id\`,\`base_model_id\`,\`account_id\`);`,
      )
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
