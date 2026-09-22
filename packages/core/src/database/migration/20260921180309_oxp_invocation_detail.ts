import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260921180309_oxp_invocation_detail",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`oxp_invocation_detail\` (
          \`invocation_id\` text PRIMARY KEY,
          \`request\` text,
          \`outcome\` text,
          CONSTRAINT \`fk_oxp_invocation_detail_invocation_id_oxp_invocation_id_fk\` FOREIGN KEY (\`invocation_id\`) REFERENCES \`oxp_invocation\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
