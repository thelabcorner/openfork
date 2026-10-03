import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924042906_directory_maintenance_guard",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`directory_maintenance_guard\` (
          \`directory\` text PRIMARY KEY,
          \`guard_id\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`acquisition_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`acquired_at\` integer NOT NULL,
          \`released_at\` integer,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_directory_maintenance_guard_owner_id_runtime_owner_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`runtime_owner\`(\`id\`),
          CONSTRAINT "directory_maintenance_guard_state_check" CHECK("state" in ('active', 'released', 'reconcile_required')),
          CONSTRAINT "directory_maintenance_guard_release_check" CHECK(("state" = 'released' and "released_at" is not null) or ("state" <> 'released' and "released_at" is null)),
          CONSTRAINT "directory_maintenance_guard_acquisition_check" CHECK(length("acquisition_id") > 0)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`directory_maintenance_guard_guard_idx\` ON \`directory_maintenance_guard\` (\`guard_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`directory_maintenance_guard_owner_idx\` ON \`directory_maintenance_guard\` (\`owner_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`directory_maintenance_guard_acquisition_idx\` ON \`directory_maintenance_guard\` (\`acquisition_id\`,\`state\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
