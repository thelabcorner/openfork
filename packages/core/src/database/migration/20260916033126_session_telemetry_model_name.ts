import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916033126_session_telemetry_model_name",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_telemetry\` ADD \`model_name\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
