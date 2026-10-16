import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Adds read-path indexes even for a database where the earlier settlement-table
 * migration already ran before Usage workload profiling was enabled.
 */
export default {
  id: "20261011125810_native_tool_settlement_completed_indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("CREATE INDEX IF NOT EXISTS native_tool_settlement_completed_idx ON native_tool_settlement(completed_at);")
      yield* tx.run("CREATE INDEX IF NOT EXISTS native_tool_settlement_provider_model_completed_idx ON native_tool_settlement(provider_id, model_id, completed_at);")
    })
  },
} satisfies DatabaseMigration.Migration
