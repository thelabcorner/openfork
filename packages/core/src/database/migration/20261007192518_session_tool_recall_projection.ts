import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const reconcile = (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) =>
  Effect.gen(function* () {
    // Drizzle cannot express FTS5 virtual tables/triggers. Keep these in
    // reconcile so both upgraded and fresh-schema databases receive them.
    const columns = (
      yield* tx.all<{ name: string }>(
        "SELECT name FROM pragma_table_info('session_tool_recall_fts')",
      )
    ).map((column) => column.name)
    const inputOnly = columns.length === 1 && columns[0] === "search_text"
    // A later migration intentionally narrows the FTS payload to search_text
    // only. Once that successor shape exists, do not recreate the legacy
    // two-column table/triggers on every open; its reconcile owns FTS from
    // that point forward.
    if (!inputOnly) {
      const current = columns.length === 2 && columns[0] === "tool" && columns[1] === "search_text"
      if (columns.length > 0 && !current) {
        yield* tx.run("DROP TRIGGER IF EXISTS session_tool_recall_ai")
        yield* tx.run("DROP TRIGGER IF EXISTS session_tool_recall_ad")
        yield* tx.run("DROP TRIGGER IF EXISTS session_tool_recall_au")
        yield* tx.run("DROP TABLE session_tool_recall_fts")
      }
      yield* tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_tool_recall_fts USING fts5(
          tool,
          search_text,
          content='session_tool_recall',
          content_rowid='id',
          tokenize='unicode61'
        );
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_tool_recall_ai AFTER INSERT ON session_tool_recall BEGIN
          INSERT INTO session_tool_recall_fts(rowid, tool, search_text) VALUES (new.id, new.tool, new.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_tool_recall_ad AFTER DELETE ON session_tool_recall BEGIN
          INSERT INTO session_tool_recall_fts(session_tool_recall_fts, rowid, tool, search_text)
          VALUES ('delete', old.id, old.tool, old.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_tool_recall_au AFTER UPDATE OF tool, search_text ON session_tool_recall BEGIN
          INSERT INTO session_tool_recall_fts(session_tool_recall_fts, rowid, tool, search_text)
          VALUES ('delete', old.id, old.tool, old.search_text);
          INSERT INTO session_tool_recall_fts(rowid, tool, search_text) VALUES (new.id, new.tool, new.search_text);
        END;
      `)
      if (!current) {
        yield* tx.run(
          "INSERT INTO session_tool_recall_fts(session_tool_recall_fts) VALUES ('rebuild')",
        )
      }
    }
    // The sidecar intentionally has only a Session FK because its parent can be
    // either a V1 part or a V2 message. Parent-delete triggers keep exact recall
    // synchronized with revert/removal without adding reader-side cleanup work.
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_recall_part_ad AFTER DELETE ON part BEGIN
        DELETE FROM session_tool_recall WHERE source = 'v1_part' AND part_id = old.id;
      END;
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_recall_message_ad AFTER DELETE ON session_message BEGIN
        DELETE FROM session_tool_recall WHERE source = 'v2_message' AND message_id = old.id;
      END;
    `)
    yield* tx.run(`
      INSERT OR IGNORE INTO session_tool_recall_backfill(source, watermark_rowid, done)
      VALUES ('v1_part', -1, 0), ('v2_message', -1, 0);
    `)
  })

export default {
  id: "20261007192518_session_tool_recall_projection",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tool_recall_backfill\` (
          \`source\` text PRIMARY KEY,
          \`watermark_rowid\` integer DEFAULT -1 NOT NULL,
          \`done\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_tool_recall\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`source\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`part_id\` text NOT NULL,
          \`tool\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`search_text\` text NOT NULL,
          CONSTRAINT \`fk_session_tool_recall_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_tool_recall_identity_idx\` ON \`session_tool_recall\` (\`source\`,\`message_id\`,\`part_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_tool_recall_tool_time_idx\` ON \`session_tool_recall\` (\`tool\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_tool_recall_session_idx\` ON \`session_tool_recall\` (\`session_id\`);`)
      yield* reconcile(tx)
    })
  },
  reconcile,
} satisfies DatabaseMigration.Migration
