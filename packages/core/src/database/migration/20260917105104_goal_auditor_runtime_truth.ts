import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917105104_goal_auditor_runtime_truth",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`auditor_session_id\` text;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`runtime_error\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
