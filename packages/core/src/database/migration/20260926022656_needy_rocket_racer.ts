import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926022656_needy_rocket_racer",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`provider_route_binding\` (
          \`session_id\` text NOT NULL,
          \`affinity_domain\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`route_kind\` text NOT NULL,
          \`account_id\` text,
          \`credential_handle\` text,
          \`mode\` text,
          \`pin\` text,
          \`route_revision\` integer DEFAULT 1 NOT NULL,
          \`assigned_at\` integer NOT NULL,
          \`assignment_epoch\` integer NOT NULL,
          \`reason\` text NOT NULL,
          CONSTRAINT \`provider_route_binding_pk\` PRIMARY KEY(\`session_id\`, \`affinity_domain\`),
          CONSTRAINT \`fk_provider_route_binding_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "provider_route_binding_affinity_domain_check" CHECK(length("affinity_domain") > 0),
          CONSTRAINT "provider_route_binding_provider_id_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_route_binding_route_kind_check" CHECK("route_kind" in ('public', 'account')),
          CONSTRAINT "provider_route_binding_mode_check" CHECK("mode" is null or "mode" in ('concentrate', 'session-round-robin')),
          CONSTRAINT "provider_route_binding_pin_check" CHECK("pin" is null or "pin" in ('hard', 'soft')),
          CONSTRAINT "provider_route_binding_reason_check" CHECK("reason" in ('explicit', 'initial', 'failover', 'model-selection')),
          CONSTRAINT "provider_route_binding_revision_check" CHECK("route_revision" > 0),
          CONSTRAINT "provider_route_binding_assignment_epoch_check" CHECK("assignment_epoch" > 0),
          CONSTRAINT "provider_route_binding_assigned_at_check" CHECK("assigned_at" >= 0),
          CONSTRAINT "provider_route_binding_identity_check" CHECK((
                "route_kind" = 'public'
                and "account_id" is null
                and "credential_handle" is null
                and "mode" is null
                and "pin" is null
              ) or (
                "route_kind" = 'account'
                and "account_id" is not null
                and length("account_id") > 0
                and "credential_handle" is not null
                and length("credential_handle") > 0
              ))
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`provider_route_binding_provider_kind_idx\` ON \`provider_route_binding\` (\`provider_id\`,\`route_kind\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`provider_route_binding_account_idx\` ON \`provider_route_binding\` (\`provider_id\`,\`account_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`provider_route_binding_credential_idx\` ON \`provider_route_binding\` (\`provider_id\`,\`credential_handle\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
