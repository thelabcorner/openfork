import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261005054655_careful_tarot",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_limit_recovery_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`generation\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_session_limit_recovery_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
