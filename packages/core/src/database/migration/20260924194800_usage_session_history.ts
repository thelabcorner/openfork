import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924194800_usage_session_history",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE "usage_session" (
          "session_id" text PRIMARY KEY,
          "project_id" text NOT NULL,
          "directory" text NOT NULL,
          "title" text NOT NULL,
          "project_name" text,
          "session_created_at" integer NOT NULL,
          "session_updated_at" integer NOT NULL,
          "last_usage_at" integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX "usage_session_project_last_usage_idx" ON "usage_session" ("project_id","last_usage_at");`,
      )

      // Capture all metadata that is still recoverable before Session deletion
      // becomes independent from accounting retention. Already-orphaned
      // usage_record rows remain visible globally via the summary fallback.
      yield* tx.run(`
        INSERT OR IGNORE INTO usage_session (
          session_id,
          project_id,
          directory,
          title,
          project_name,
          session_created_at,
          session_updated_at,
          last_usage_at
        )
        SELECT
          s.id,
          s.project_id,
          s.directory,
          s.title,
          p.name,
          s.time_created,
          s.time_updated,
          MAX(r.completed_at)
        FROM usage_record r
        JOIN session s ON s.id = r.session_id
        LEFT JOIN project p ON p.id = s.project_id
        GROUP BY
          s.id,
          s.project_id,
          s.directory,
          s.title,
          p.name,
          s.time_created,
          s.time_updated;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
