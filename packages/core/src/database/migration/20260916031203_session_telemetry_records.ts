import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916031203_session_telemetry_records",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_telemetry\` ADD \`cost_usd\` real;`)
    })
  },
} satisfies DatabaseMigration.Migration
