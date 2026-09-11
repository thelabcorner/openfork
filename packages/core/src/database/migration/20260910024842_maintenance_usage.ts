import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260910024842_maintenance_usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`maintenance_usage\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`agent\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`session_id\` text,
          \`project_id\` text,
          \`requests\` integer DEFAULT 1 NOT NULL,
          \`cost_usd\` real,
          \`cost_estimated\` integer DEFAULT false NOT NULL,
          \`input_tokens\` integer DEFAULT 0 NOT NULL,
          \`cache_read_tokens\` integer DEFAULT 0 NOT NULL,
          \`cache_write_tokens\` integer DEFAULT 0 NOT NULL,
          \`output_tokens\` integer DEFAULT 0 NOT NULL,
          \`reasoning_tokens\` integer DEFAULT 0 NOT NULL,
          \`total_tokens\` integer DEFAULT 0 NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`maintenance_usage_completed_idx\` ON \`maintenance_usage\` (\`time_completed\`);`)
      yield* tx.run(
        `CREATE INDEX \`maintenance_usage_project_completed_idx\` ON \`maintenance_usage\` (\`project_id\`,\`time_completed\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`maintenance_usage_agent_completed_idx\` ON \`maintenance_usage\` (\`agent\`,\`time_completed\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
