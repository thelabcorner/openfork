import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Adds the part_fts FTS5 full-text index over V1 part content. V1 message
// content lives in the `part` table's data JSON (text/reasoning parts carry
// $.text, tool parts carry $.state.input), so search_text is populated
// app-level at the projector write boundary (see SessionProjector) and by the
// resumable SessionSearch.backfillParts pass for pre-existing rows; the FTS
// triggers keep the virtual table in sync on every write thereafter. This
// migration is DDL only — backfilling hundreds of thousands of rows must not
// run inside the migration's single transaction, so it is a chunked,
// resumable runtime pass instead.
export default {
  id: "20260812000001_session_search_v1_fts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`part\` ADD COLUMN \`search_text\` text NOT NULL DEFAULT '';`)
      yield* tx.run(`
        CREATE VIRTUAL TABLE \`part_fts\` USING fts5(
          search_text,
          content='part',
          content_rowid='rowid',
          tokenize='unicode61'
        );
      `)
      yield* tx.run(`
        CREATE TRIGGER \`part_fts_ai\` AFTER INSERT ON \`part\` BEGIN
          INSERT INTO \`part_fts\`(rowid, search_text) VALUES (new.rowid, new.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER \`part_fts_ad\` AFTER DELETE ON \`part\` BEGIN
          INSERT INTO \`part_fts\`(\`part_fts\`, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER \`part_fts_au\` AFTER UPDATE ON \`part\` BEGIN
          INSERT INTO \`part_fts\`(\`part_fts\`, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
          INSERT INTO \`part_fts\`(rowid, search_text) VALUES (new.rowid, new.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TABLE \`part_search_backfill\` (
          \`id\` integer PRIMARY KEY,
          \`watermark_rowid\` integer NOT NULL DEFAULT -1,
          \`done\` integer NOT NULL DEFAULT 0
        );
      `)
      yield* tx.run(`INSERT INTO \`part_search_backfill\` (\`id\`, \`watermark_rowid\`, \`done\`) VALUES (1, -1, 0);`)
    })
  },
  // See the session_message_fts migration: drizzle-kit cannot express the FTS
  // objects, so reconcile creates them on fresh databases and repairs
  // databases whose journal already claims this migration.
  reconcile(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS \`part_fts\` USING fts5(
          search_text,
          content='part',
          content_rowid='rowid',
          tokenize='unicode61'
        );
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`part_fts_ai\` AFTER INSERT ON \`part\` BEGIN
          INSERT INTO \`part_fts\`(rowid, search_text) VALUES (new.rowid, new.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`part_fts_ad\` AFTER DELETE ON \`part\` BEGIN
          INSERT INTO \`part_fts\`(\`part_fts\`, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`part_fts_au\` AFTER UPDATE ON \`part\` BEGIN
          INSERT INTO \`part_fts\`(\`part_fts\`, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
          INSERT INTO \`part_fts\`(rowid, search_text) VALUES (new.rowid, new.search_text);
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
