import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011125809_native_tool_settlement",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`native_tool_settlement\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`tool\` text NOT NULL,
          \`status\` text NOT NULL,
          \`started_at\` integer NOT NULL,
          \`completed_at\` integer NOT NULL,
          \`duration_ms\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`native_tool_settlement_started_idx\` ON \`native_tool_settlement\` (\`started_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`native_tool_settlement_provider_model_started_idx\` ON \`native_tool_settlement\` (\`provider_id\`,\`model_id\`,\`started_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
