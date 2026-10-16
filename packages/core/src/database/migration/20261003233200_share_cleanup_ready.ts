import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003233200_share_cleanup_ready",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`share_cleanup\` ADD \`ready\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
