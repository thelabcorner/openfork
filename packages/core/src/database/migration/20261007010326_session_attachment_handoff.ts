import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007010326_session_attachment_handoff",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_attachment_blob\` (
          \`id\` text PRIMARY KEY,
          \`content_hash\` text NOT NULL,
          \`mime\` text NOT NULL,
          \`byte_length\` integer NOT NULL,
          \`bytes\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_attachment_grant\` (
          \`id\` text PRIMARY KEY,
          \`attachment_id\` text NOT NULL,
          \`source_session_id\` text NOT NULL,
          \`source_message_id\` text NOT NULL,
          \`source_part_id\` text NOT NULL,
          \`target_kind\` text NOT NULL,
          \`target_child_session_id\` text,
          \`target_tool_call_id\` text,
          \`target_tool_part_id\` text,
          \`target_assistant_message_id\` text,
          \`target_task_id\` text,
          \`target_run_id\` text,
          \`target_session_input_id\` text,
          \`target_member_session_id\` text,
          \`state\` text DEFAULT 'active' NOT NULL,
          \`reason\` text,
          \`idempotency_key\` text NOT NULL,
          \`parent_grant_id\` text,
          \`revoked_at\` integer,
          \`expires_at\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_attachment_grant_attachment_id_session_attachment_id_fk\` FOREIGN KEY (\`attachment_id\`) REFERENCES \`session_attachment\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_attachment_status\` (
          \`grant_id\` text PRIMARY KEY,
          \`selected\` integer DEFAULT false NOT NULL,
          \`authorized\` integer DEFAULT false NOT NULL,
          \`resolved\` integer DEFAULT false NOT NULL,
          \`included_in_provider_request\` integer DEFAULT false NOT NULL,
          \`recipient_provider_id\` text,
          \`recipient_model_id\` text,
          \`recipient_account_id\` text,
          \`reason\` text,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_attachment_status_grant_id_session_attachment_grant_id_fk\` FOREIGN KEY (\`grant_id\`) REFERENCES \`session_attachment_grant\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_attachment\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`part_id\` text NOT NULL,
          \`blob_id\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`filename\` text,
          \`mime\` text NOT NULL,
          \`byte_length\` integer NOT NULL,
          \`handle\` text NOT NULL,
          \`tombstoned_at\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_attachment_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_attachment_blob_id_session_attachment_blob_id_fk\` FOREIGN KEY (\`blob_id\`) REFERENCES \`session_attachment_blob\`(\`id\`)
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_attachment_blob_hash_idx\` ON \`session_attachment_blob\` (\`content_hash\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_attachment_grant_idempotency_idx\` ON \`session_attachment_grant\` (\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_attachment_grant_attachment_idx\` ON \`session_attachment_grant\` (\`attachment_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_attachment_grant_target_child_idx\` ON \`session_attachment_grant\` (\`target_child_session_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_attachment_grant_target_run_idx\` ON \`session_attachment_grant\` (\`target_run_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_attachment_grant_parent_idx\` ON \`session_attachment_grant\` (\`parent_grant_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_attachment_status_included_idx\` ON \`session_attachment_status\` (\`included_in_provider_request\`,\`time_updated\`) WHERE "session_attachment_status"."included_in_provider_request" = 1;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_attachment_status_recipient_idx\` ON \`session_attachment_status\` (\`recipient_provider_id\`,\`recipient_model_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_attachment_handle_idx\` ON \`session_attachment\` (\`session_id\`,\`handle\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_attachment_source_part_idx\` ON \`session_attachment\` (\`session_id\`,\`message_id\`,\`part_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_attachment_session_index_idx\` ON \`session_attachment\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
