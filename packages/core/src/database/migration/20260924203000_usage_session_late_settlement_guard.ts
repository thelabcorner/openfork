import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

/**
 * Closes the late-first-settlement gap without changing completed migration
 * history. A deleted Session leaves a tiny attribution tombstone even when no
 * usage_record exists yet; if the first settlement arrives afterward, the
 * tombstone's accounting watermark advances while its preserved metadata stays
 * authoritative.
 *
 * last_usage_at=0 is an internal pending-settlement sentinel. The row is not
 * visible to Usage summaries until a usage_record exists, and every real
 * settlement timestamp advances it monotonically.
 */
const triggers: ReadonlyArray<{ readonly name: string; readonly sql: string }> = [
  {
    name: "usage_session_before_session_delete_pending",
    sql: `CREATE TRIGGER usage_session_before_session_delete_pending
BEFORE DELETE ON session
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM usage_record WHERE session_id = OLD.id)
BEGIN
  INSERT INTO usage_session (
    session_id, project_id, directory, title, project_name,
    session_created_at, session_updated_at, last_usage_at
  ) VALUES (
    OLD.id, OLD.project_id, OLD.directory, OLD.title,
    COALESCE(
      (SELECT name FROM project WHERE id = OLD.project_id),
      (SELECT project_name FROM usage_session WHERE session_id = OLD.id)
    ),
    OLD.time_created, OLD.time_updated, 0
  )
  ON CONFLICT(session_id) DO UPDATE SET
    project_id = excluded.project_id,
    directory = excluded.directory,
    title = excluded.title,
    project_name = excluded.project_name,
    session_created_at = excluded.session_created_at,
    session_updated_at = excluded.session_updated_at;
END`,
  },
  {
    name: "usage_session_after_usage_insert_pending",
    sql: `CREATE TRIGGER usage_session_after_usage_insert_pending
AFTER INSERT ON usage_record
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM session WHERE id = NEW.session_id)
BEGIN
  UPDATE usage_session
  SET last_usage_at = CASE
    WHEN last_usage_at < NEW.completed_at THEN NEW.completed_at
    ELSE last_usage_at
  END
  WHERE session_id = NEW.session_id;
END`,
  },
]

const reconcile = (tx: Transaction) =>
  Effect.gen(function* () {
    const existing = yield* tx.all<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('usage_session_before_session_delete_pending', 'usage_session_after_usage_insert_pending')",
    )
    const stored = new Map(existing.map((row) => [row.name, row.sql]))
    for (const trigger of triggers) {
      if (stored.get(trigger.name) === trigger.sql) continue
      yield* tx.run(`DROP TRIGGER IF EXISTS ${trigger.name}`)
      yield* tx.run(trigger.sql)
    }
  })

export default {
  id: "20260924203000_usage_session_late_settlement_guard",
  up(tx) {
    return reconcile(tx)
  },
  reconcile,
} satisfies DatabaseMigration.Migration
