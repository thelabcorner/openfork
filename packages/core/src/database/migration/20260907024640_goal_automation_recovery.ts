import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907024640_goal_automation_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`goal_automation\` (
          \`session_id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`started_at\` integer NOT NULL,
          \`consecutive_turns\` integer DEFAULT 0 NOT NULL,
          \`no_progress_turns\` integer DEFAULT 0 NOT NULL,
          \`consumed_tokens\` integer DEFAULT 0 NOT NULL,
          \`previous_revision\` integer,
          \`reservation_id\` text,
          \`reservation_owner\` text,
          \`reservation_created_at\` integer,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_goal_automation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_goal_automation_goal_id_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`goal_automation_goal_idx\` ON \`goal_automation\` (\`goal_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`goal_automation_reservation_idx\` ON \`goal_automation\` (\`reservation_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
