import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004185600_session_limit_recovery_due_index_tiebreaker",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_limit_recovery_due_idx\`;`)
      yield* tx.run(
        `CREATE INDEX \`session_limit_recovery_due_idx\` ON \`session_limit_recovery\` (\`auto_resume\`,\`reset_at\`,\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration