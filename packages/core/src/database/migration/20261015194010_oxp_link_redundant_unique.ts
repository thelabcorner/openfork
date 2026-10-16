import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015194010_oxp_link_redundant_unique",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`oxp_invocation_link_invocation_ref_idx\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
