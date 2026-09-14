import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260913235645_event_payload_meta",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`event_payload_meta\` (
          \`payload_id\` text PRIMARY KEY,
          \`chunk_count\` integer NOT NULL,
          \`refs\` integer DEFAULT 0 NOT NULL,
          \`time_touched\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`event_payload_meta_orphan_idx\` ON \`event_payload_meta\` (\`refs\`,\`time_touched\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
