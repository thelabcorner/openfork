import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908065422_goal_auditor_continuation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`continuation_prompt\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
