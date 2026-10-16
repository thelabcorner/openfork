import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010070439_context-ledger-summary-probe",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`message_session_summary_probe_idx\` ON \`message\` (\`session_id\`) WHERE json_extract("message"."data", '$.summary') = 1;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
