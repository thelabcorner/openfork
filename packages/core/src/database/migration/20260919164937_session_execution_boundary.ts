import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919164937_session_execution_boundary",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_execution_boundary\` (
          \`session_id\` text PRIMARY KEY,
          \`boundary\` text NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_execution_boundary_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
