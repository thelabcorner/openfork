import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919171844_scheduled_task_oxp_source",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`scheduled_task\` ADD \`source_ref\` text;`)
      yield* tx.run(`ALTER TABLE \`scheduled_task\` ADD \`source_principal\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
