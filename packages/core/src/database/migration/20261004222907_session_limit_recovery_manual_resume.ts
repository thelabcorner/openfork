import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004222907_session_limit_recovery_manual_resume",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_limit_recovery\` ADD \`manual_resume\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`session_limit_recovery_manual_idx\` ON \`session_limit_recovery\` (\`manual_resume\`,\`claim_expires_at\`,\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
