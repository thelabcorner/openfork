import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003010314_oxp_context_attribution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`oxp_invocation\` ADD \`context_request_chars\` integer;`)
      yield* tx.run(`ALTER TABLE \`oxp_invocation\` ADD \`context_request_source\` text;`)
      yield* tx.run(`ALTER TABLE \`oxp_invocation\` ADD \`context_request_schema\` text;`)
      yield* tx.run(`ALTER TABLE \`oxp_invocation\` ADD \`context_result_chars\` integer;`)
      yield* tx.run(`ALTER TABLE \`oxp_invocation\` ADD \`context_result_source\` text;`)
      yield* tx.run(`ALTER TABLE \`oxp_invocation\` ADD \`context_result_schema\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
