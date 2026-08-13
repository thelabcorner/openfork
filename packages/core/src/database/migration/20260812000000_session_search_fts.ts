import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Adds the session_message_fts FTS5 full-text index over session message
// content. search_text is populated app-level at the projector write boundary
// (see SessionProjector) and by the resumable SessionSearch.backfill pass for
// pre-existing rows; the FTS triggers keep the virtual table in sync on every
// write thereafter. This migration is DDL only — backfilling thousands of
// rows must not run inside the migration's single transaction, so it is a
// chunked, resumable runtime pass instead.
export default {
  id: "20260812000000_session_search_fts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_message\` ADD COLUMN \`search_text\` text NOT NULL DEFAULT '';`)
      yield* tx.run(`CREATE INDEX \`session_directory_idx\` ON \`session\` (\`directory\`);`)
      yield* tx.run(`
        CREATE VIRTUAL TABLE \`session_message_fts\` USING fts5(
          search_text,
          content='session_message',
          content_rowid='rowid',
          tokenize='unicode61'
        );
      `)
      yield* tx.run(`
        CREATE TRIGGER \`session_message_fts_ai\` AFTER INSERT ON \`session_message\` BEGIN
          INSERT INTO \`session_message_fts\`(rowid, search_text) VALUES (new.rowid, new.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER \`session_message_fts_ad\` AFTER DELETE ON \`session_message\` BEGIN
          INSERT INTO \`session_message_fts\`(\`session_message_fts\`, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER \`session_message_fts_au\` AFTER UPDATE ON \`session_message\` BEGIN
          INSERT INTO \`session_message_fts\`(\`session_message_fts\`, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
          INSERT INTO \`session_message_fts\`(rowid, search_text) VALUES (new.rowid, new.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TABLE \`search_backfill\` (
          \`id\` integer PRIMARY KEY,
          \`watermark_rowid\` integer NOT NULL DEFAULT -1,
          \`done\` integer NOT NULL DEFAULT 0
        );
      `)
      yield* tx.run(`INSERT INTO \`search_backfill\` (\`id\`, \`watermark_rowid\`, \`done\`) VALUES (1, -1, 0);`)
    })
  },
} satisfies DatabaseMigration.Migration
