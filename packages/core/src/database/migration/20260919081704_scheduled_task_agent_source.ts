import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919081704_scheduled_task_agent_source",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`scheduled_task\` ADD \`source_message_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
