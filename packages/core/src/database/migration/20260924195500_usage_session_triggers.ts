import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

/**
 * Keeps the Usage-owned Session dimension synchronized at the SQLite boundary.
 *
 * These triggers deliberately make accounting retention independent of every
 * application delete path. A Session rename/project move is reflected while the
 * Session is live, and the final current metadata is materialized before DELETE.
 * The usage_record ledger itself has no Session FK and therefore survives.
 */
const triggers: ReadonlyArray<{ readonly name: string; readonly sql: string }> = [
  {
    name: "usage_session_after_usage_insert",
    sql: `CREATE TRIGGER usage_session_after_usage_insert
AFTER INSERT ON usage_record
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM session WHERE id = NEW.session_id)
BEGIN
  INSERT INTO usage_session (
    session_id, project_id, directory, title, project_name,
    session_created_at, session_updated_at, last_usage_at
  )
  SELECT
    s.id, s.project_id, s.directory, s.title, p.name,
    s.time_created, s.time_updated, NEW.completed_at
  FROM session s
  LEFT JOIN project p ON p.id = s.project_id
  WHERE s.id = NEW.session_id
  ON CONFLICT(session_id) DO UPDATE SET
    project_id = excluded.project_id,
    directory = excluded.directory,
    title = excluded.title,
    project_name = excluded.project_name,
    session_created_at = excluded.session_created_at,
    session_updated_at = excluded.session_updated_at,
    last_usage_at = excluded.last_usage_at
  WHERE usage_session.last_usage_at <= excluded.last_usage_at;
END`,
  },
  {
    name: "usage_session_after_session_update",
    sql: `CREATE TRIGGER usage_session_after_session_update
AFTER UPDATE OF project_id, directory, title, time_updated ON session
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM usage_record WHERE session_id = NEW.id)
BEGIN
  INSERT INTO usage_session (
    session_id, project_id, directory, title, project_name,
    session_created_at, session_updated_at, last_usage_at
  ) VALUES (
    NEW.id, NEW.project_id, NEW.directory, NEW.title,
    (SELECT name FROM project WHERE id = NEW.project_id),
    NEW.time_created, NEW.time_updated,
    (SELECT MAX(completed_at) FROM usage_record WHERE session_id = NEW.id)
  )
  ON CONFLICT(session_id) DO UPDATE SET
    project_id = excluded.project_id,
    directory = excluded.directory,
    title = excluded.title,
    project_name = excluded.project_name,
    session_created_at = excluded.session_created_at,
    session_updated_at = excluded.session_updated_at,
    last_usage_at = excluded.last_usage_at;
END`,
  },
  {
    name: "usage_session_before_session_delete",
    sql: `CREATE TRIGGER usage_session_before_session_delete
BEFORE DELETE ON session
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM usage_record WHERE session_id = OLD.id)
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
    OLD.time_created, OLD.time_updated,
    (SELECT MAX(completed_at) FROM usage_record WHERE session_id = OLD.id)
  )
  ON CONFLICT(session_id) DO UPDATE SET
    project_id = excluded.project_id,
    directory = excluded.directory,
    title = excluded.title,
    project_name = excluded.project_name,
    session_created_at = excluded.session_created_at,
    session_updated_at = excluded.session_updated_at,
    last_usage_at = excluded.last_usage_at;
END`,
  },
  {
    name: "usage_session_after_project_name_update",
    sql: `CREATE TRIGGER usage_session_after_project_name_update
AFTER UPDATE OF name ON project
FOR EACH ROW
BEGIN
  UPDATE usage_session
  SET project_name = NEW.name
  WHERE project_id = NEW.id;
END`,
  },
]

const reconcile = (tx: Transaction) =>
  Effect.gen(function* () {
    const existing = yield* tx.all<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'usage_session_%'",
    )
    const stored = new Map(existing.map((row) => [row.name, row.sql]))
    for (const trigger of triggers) {
      if (stored.get(trigger.name) === trigger.sql) continue
      yield* tx.run(`DROP TRIGGER IF EXISTS ${trigger.name}`)
      yield* tx.run(trigger.sql)
    }
  })

export default {
  id: "20260924195500_usage_session_triggers",
  up(tx) {
    return reconcile(tx)
  },
  reconcile,
} satisfies DatabaseMigration.Migration
