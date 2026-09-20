import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const ddl = (tx: Parameters<NonNullable<DatabaseMigration.Migration["up"]>>[0]) =>
  Effect.gen(function* () {
    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS "oxp_parent_activity" (
        "id" text PRIMARY KEY,
        "title" text,
        "first_seen_at" integer NOT NULL,
        "last_seen_at" integer NOT NULL,
        "call_count" integer DEFAULT 0 NOT NULL,
        "failure_count" integer DEFAULT 0 NOT NULL,
        "augmentation_calls" integer DEFAULT 0 NOT NULL,
        "supervision_calls" integer DEFAULT 0 NOT NULL,
        "delegation_calls" integer DEFAULT 0 NOT NULL,
        "observed_epoch_count" integer DEFAULT 0 NOT NULL,
        "last_tool" text,
        "last_root_alias" text,
        "time_archived" integer
      );
    `)
    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS "oxp_correlation_ref" (
        "scheme" text NOT NULL,
        "digest" text NOT NULL,
        "activity_id" text NOT NULL,
        "scope" text NOT NULL,
        "first_seen_at" integer NOT NULL,
        "last_seen_at" integer NOT NULL,
        CONSTRAINT "oxp_correlation_ref_pk" PRIMARY KEY("scheme", "digest"),
        CONSTRAINT "fk_oxp_correlation_ref_activity" FOREIGN KEY ("activity_id") REFERENCES "oxp_parent_activity"("id") ON DELETE CASCADE
      );
    `)
    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS "oxp_invocation" (
        "id" text PRIMARY KEY,
        "activity_id" text NOT NULL,
        "host_run_id" text NOT NULL,
        "observed_epoch" integer,
        "plane" text NOT NULL,
        "tool" text NOT NULL,
        "action" text,
        "root_id" text,
        "root_alias" text,
        "status" text DEFAULT 'running' NOT NULL,
        "error_code" text,
        "mutation_attempted" integer DEFAULT 0 NOT NULL,
        "mutation_committed" integer DEFAULT 0 NOT NULL,
        "safe_summary" text,
        "time_started" integer NOT NULL,
        "time_completed" integer,
        CONSTRAINT "fk_oxp_invocation_activity" FOREIGN KEY ("activity_id") REFERENCES "oxp_parent_activity"("id") ON DELETE CASCADE
      );
    `)
    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS "oxp_invocation_link" (
        "invocation_id" text NOT NULL,
        "kind" text NOT NULL,
        "ref" text NOT NULL,
        "label" text,
        "relation" text NOT NULL,
        CONSTRAINT "oxp_invocation_link_pk" PRIMARY KEY("invocation_id", "kind", "ref", "relation"),
        CONSTRAINT "fk_oxp_invocation_link_invocation" FOREIGN KEY ("invocation_id") REFERENCES "oxp_invocation"("id") ON DELETE CASCADE
      );
    `)
    yield* tx.run(
      "CREATE INDEX IF NOT EXISTS `oxp_parent_activity_last_seen_idx` ON `oxp_parent_activity` (`time_archived`, `last_seen_at`, `id`);",
    )
    yield* tx.run(
      "CREATE INDEX IF NOT EXISTS `oxp_correlation_ref_activity_idx` ON `oxp_correlation_ref` (`activity_id`);",
    )
    yield* tx.run(
      "CREATE INDEX IF NOT EXISTS `oxp_invocation_activity_started_idx` ON `oxp_invocation` (`activity_id`, `time_started`, `id`);",
    )
    yield* tx.run(
      "CREATE INDEX IF NOT EXISTS `oxp_invocation_activity_status_started_idx` ON `oxp_invocation` (`activity_id`, `status`, `time_started`);",
    )
    yield* tx.run(
      "CREATE INDEX IF NOT EXISTS `oxp_invocation_activity_host_epoch_idx` ON `oxp_invocation` (`activity_id`, `host_run_id`, `observed_epoch`);",
    )
    yield* tx.run(
      "CREATE INDEX IF NOT EXISTS `oxp_invocation_status_host_idx` ON `oxp_invocation` (`status`, `host_run_id`);",
    )
    yield* tx.run(
      "CREATE INDEX IF NOT EXISTS `oxp_invocation_started_idx` ON `oxp_invocation` (`time_started`);",
    )
    yield* tx.run(
      "CREATE INDEX IF NOT EXISTS `oxp_invocation_link_ref_idx` ON `oxp_invocation_link` (`kind`, `ref`);",
    )
    yield* tx.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS `oxp_invocation_link_invocation_ref_idx` ON `oxp_invocation_link` (`invocation_id`, `kind`, `ref`, `relation`);",
    )
  })

export default {
  id: "20260919235500_oxp_parent_activity",
  up: ddl,
  reconcile: ddl,
} satisfies DatabaseMigration.Migration
