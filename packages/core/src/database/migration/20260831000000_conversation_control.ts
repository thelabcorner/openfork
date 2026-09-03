import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260831000000_conversation_control",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_context_state\` (
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`excluded\` integer DEFAULT 0 NOT NULL,
          \`pinned\` integer DEFAULT 0 NOT NULL,
          \`override_data\` text,
          \`override_search_text\` text,
          \`modified_seq\` integer,
          \`modified_at\` integer NOT NULL,
          PRIMARY KEY(\`session_id\`, \`message_id\`),
          CONSTRAINT \`fk_session_context_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_context_state_session_idx\` ON \`session_context_state\` (\`session_id\`);`)

      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_context_ops\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL,
          \`batch_id\` text NOT NULL,
          \`operations\` text NOT NULL,
          \`timestamp\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_ops_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_context_ops_session_idx\` ON \`session_context_ops\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_context_ops_session_time_idx\` ON \`session_context_ops\` (\`session_id\`,\`timestamp\`);`)

      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_fork_origin\` (
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
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_fork_origin_parent_idx\` ON \`session_fork_origin\` (\`parent_session_id\`);`)
    })
  },
  reconcile(tx) {
    return Effect.gen(function* () {
      // Idempotent creation for fresh databases that were built from schema.gen before this migration existed.
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_context_state\` (
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`excluded\` integer DEFAULT 0 NOT NULL,
          \`pinned\` integer DEFAULT 0 NOT NULL,
          \`override_data\` text,
          \`override_search_text\` text,
          \`modified_seq\` integer,
          \`modified_at\` integer NOT NULL,
          PRIMARY KEY(\`session_id\`, \`message_id\`),
          CONSTRAINT \`fk_session_context_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_context_state_session_idx\` ON \`session_context_state\` (\`session_id\`);`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_context_ops\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL,
          \`batch_id\` text NOT NULL,
          \`operations\` text NOT NULL,
          \`timestamp\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_ops_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_context_ops_session_idx\` ON \`session_context_ops\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_context_ops_session_time_idx\` ON \`session_context_ops\` (\`session_id\`,\`timestamp\`);`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_fork_origin\` (
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
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_fork_origin_parent_idx\` ON \`session_fork_origin\` (\`parent_session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
