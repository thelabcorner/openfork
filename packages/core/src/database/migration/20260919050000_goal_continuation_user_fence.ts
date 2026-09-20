import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Freeze the semantic-User SessionInput sequence that authorized each Goal
 * continuation. Materialization must compare against this persisted cursor;
 * reading the latest User sequence at admission time would let the fence move
 * forward and admit stale autonomous work after a human has taken control.
 */
export default {
  id: "20260919050000_goal_continuation_user_fence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `ALTER TABLE \`goal_automation\` ADD \`continuation_expected_user_seq\` integer;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
