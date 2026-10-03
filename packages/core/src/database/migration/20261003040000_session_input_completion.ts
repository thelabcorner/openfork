import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * One exact durable cycle-completion fact per SessionInput row.
 *
 * The column is nullable and has no default: historical rows predate the fact
 * and must stay honestly "never proven complete" rather than inheriting a
 * fabricated marker. It carries the Session aggregate sequence of the
 * InputCompleted event that projected it, so completion composes with the
 * durable event order instead of introducing a second, incomparable clock.
 */
export default {
  id: "20261003040000_session_input_completion",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`completed_seq\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
