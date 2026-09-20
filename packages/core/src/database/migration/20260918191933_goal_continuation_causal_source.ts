import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918191933_goal_continuation_causal_source",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`continuation_source_message_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
