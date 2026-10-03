import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924154706_wise_alex_power",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`directory_activity_lease\` (
          \`lease_id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`acquired_at\` integer NOT NULL,
          \`released_at\` integer,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_directory_activity_lease_owner_id_runtime_owner_id_fk\` FOREIGN KEY (\`owner_id\`) REFERENCES \`runtime_owner\`(\`id\`),
          CONSTRAINT "directory_activity_lease_state_check" CHECK("state" in ('active', 'released', 'reconcile_required')),
          CONSTRAINT "directory_activity_lease_release_check" CHECK(("state" = 'released' and "released_at" is not null) or ("state" <> 'released' and "released_at" is null)),
          CONSTRAINT "directory_activity_lease_identity_check" CHECK(length("lease_id") > 0 and length("kind") > 0)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`directory_activity_lease_directory_idx\` ON \`directory_activity_lease\` (\`directory\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`directory_activity_lease_owner_idx\` ON \`directory_activity_lease\` (\`owner_id\`,\`state\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
