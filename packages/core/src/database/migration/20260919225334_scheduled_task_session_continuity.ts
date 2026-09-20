import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919225334_scheduled_task_session_continuity",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`ALTER TABLE \`scheduled_task\` ADD \`session_policy\` text DEFAULT '{"kind":"new"}' NOT NULL;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_task_session_binding_session_idx\` ON \`scheduled_task_session_binding\` (\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
