import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010070619_context-ledger-opaque-probe",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`message_session_opaque_probe_idx\` ON \`message\` (\`session_id\`) WHERE json_type("message"."data", '$."$cdbRef"') IS NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
