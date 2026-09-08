import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907230547_goal_auditor",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`auditor_blocked_streak\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`last_auditor_decision\` text;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` ADD \`last_auditor_rationale\` text;`)
      yield* tx.run(`ALTER TABLE \`goal\` ADD \`auditor_policy\` text DEFAULT '{}' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
