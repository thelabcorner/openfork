import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260820000000_session_checkpoint",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_checkpoint\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`ordinal\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`status\` text NOT NULL,
          \`before_snapshot\` text,
          \`after_snapshot\` text,
          \`user_message_id\` text,
          \`assistant_message_id\` text,
          \`diff\` text,
          \`additions\` integer NOT NULL DEFAULT 0,
          \`deletions\` integer NOT NULL DEFAULT 0,
          \`files\` integer NOT NULL DEFAULT 0,
          \`excluded\` text,
          \`error\` text,
          \`epoch\` text NOT NULL,
          \`epoch_mismatch\` integer NOT NULL DEFAULT 0,
          \`created_at\` integer NOT NULL,
          \`finalized_at\` integer
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`session_checkpoint_session_ordinal_idx\` ON \`session_checkpoint\` (\`session_id\`, \`ordinal\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_checkpoint_session_idx\` ON \`session_checkpoint\` (\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_checkpoint_session_user_idx\` ON \`session_checkpoint\` (\`session_id\`, \`user_message_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_checkpoint_session_assistant_idx\` ON \`session_checkpoint\` (\`session_id\`, \`assistant_message_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
