import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010071242_context-ledger-opaque-part-probe",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`part_session_opaque_context_probe_idx\` ON \`part\` (\`session_id\`) WHERE json_type("part"."data", '$."$cdbRef"') IS NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
