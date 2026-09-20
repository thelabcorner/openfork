import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

function explicitNotNull(tx: Transaction, table: string, column: string) {
  return tx.get<{ is_not_null: number }>(
    `SELECT "notnull" AS is_not_null FROM pragma_table_info('${table}') WHERE name = '${column}'`,
  )
}

function rejectNullPrimaryKeys(tx: Transaction, table: string, column: string) {
  return Effect.gen(function* () {
    const row = yield* tx.get<{ count: number }>(`SELECT count(*) AS count FROM "${table}" WHERE "${column}" IS NULL`)
    if ((row?.count ?? 0) > 0) {
      return yield* Effect.die(
        new Error(
          `Cannot restore ${table}.${column} NOT NULL primary-key invariant: found ${row!.count} row(s) with NULL keys`,
        ),
      )
    }
  })
}

/**
 * Repair databases created by the generated fresh schema while it omitted the
 * explicit NOT NULL carried by the historical migrations for TEXT primary keys.
 *
 * SQLite permits NULL in a rowid-table TEXT PRIMARY KEY unless NOT NULL is
 * explicit, so this is a real invariant difference rather than cosmetic DDL.
 * New fresh installs are already correct; upgraded installs that replayed the
 * historical migrations are already correct. Only the divergent fresh-install
 * cohort takes the rebuild branches below.
 */
