import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260921192825_usage_yield_statistics",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`usage_yield_meta\` (
          \`id\` text PRIMARY KEY,
          \`version\` integer NOT NULL,
          \`rebuilt_at\` integer NOT NULL,
          \`source_rows\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_yield_stat\` (
          \`stat_key\` text PRIMARY KEY,
          \`provider_id\` text NOT NULL,
          \`base_model_id\` text NOT NULL,
          \`account_id\` text,
          \`state\` text NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`usage_yield_stat_model_idx\` ON \`usage_yield_stat\` (\`provider_id\`,\`base_model_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_yield_stat_account_idx\` ON \`usage_yield_stat\` (\`provider_id\`,\`base_model_id\`,\`account_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
