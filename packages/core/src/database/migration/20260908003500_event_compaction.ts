import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const create = (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) =>
  tx.run(`CREATE TABLE IF NOT EXISTS event_compaction (
    aggregate_id TEXT PRIMARY KEY,
    bitmap BLOB NOT NULL,
    compacted_count INTEGER NOT NULL DEFAULT 0,
    time_updated INTEGER NOT NULL,
    FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
  ) WITHOUT ROWID`)

export default {
  id: "20260908003500_event_compaction",
  up(tx) {
    return Effect.asVoid(create(tx))
  },
  // Fresh databases are built from schema.gen and journal migration IDs without
  // running up(). Reconcile therefore owns this internal storage supplement too.
  reconcile(tx) {
    return Effect.asVoid(create(tx))
  },
} satisfies DatabaseMigration.Migration
