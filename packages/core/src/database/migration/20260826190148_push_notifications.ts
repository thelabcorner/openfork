import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260826190148_push_notifications",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`push_subscription\` (
          \`id\` text PRIMARY KEY,
          \`endpoint\` text NOT NULL UNIQUE,
          \`p256dh\` text NOT NULL,
          \`auth\` text NOT NULL,
          \`expiration_time\` integer,
          \`user_agent_hint\` text,
          \`created_at\` integer NOT NULL,
          \`last_seen_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`push_vapid_key\` (
          \`id\` text PRIMARY KEY,
          \`public_key\` text NOT NULL,
          \`private_key\` text NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_session_group\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_session_group\`(\`id\`, \`name\`, \`position\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`name\`, \`position\`, \`time_created\`, \`time_updated\` FROM \`session_group\`;`,
      )
      yield* tx.run(`DROP TABLE \`session_group\`;`)
      yield* tx.run(`ALTER TABLE \`__new_session_group\` RENAME TO \`session_group\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_checkpoint_session_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_checkpoint_session_user_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_checkpoint_session_assistant_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_group_position_idx\`;`)
      yield* tx.run(`CREATE INDEX \`session_checkpoint_session_id_idx\` ON \`session_checkpoint\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_checkpoint_session_user_message_idx\` ON \`session_checkpoint\` (\`session_id\`,\`user_message_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
