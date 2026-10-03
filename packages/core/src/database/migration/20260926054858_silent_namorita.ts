import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926054858_silent_namorita",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`maintenance_usage\` ADD \`route_kind\` text;`)
      yield* tx.run(`ALTER TABLE \`maintenance_usage\` ADD \`account_id\` text;`)
      yield* tx.run(`ALTER TABLE \`usage_record\` ADD \`route_kind\` text;`)
      yield* tx.run(
        `CREATE INDEX \`maintenance_usage_account_completed_idx\` ON \`maintenance_usage\` (\`provider_id\`,\`account_id\`,\`time_completed\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
