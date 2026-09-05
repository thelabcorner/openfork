import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260904000000_add_session_group_membership",
  up(tx) {
    return Effect.gen(function* () {
      const groupColumns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session_group\`)`)
      if (!groupColumns.some((column) => column.name === "kind")) {
        yield* tx.run(`ALTER TABLE \`session_group\` ADD \`kind\` text NOT NULL DEFAULT 'user';`)
      }
      if (!groupColumns.some((column) => column.name === "owner_plugin")) {
        yield* tx.run(`ALTER TABLE \`session_group\` ADD \`owner_plugin\` text;`)
      }
      if (!groupColumns.some((column) => column.name === "anchor_session_id")) {
        yield* tx.run(`ALTER TABLE \`session_group\` ADD \`anchor_session_id\` text;`)
      }
      if (!groupColumns.some((column) => column.name === "policy")) {
        yield* tx.run(`ALTER TABLE \`session_group\` ADD \`policy\` text;`)
      }
      if (!groupColumns.some((column) => column.name === "time_archived")) {
        yield* tx.run(`ALTER TABLE \`session_group\` ADD \`time_archived\` integer;`)
      }

      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_group_member\` (
          \`group_id\` text NOT NULL REFERENCES \`session_group\`(\`id\`) ON DELETE CASCADE,
          \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`locked\` integer NOT NULL DEFAULT 0,
          \`origin\` text NOT NULL DEFAULT 'user',
          \`origin_plugin\` text,
          \`origin_ref\` text,
          \`position\` integer NOT NULL DEFAULT 0,
          \`time_added\` integer NOT NULL,
          PRIMARY KEY (\`group_id\`, \`session_id\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_group_member_session_idx\` ON \`session_group_member\` (\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_group_member_position_idx\` ON \`session_group_member\` (\`group_id\`, \`position\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`session_group_anchor_idx\` ON \`session_group\` (\`kind\`, \`anchor_session_id\`) WHERE \`anchor_session_id\` IS NOT NULL;`,
      )
      yield* tx.run(`
        INSERT OR IGNORE INTO \`session_group_member\`
          (\`group_id\`, \`session_id\`, \`locked\`, \`origin\`, \`position\`, \`time_added\`)
        SELECT \`group_id\`, \`id\`, 0, 'user', 0,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        FROM \`session\`
        WHERE \`group_id\` IS NOT NULL;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
