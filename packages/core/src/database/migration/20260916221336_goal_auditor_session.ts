import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916221336_goal_auditor_session",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(
        `CREATE UNIQUE INDEX \`goal_auditor_session_session_idx\` ON \`goal_auditor_session\` (\`auditor_session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`goal_auditor_session_goal_idx\` ON \`goal_auditor_session\` (\`goal_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
