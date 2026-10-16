import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012022358_session-v1-shadow",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_v1_shadow_cursor\` (
          \`session_id\` text PRIMARY KEY,
          \`source_event_seq\` integer NOT NULL,
          \`watermark_rowid\` integer DEFAULT 0 NOT NULL,
          \`complete\` integer DEFAULT false NOT NULL,
          CONSTRAINT \`fk_session_v1_shadow_cursor_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_v1_shadow\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`source_event_seq\` integer NOT NULL,
          \`source_hash\` text NOT NULL,
          \`source_snapshot_hash\` text NOT NULL,
          \`wire_hash\` text NOT NULL,
          \`wire\` text NOT NULL,
          \`time_written\` integer NOT NULL,
          CONSTRAINT \`fk_session_v1_shadow_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_v1_shadow_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_v1_shadow_session_message_idx\` ON \`session_v1_shadow\` (\`session_id\`,\`message_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
