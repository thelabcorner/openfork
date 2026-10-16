import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015201329_scheduled_task_pending_queue_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_run_status_started_idx\` ON \`scheduled_task_run\` (\`status\`,\`started_at\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
