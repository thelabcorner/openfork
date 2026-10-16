import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003223630_saved_code_admission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`saved_code_admission\` (
          \`scope_kind\` text NOT NULL,
          \`scope_key\` text NOT NULL,
          \`saved_id\` text NOT NULL,
          \`revision\` text NOT NULL,
          \`source_hash\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`origin_run_id\` text,
          \`time_admitted\` integer NOT NULL,
          CONSTRAINT \`saved_code_admission_pk\` PRIMARY KEY(\`scope_kind\`, \`scope_key\`, \`saved_id\`, \`revision\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`saved_code_admission_saved_idx\` ON \`saved_code_admission\` (\`scope_kind\`,\`scope_key\`,\`saved_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
