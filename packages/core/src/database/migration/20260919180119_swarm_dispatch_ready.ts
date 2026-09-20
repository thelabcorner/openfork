import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919180119_swarm_dispatch_ready",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`swarm_task_dispatch_ready_idx\` ON \`swarm_task\` ("priority" DESC,\`ready_at\`,\`time_created\`,\`id\`,\`swarm_id\`) WHERE "swarm_task"."status" = 'ready';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
