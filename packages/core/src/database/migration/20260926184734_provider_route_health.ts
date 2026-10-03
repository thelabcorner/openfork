import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926184734_provider_route_health",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`provider_account_route_health\` (
          \`provider_id\` text NOT NULL,
          \`account_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`credential_revision\` integer,
          \`expires_at\` integer,
          \`observed_at\` integer NOT NULL,
          CONSTRAINT \`provider_account_route_health_pk\` PRIMARY KEY(\`provider_id\`, \`account_id\`, \`model_id\`),
          CONSTRAINT "provider_account_route_health_provider_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_account_route_health_account_check" CHECK(length("account_id") > 0),
          CONSTRAINT "provider_account_route_health_model_check" CHECK(length("model_id") > 0),
          CONSTRAINT "provider_account_route_health_state_check" CHECK("state" in ('auth-invalid', 'cooling-down', 'quota-exhausted')),
          CONSTRAINT "provider_account_route_health_observed_check" CHECK("observed_at" >= 0 and "observed_at" <= 9007199254740991),
          CONSTRAINT "provider_account_route_health_shape_check" CHECK((
                "state" = 'auth-invalid'
                and "credential_revision" is not null
                and "credential_revision" > 0
                and "credential_revision" <= 9007199254740991
                and "expires_at" is null
              ) or (
                "state" in ('cooling-down', 'quota-exhausted')
                and "credential_revision" is null
                and "expires_at" is not null
                and "expires_at" > "observed_at"
                and "expires_at" <= 9007199254740991
              ))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`provider_public_route_health\` (
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`observed_at\` integer NOT NULL,
          CONSTRAINT \`provider_public_route_health_pk\` PRIMARY KEY(\`provider_id\`, \`model_id\`),
          CONSTRAINT "provider_public_route_health_provider_check" CHECK(length("provider_id") > 0),
          CONSTRAINT "provider_public_route_health_model_check" CHECK(length("model_id") > 0),
          CONSTRAINT "provider_public_route_health_state_check" CHECK("state" in ('cooling-down', 'quota-exhausted')),
          CONSTRAINT "provider_public_route_health_time_check" CHECK("observed_at" >= 0
                and "observed_at" <= 9007199254740991
                and "expires_at" > "observed_at"
                and "expires_at" <= 9007199254740991)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`provider_account_route_health_expiry_idx\` ON \`provider_account_route_health\` (\`expires_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`provider_public_route_health_expiry_idx\` ON \`provider_public_route_health\` (\`expires_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
