import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919204232_swarm_runtime_deadlines",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_process_due_idx\` ON \`swarm_task_lease\` (\`lease_owner_process\`,\`expires_at\`,\`task_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_lease_hold_due_idx\` ON \`swarm_task_lease\` (\`hold_deadline\`,\`task_id\`) WHERE "swarm_task_lease"."state" = 'human_hold' AND "swarm_task_lease"."hold_deadline" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`swarm_task_reservation_due_idx\` ON \`swarm_task\` (\`reserved_until\`,\`id\`) WHERE "swarm_task"."status" = 'ready' AND "swarm_task"."reserved_until" IS NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
