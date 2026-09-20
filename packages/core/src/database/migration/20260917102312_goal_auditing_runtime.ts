import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917102312_goal_auditing_runtime",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`auditing_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
