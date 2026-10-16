import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261005022342_session_tool_output",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tool_output\` (
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`chunk_index\` integer NOT NULL,
          \`start_offset\` integer DEFAULT 0 NOT NULL,
          \`text\` text,
          \`total_chars\` integer,
          \`total_lines\` integer,
          \`complete\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_tool_output_pk\` PRIMARY KEY(\`session_id\`, \`message_id\`, \`tool_call_id\`, \`chunk_index\`),
          CONSTRAINT \`fk_session_tool_output_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_tool_output_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_tool_output_page_idx\` ON \`session_tool_output\` (\`session_id\`,\`message_id\`,\`tool_call_id\`,\`start_offset\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
