import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916025456_session_telemetry",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_telemetry\` (
          \`session_id\` text PRIMARY KEY,
          \`assistant_message_id\` text,
          \`provider_id\` text,
          \`model_id\` text,
          \`variant\` text,
          \`context_limit\` integer,
          \`request_sent_at\` integer,
          \`first_token_at\` integer,
          \`streamed_at\` integer,
          \`completed_at\` integer,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`generated_ms\` integer DEFAULT 0 NOT NULL,
          \`tool_ms\` integer DEFAULT 0 NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_telemetry_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
