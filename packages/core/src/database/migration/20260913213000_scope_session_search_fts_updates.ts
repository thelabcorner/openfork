import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * The original external-content FTS triggers ran after every UPDATE of their
 * source row. Session projection updates the large JSON payload frequently for
 * timing, snapshots and tool state while searchable text stays unchanged; the
 * old triggers still deleted and reinserted the identical FTS row each time.
 *
 * Scope the update triggers to the only column the FTS tables consume. Existing
 * databases need this replacement migration; fresh databases get the same
 * definitions from the edited original reconcile migrations.
 */
export default {
  id: "20260913213000_scope_session_search_fts_updates",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("DROP TRIGGER IF EXISTS `session_message_fts_au`;")
      yield* tx.run(`
        CREATE TRIGGER \`session_message_fts_au\` AFTER UPDATE OF \`search_text\` ON \`session_message\` BEGIN
          INSERT INTO \`session_message_fts\`(\`session_message_fts\`, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
          INSERT INTO \`session_message_fts\`(rowid, search_text) VALUES (new.rowid, new.search_text);
        END;
      `)

      yield* tx.run("DROP TRIGGER IF EXISTS `part_fts_au`;")
      yield* tx.run(`
        CREATE TRIGGER \`part_fts_au\` AFTER UPDATE OF \`search_text\` ON \`part\` BEGIN
          INSERT INTO \`part_fts\`(\`part_fts\`, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
          INSERT INTO \`part_fts\`(rowid, search_text) VALUES (new.rowid, new.search_text);
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
