import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260913233022_event_payload_chunks",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`event_payload_chunk\` (
          \`payload_id\` text NOT NULL,
          \`chunk_index\` integer NOT NULL,
          \`text\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`event_payload_chunk_pk\` PRIMARY KEY(\`payload_id\`, \`chunk_index\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`event_payload_chunk_time_created_idx\` ON \`event_payload_chunk\` (\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
