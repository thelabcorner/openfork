import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917060928_silky_cardiac",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_run_started_idx\` ON \`scheduled_task_run\` (\`started_at\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