export default {
  id: "20260920040500_text_primary_key_not_null_convergence",
  up(tx) {
    return Effect.gen(function* () {
      const checkpointSearch = yield* explicitNotNull(tx, "session_checkpoint_search", "checkpoint_id")
      if (checkpointSearch?.is_not_null === 0) {
        yield* rejectNullPrimaryKeys(tx, "session_checkpoint_search", "checkpoint_id")

        // These three triggers belong to the content table and are dropped with
        // it. The two projection triggers live on session_checkpoint, but drop
        // them too so ALTER TABLE never has to reparse a trigger body while the
        // referenced content table is temporarily absent.
        yield* tx.run(`DROP TRIGGER IF EXISTS session_checkpoint_search_fts_ai`)
        yield* tx.run(`DROP TRIGGER IF EXISTS session_checkpoint_search_fts_ad`)
        yield* tx.run(`DROP TRIGGER IF EXISTS session_checkpoint_search_fts_au`)
        yield* tx.run(`DROP TRIGGER IF EXISTS session_checkpoint_search_ai`)
        yield* tx.run(`DROP TRIGGER IF EXISTS session_checkpoint_search_au`)

        const ftsExists = yield* tx.get<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_checkpoint_search_fts'`,
        )
        yield* tx.run(`
          CREATE TABLE __new_session_checkpoint_search (
            checkpoint_id text PRIMARY KEY NOT NULL,
            paths text DEFAULT '' NOT NULL,
            CONSTRAINT fk_session_checkpoint_search_checkpoint_id_session_checkpoint_id_fk
              FOREIGN KEY (checkpoint_id) REFERENCES session_checkpoint(id) ON DELETE CASCADE
          )
        `)
        // Preserve rowid because the external-content FTS table keys its index
        // by session_checkpoint_search.rowid rather than checkpoint_id.
        yield* tx.run(`
          INSERT INTO __new_session_checkpoint_search (rowid, checkpoint_id, paths)
          SELECT rowid, checkpoint_id, paths FROM session_checkpoint_search
        `)
        yield* tx.run(`DROP TABLE session_checkpoint_search`)
        yield* tx.run(`ALTER TABLE __new_session_checkpoint_search RENAME TO session_checkpoint_search`)

        yield* tx.run(
          `CREATE VIRTUAL TABLE IF NOT EXISTS session_checkpoint_search_fts USING fts5(paths, content='session_checkpoint_search', content_rowid='rowid', tokenize='trigram')`,
        )
        yield* tx.run(
          `CREATE TRIGGER session_checkpoint_search_fts_ai AFTER INSERT ON session_checkpoint_search BEGIN INSERT INTO session_checkpoint_search_fts(rowid, paths) VALUES (new.rowid, new.paths); END`,
        )
        yield* tx.run(
          `CREATE TRIGGER session_checkpoint_search_fts_ad AFTER DELETE ON session_checkpoint_search BEGIN INSERT INTO session_checkpoint_search_fts(session_checkpoint_search_fts, rowid, paths) VALUES ('delete', old.rowid, old.paths); END`,
        )
        yield* tx.run(
          `CREATE TRIGGER session_checkpoint_search_fts_au AFTER UPDATE OF paths ON session_checkpoint_search BEGIN INSERT INTO session_checkpoint_search_fts(session_checkpoint_search_fts, rowid, paths) VALUES ('delete', old.rowid, old.paths); INSERT INTO session_checkpoint_search_fts(rowid, paths) VALUES (new.rowid, new.paths); END`,
        )
        yield* tx.run(
          `CREATE TRIGGER session_checkpoint_search_ai AFTER INSERT ON session_checkpoint BEGIN INSERT INTO session_checkpoint_search (checkpoint_id, paths) VALUES (new.id, COALESCE((SELECT group_concat(replace(json_extract(j.value, '$.path'), char(92), '/'), char(10)) FROM json_each(COALESCE(new.diff, '[]')) AS j WHERE json_type(j.value, '$.path') = 'text'), '')) ON CONFLICT(checkpoint_id) DO UPDATE SET paths=excluded.paths; END`,
        )
        yield* tx.run(
          `CREATE TRIGGER session_checkpoint_search_au AFTER UPDATE OF diff ON session_checkpoint BEGIN INSERT INTO session_checkpoint_search (checkpoint_id, paths) VALUES (new.id, COALESCE((SELECT group_concat(replace(json_extract(j.value, '$.path'), char(92), '/'), char(10)) FROM json_each(COALESCE(new.diff, '[]')) AS j WHERE json_type(j.value, '$.path') = 'text'), '')) ON CONFLICT(checkpoint_id) DO UPDATE SET paths=excluded.paths; END`,
        )
        if (!ftsExists) {
          yield* tx.run(`INSERT INTO session_checkpoint_search_fts(session_checkpoint_search_fts) VALUES ('rebuild')`)
        }
      }

      const contextOps = yield* explicitNotNull(tx, "session_context_ops", "id")
      if (contextOps?.is_not_null === 0) {
        yield* rejectNullPrimaryKeys(tx, "session_context_ops", "id")
        yield* tx.run(`
          CREATE TABLE __new_session_context_ops (
            id text PRIMARY KEY NOT NULL,
            session_id text NOT NULL,
            batch_id text NOT NULL,
            operations text NOT NULL,
            timestamp integer NOT NULL,
            CONSTRAINT fk_session_context_ops_session_id_session_id_fk
              FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
          )
        `)
        yield* tx.run(`
          INSERT INTO __new_session_context_ops (id, session_id, batch_id, operations, timestamp)
          SELECT id, session_id, batch_id, operations, timestamp FROM session_context_ops
        `)
        yield* tx.run(`DROP TABLE session_context_ops`)
        yield* tx.run(`ALTER TABLE __new_session_context_ops RENAME TO session_context_ops`)
        yield* tx.run(`CREATE INDEX session_context_ops_session_idx ON session_context_ops (session_id)`)
        yield* tx.run(`CREATE INDEX session_context_ops_session_time_idx ON session_context_ops (session_id, timestamp)`)
      }

      const forkOrigin = yield* explicitNotNull(tx, "session_fork_origin", "session_id")
      if (forkOrigin?.is_not_null === 0) {
        yield* rejectNullPrimaryKeys(tx, "session_fork_origin", "session_id")
        yield* tx.run(`
          CREATE TABLE __new_session_fork_origin (
            session_id text PRIMARY KEY NOT NULL,
            parent_session_id text NOT NULL,
            source_message_id text,
            source_seq integer,
            edge text,
            kind text NOT NULL,
            workspace_mode text NOT NULL,
            created_at integer NOT NULL,
            CONSTRAINT fk_session_fork_origin_session_id_session_id_fk
              FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
          )
        `)
        yield* tx.run(`
          INSERT INTO __new_session_fork_origin (
            session_id, parent_session_id, source_message_id, source_seq, edge, kind, workspace_mode, created_at
          )
          SELECT session_id, parent_session_id, source_message_id, source_seq, edge, kind, workspace_mode, created_at
          FROM session_fork_origin
        `)
        yield* tx.run(`DROP TABLE session_fork_origin`)
        yield* tx.run(`ALTER TABLE __new_session_fork_origin RENAME TO session_fork_origin`)
        yield* tx.run(`CREATE INDEX session_fork_origin_parent_idx ON session_fork_origin (parent_session_id)`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
