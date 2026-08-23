import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823001121_device_registry",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`device\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`token_hash\` text NOT NULL UNIQUE,
          \`token_prefix\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`last_seen_at\` integer,
          \`revoked_at\` integer
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
