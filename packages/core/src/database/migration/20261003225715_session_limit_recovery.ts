import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003225715_session_limit_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_limit_recovery\` (
          \`session_id\` text PRIMARY KEY,
          \`source_assistant_message_id\` text NOT NULL,
          \`source_user_message_id\` text,
          \`provider_id\` text NOT NULL,
          \`account_id\` text,
          \`model_id\` text NOT NULL,
          \`failure_class\` text NOT NULL,
          \`failure_code\` text,
          \`reset_at\` integer,
          \`reset_source\` text,
          \`reset_observed_at\` integer,
          \`expected_latest_user_seq\` integer,
          \`generation\` integer NOT NULL,
          \`auto_resume\` integer DEFAULT false NOT NULL,
          \`snooze_until\` integer,
          \`continuation_id\` text NOT NULL,
          \`claim_owner\` text,
          \`claim_expires_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_limit_recovery_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_limit_recovery_due_idx\` ON \`session_limit_recovery\` (\`auto_resume\`,\`reset_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
