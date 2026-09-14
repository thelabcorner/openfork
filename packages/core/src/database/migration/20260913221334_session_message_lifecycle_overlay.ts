import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260913221334_session_message_lifecycle_overlay",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_message_lifecycle\` (
          \`message_id\` text PRIMARY KEY,
          \`streamed_at\` integer,
          \`settlement\` text,
          CONSTRAINT \`fk_session_message_lifecycle_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
