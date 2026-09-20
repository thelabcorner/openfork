import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

const createSupplements = (tx: Transaction) =>
  Effect.gen(function* () {
    const ftsExists =
      (
        yield* tx.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='session_checkpoint_search_fts'",
        )
      ).length > 0

    yield* tx.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS session_checkpoint_search_fts USING fts5(paths, content='session_checkpoint_search', content_rowid='rowid', tokenize='trigram');",
    )
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS session_checkpoint_search_fts_ai AFTER INSERT ON session_checkpoint_search BEGIN INSERT INTO session_checkpoint_search_fts(rowid, paths) VALUES (new.rowid, new.paths); END;",
    )
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS session_checkpoint_search_fts_ad AFTER DELETE ON session_checkpoint_search BEGIN INSERT INTO session_checkpoint_search_fts(session_checkpoint_search_fts, rowid, paths) VALUES ('delete', old.rowid, old.paths); END;",
    )
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS session_checkpoint_search_fts_au AFTER UPDATE OF paths ON session_checkpoint_search BEGIN INSERT INTO session_checkpoint_search_fts(session_checkpoint_search_fts, rowid, paths) VALUES ('delete', old.rowid, old.paths); INSERT INTO session_checkpoint_search_fts(rowid, paths) VALUES (new.rowid, new.paths); END;",
    )
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS session_checkpoint_search_ai AFTER INSERT ON session_checkpoint BEGIN INSERT INTO session_checkpoint_search (checkpoint_id, paths) VALUES (new.id, COALESCE((SELECT group_concat(replace(json_extract(j.value, '$.path'), char(92), '/'), char(10)) FROM json_each(COALESCE(new.diff, '[]')) AS j WHERE json_type(j.value, '$.path') = 'text'), '')) ON CONFLICT(checkpoint_id) DO UPDATE SET paths=excluded.paths; END;",
    )
    yield* tx.run(
      "CREATE TRIGGER IF NOT EXISTS session_checkpoint_search_au AFTER UPDATE OF diff ON session_checkpoint BEGIN INSERT INTO session_checkpoint_search (checkpoint_id, paths) VALUES (new.id, COALESCE((SELECT group_concat(replace(json_extract(j.value, '$.path'), char(92), '/'), char(10)) FROM json_each(COALESCE(new.diff, '[]')) AS j WHERE json_type(j.value, '$.path') = 'text'), '')) ON CONFLICT(checkpoint_id) DO UPDATE SET paths=excluded.paths; END;",
    )

    if (!ftsExists) {
      yield* tx.run(
        "INSERT INTO session_checkpoint_search_fts(session_checkpoint_search_fts) VALUES ('rebuild');",
      )
    }
  })

export default {
  id: "20260919011000_checkpoint_read_projection",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        "CREATE INDEX IF NOT EXISTS session_checkpoint_epoch_created_idx ON session_checkpoint (epoch, created_at);",
      )
      yield* tx.run(
        "CREATE TABLE IF NOT EXISTS session_checkpoint_search (checkpoint_id text PRIMARY KEY NOT NULL REFERENCES session_checkpoint(id) ON DELETE CASCADE, paths text DEFAULT '' NOT NULL);",
      )
      // Bulk-project historical rows before FTS is created. This avoids one
      // virtual-table trigger write per historical path and keeps migration
      // cost proportional to checkpoint rows rather than cached patch bytes.
      yield* tx.run(
        "INSERT OR REPLACE INTO session_checkpoint_search (checkpoint_id, paths) SELECT cp.id, COALESCE((SELECT group_concat(replace(json_extract(j.value, '$.path'), char(92), '/'), char(10)) FROM json_each(COALESCE(cp.diff, '[]')) AS j WHERE json_type(j.value, '$.path') = 'text'), '') FROM session_checkpoint AS cp;",
      )
      yield* createSupplements(tx)
    })
  },
  // FTS5 virtual tables/triggers are invisible to drizzle-kit, so fresh
  // databases and repaired installs recreate them here.
  reconcile(tx) {
    return createSupplements(tx)
  },
} satisfies DatabaseMigration.Migration
