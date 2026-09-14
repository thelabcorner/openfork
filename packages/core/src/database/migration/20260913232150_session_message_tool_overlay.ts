import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260913232150_session_message_tool_overlay",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_message_tool_overlay\` (
          \`message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`progress_event_id\` text,
          \`settlement_event_id\` text,
          CONSTRAINT \`session_message_tool_overlay_pk\` PRIMARY KEY(\`message_id\`, \`call_id\`),
          CONSTRAINT \`fk_session_message_tool_overlay_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_message_tool_overlay_message_idx\` ON \`session_message_tool_overlay\` (\`message_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
