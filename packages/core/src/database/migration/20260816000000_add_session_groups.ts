import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816000000_add_session_groups",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_group\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`position\` integer NOT NULL DEFAULT 0,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_group_position_idx\` ON \`session_group\` (\`position\`);`)
      const columns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)
      if (columns.some((column) => column.name === "group_id")) return
      yield* tx.run(`ALTER TABLE \`session\` ADD \`group_id\` text;`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_group_idx\` ON \`session\` (\`group_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
