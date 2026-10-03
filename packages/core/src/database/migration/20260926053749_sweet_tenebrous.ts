import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926053749_sweet_tenebrous",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`provider_route_account_stats\` (
          \`provider_id\` text NOT NULL,
          \`affinity_domain\` text NOT NULL,
          \`account_id\` text NOT NULL,
          \`assignment_count\` integer DEFAULT 0 NOT NULL,
          \`last_assigned_at\` integer,
          CONSTRAINT \`provider_route_account_stats_pk\` PRIMARY KEY(\`provider_id\`, \`affinity_domain\`, \`account_id\`),
          CONSTRAINT "provider_route_account_stats_provider_id_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_route_account_stats_affinity_domain_check" CHECK(length("affinity_domain") > 0),
          CONSTRAINT "provider_route_account_stats_account_id_check" CHECK(length("account_id") > 0),
          CONSTRAINT "provider_route_account_stats_count_check" CHECK("assignment_count" >= 0 and "assignment_count" <= 9007199254740991),
          CONSTRAINT "provider_route_account_stats_last_assigned_at_check" CHECK("last_assigned_at" is null or ("last_assigned_at" >= 0 and "last_assigned_at" <= 9007199254740991))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`provider_route_policy_cursor\` (
          \`provider_id\` text NOT NULL,
          \`affinity_domain\` text NOT NULL,
          \`epoch\` integer DEFAULT 0 NOT NULL,
          \`last_assigned_handle\` text,
          CONSTRAINT \`provider_route_policy_cursor_pk\` PRIMARY KEY(\`provider_id\`, \`affinity_domain\`),
          CONSTRAINT "provider_route_policy_cursor_provider_id_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_route_policy_cursor_affinity_domain_check" CHECK(length("affinity_domain") > 0),
          CONSTRAINT "provider_route_policy_cursor_epoch_check" CHECK("epoch" >= 0 and "epoch" <= 9007199254740991),
          CONSTRAINT "provider_route_policy_cursor_last_handle_check" CHECK("last_assigned_handle" is null or length("last_assigned_handle") > 0)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
