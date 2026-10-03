import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926012022_credential_refresh_revision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`credential\` ADD \`revision\` integer DEFAULT 1 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
