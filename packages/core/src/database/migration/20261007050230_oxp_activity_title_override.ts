import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007050230_oxp_activity_title_override",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`oxp_parent_activity\` ADD \`title_user_set\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
