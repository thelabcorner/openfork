import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919205014_swarm_retirement_scan",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_state_retire_idx\` ON \`swarm_task_lease\` (\`state\`,\`retire_requested_at\`,\`task_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
