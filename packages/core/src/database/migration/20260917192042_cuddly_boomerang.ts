import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917192042_cuddly_boomerang",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`audit_requested_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
