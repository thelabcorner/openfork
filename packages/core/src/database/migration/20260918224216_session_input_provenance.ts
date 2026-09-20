import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918224216_session_input_provenance",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`provenance\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
