import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919233556_scheduled_task_goal_correlation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`scheduled_task_run\` ADD \`goal_id\` text;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`scheduled_task_run_goal_idx\` ON \`scheduled_task_run\` (\`goal_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
