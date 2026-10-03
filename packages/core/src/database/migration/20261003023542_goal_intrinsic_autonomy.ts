import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003023542_goal_intrinsic_autonomy",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`goal_automation\` DROP COLUMN \`started_at\`;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` DROP COLUMN \`consecutive_turns\`;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` DROP COLUMN \`no_progress_turns\`;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` DROP COLUMN \`auditor_blocked_streak\`;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` DROP COLUMN \`consumed_tokens\`;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` DROP COLUMN \`last_auditor_decision\`;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` DROP COLUMN \`last_auditor_rationale\`;`)
      yield* tx.run(`ALTER TABLE \`goal_automation\` DROP COLUMN \`previous_revision\`;`)
      yield* tx.run(`ALTER TABLE \`goal\` DROP COLUMN \`continuation_policy\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
