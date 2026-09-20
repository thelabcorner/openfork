import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919213551_swarm_recovery_owner_scan",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_state_owner_idx\` ON \`swarm_task_lease\` (\`state\`,\`lease_owner_process\`,\`task_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
