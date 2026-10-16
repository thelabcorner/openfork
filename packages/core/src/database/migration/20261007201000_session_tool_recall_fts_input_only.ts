import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const reconcile = (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) =>
  Effect.gen(function* () {
    const columns = (
      yield* tx.all<{ name: string }>(
        "SELECT name FROM pragma_table_info('session_tool_recall_fts')",
      )
    ).map((column) => column.name)
    const current = columns.length === 1 && columns[0] === "search_text"

    if (!current) {
      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_recall_ai")
      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_recall_ad")
      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_recall_au")
      if (columns.length > 0) yield* tx.run("DROP TABLE session_tool_recall_fts")
    }

    yield* tx.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_tool_recall_fts USING fts5(
        search_text,
        content='session_tool_recall',
        content_rowid='id',
        tokenize='unicode61'
      );
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_recall_ai AFTER INSERT ON session_tool_recall BEGIN
        INSERT INTO session_tool_recall_fts(rowid, search_text) VALUES (new.id, new.search_text);
      END;
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_recall_ad AFTER DELETE ON session_tool_recall BEGIN
        INSERT INTO session_tool_recall_fts(session_tool_recall_fts, rowid, search_text)
        VALUES ('delete', old.id, old.search_text);
      END;
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_recall_au AFTER UPDATE OF search_text ON session_tool_recall BEGIN
        INSERT INTO session_tool_recall_fts(session_tool_recall_fts, rowid, search_text)
        VALUES ('delete', old.id, old.search_text);
        INSERT INTO session_tool_recall_fts(rowid, search_text) VALUES (new.id, new.search_text);
      END;
    `)

    if (!current) {
      yield* tx.run(
        "INSERT INTO session_tool_recall_fts(session_tool_recall_fts) VALUES ('rebuild')",
      )
    }
  })

export default {
  id: "20261007201000_session_tool_recall_fts_input_only",
  up: reconcile,
  reconcile,
} satisfies DatabaseMigration.Migration
