import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012012854_v1-tool-call-index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_v1_tool_call_backfill\` (
          \`id\` integer PRIMARY KEY,
          \`watermark_rowid\` integer DEFAULT 0 NOT NULL,
          \`done\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_v1_tool_call\` (
          \`part_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`status\` text NOT NULL,
          CONSTRAINT \`fk_session_v1_tool_call_part_id_part_id_fk\` FOREIGN KEY (\`part_id\`) REFERENCES \`part\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_v1_tool_call_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`tool_identity_version\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`session_v1_tool_call_session_call_idx\` ON \`session_v1_tool_call\` (\`session_id\`,\`call_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_v1_tool_call_session_status_idx\` ON \`session_v1_tool_call\` (\`session_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
