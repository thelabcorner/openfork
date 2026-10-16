import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004054123_session_limit_recovery_claim_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_limit_recovery_claim_idx\` ON \`session_limit_recovery\` (\`auto_resume\`,\`claim_expires_at\`,\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
