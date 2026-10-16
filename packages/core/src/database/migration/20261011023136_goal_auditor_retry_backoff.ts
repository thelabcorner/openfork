import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011023136_goal_auditor_retry_backoff",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`audit_retry_count\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
