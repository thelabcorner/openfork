import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003233000_share_cleanup",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`share_cleanup\` (
          \`share_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`last_error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
