import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const ddl = (tx: Parameters<NonNullable<DatabaseMigration.Migration["up"]>>[0]) =>
  Effect.gen(function* () {
    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS "revision_draft" (
        "id" text PRIMARY KEY,
        "directory" text NOT NULL,
        "target_kind" text NOT NULL,
        "target_key" text NOT NULL,
        "purpose" text NOT NULL,
        "source_fingerprint" text NOT NULL,
        "prompt" text NOT NULL,
        "references" text DEFAULT '[]' NOT NULL,
        "time_created" integer NOT NULL
      );
    `)
    yield* tx.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS "revision_draft_target_idx" ON "revision_draft" ("target_kind", "target_key");',
    )
    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS "revision_draft_claim" (
        "target_kind" text NOT NULL,
        "target_key" text NOT NULL,
        "claim_id" text NOT NULL,
        "source_fingerprint" text NOT NULL,
        "time_claimed" integer NOT NULL,
        PRIMARY KEY ("target_kind", "target_key")
      );
    `)
  })

export default {
  id: "20260920002000_revision_draft",
  up: ddl,
  reconcile: ddl,
} satisfies DatabaseMigration.Migration
