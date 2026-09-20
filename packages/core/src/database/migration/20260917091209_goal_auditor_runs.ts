import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917091209_goal_auditor_runs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`goal\` ADD \`auditor_runs\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
