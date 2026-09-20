import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260919052438_runtime_session_ownership",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`runtime_owner\` (
          \`id\` text PRIMARY KEY,
          \`pid\` integer NOT NULL,
          \`started_at\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`control_epoch\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_execution_owner\` (
          \`session_id\` text PRIMARY KEY,
          \`generation\` integer NOT NULL,
          \`owner_id\` text,
          \`acquired_at\` integer,
          \`interrupt_generation\` integer,
          \`interrupt_reason\` text,
          \`interrupt_requested_at\` integer,
          \`recovery_owner_id\` text,
          \`recovery_started_at\` integer,
          CONSTRAINT \`fk_session_execution_owner_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_execution_owner_owner_id_runtime_owner_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`runtime_owner\`(\`id\`),
          CONSTRAINT \`fk_session_execution_owner_recovery_owner_id_runtime_owner_id_fk\` FOREIGN KEY (\`recovery_owner_id\`) REFERENCES \`runtime_owner\`(\`id\`)
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_execution_owner_owner_idx\` ON \`session_execution_owner\` (\`owner_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_execution_owner_recovery_owner_idx\` ON \`session_execution_owner\` (\`recovery_owner_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
