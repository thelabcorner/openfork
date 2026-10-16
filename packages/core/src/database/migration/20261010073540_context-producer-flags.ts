import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010073540_context-producer-flags",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`message\` ADD \`context_summary\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`message\` ADD \`context_opaque\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_compaction\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`part\` ADD \`context_opaque\` integer DEFAULT false NOT NULL;`)
      // Migrate pre-existing V1/OPCL history once. The old expression indexes
      // remain available until backfill completes, so common non-summary/
      // non-opaque rows are not needlessly rewritten into the WAL.
      yield* tx.run(`UPDATE message SET context_summary = 1
        WHERE json_extract(data, '$.summary') = 1;`)
      yield* tx.run(`UPDATE message SET context_opaque = 1
        WHERE json_type(data, '$."$cdbRef"') IS NOT NULL;`)
      yield* tx.run(`UPDATE part SET context_compaction = 1
        WHERE json_extract(data, '$.type') = 'compaction';`)
      yield* tx.run(`UPDATE part SET context_opaque = 1
        WHERE json_type(data, '$."$cdbRef"') IS NOT NULL;`)

      // Drizzle's incremental generator ignores changed partial-index WHERE
      // clauses when the index name is unchanged. Explicitly replace the old
      // JSON-expression indexes with producer-owned boolean predicates.
      yield* tx.run(`DROP INDEX IF EXISTS message_session_summary_probe_idx;`)
      yield* tx.run(`DROP INDEX IF EXISTS message_session_opaque_probe_idx;`)
      yield* tx.run(`DROP INDEX IF EXISTS part_session_opaque_context_probe_idx;`)
      yield* tx.run(`CREATE INDEX message_session_summary_probe_idx
        ON message (session_id) WHERE context_summary = 1;`)
      yield* tx.run(`CREATE INDEX message_session_opaque_probe_idx
        ON message (session_id) WHERE context_opaque = 1;`)
      yield* tx.run(`CREATE INDEX part_session_opaque_context_probe_idx
        ON part (session_id) WHERE context_opaque = 1;`)
    })
  },
} satisfies DatabaseMigration.Migration
